import chalk from "chalk";
import { readDaemonToken } from "../daemon/lifecycle.js";
import { isDaemonRunning } from "../daemon/lifecycle.js";
import type { RunEvent } from "../logging/events.js";

const DEFAULT_PORT = 4856;

function getDaemonUrl(): string {
  const port = process.env.FORGECTL_DAEMON_PORT || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function getDaemonHeaders(): Record<string, string> {
  const token = readDaemonToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export function formatSSEEvent(event: RunEvent): string {
  const ts = new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false });
  const d = event.data || {};

  switch (event.type) {
    case "started":
      return `${chalk.gray(ts)} ${chalk.green("▶ Run started")}`;

    case "completed":
      return `${chalk.gray(ts)} ${chalk.green("✔ Run completed")}`;

    case "failed":
      return `${chalk.gray(ts)} ${chalk.red("✘ Run failed")}${d.error ? `: ${d.error}` : ""}`;

    case "phase":
      return `${chalk.gray(ts)} ${chalk.cyan(`⟫ Phase: ${d.phase || "unknown"}`)}`;

    case "prompt":
      return `${chalk.gray(ts)} ${chalk.blue("→ Prompt sent")}${d.length ? ` (${Number(d.length).toLocaleString("en-US")} chars)` : ""}`;

    case "agent_response": {
      const status = d.status || "received";
      const text = d.stderr
        ? chalk.red(`← Agent stderr: ${d.stderr}`)
        : d.stdout
          ? chalk.white(`← Agent stdout: ${String(d.stdout).trimEnd()}`)
          : chalk.white(`← Agent response: ${status}`);
      return `${chalk.gray(ts)} ${text}`;
    }

    case "validation_step": {
      const name = d.name || "check";
      const passed = d.passed;
      const icon = passed ? chalk.green("✔") : chalk.red("✘");
      const label = passed
        ? chalk.green(`${name}: passed`)
        : chalk.red(`${name}: failed${d.error ? ` — ${d.error}` : ""}`);
      return `${chalk.gray(ts)} ${icon} ${label}`;
    }

    case "validation": {
      const allPassed = d.passed;
      return `${chalk.gray(ts)} ${allPassed ? chalk.green("✔ Validation passed") : chalk.red("✘ Validation failed")}`;
    }

    case "retry":
      return `${chalk.gray(ts)} ${chalk.yellow(`↻ Retry attempt ${d.attempt || "?"}${d.reason ? `: ${d.reason}` : ""}`)}`;

    case "output":
      return `${chalk.gray(ts)} ${chalk.magenta(`⇥ Output collected (${d.mode || "unknown"}${d.branch ? `: ${d.branch}` : ""})`)}`;

    case "agent_output": {
      const streamName = d.stream === "stderr" ? chalk.red("stderr") : chalk.white("stdout");
      const text = String(d.chunk ?? "").trimEnd();
      if (!text) return "";
      const role = d.role ? chalk.gray(` [${d.role}]`) : "";
      return `${chalk.gray(ts)} ${streamName}${role} ${text}`;
    }

    case "agent_started":
      return `${chalk.gray(ts)} ${chalk.green(`▶ Agent started`)}${d.agent ? ` (${d.agent})` : ""}`;

    case "agent_retry":
      return `${chalk.gray(ts)} ${chalk.yellow(`↻ Agent retry`)}${d.attempt ? ` #${d.attempt}` : ""}`;

    case "validation_step_started":
      return `${chalk.gray(ts)} ${chalk.cyan(`⟫ Validation step: ${d.name || "check"}`)}`;

    case "validation_step_completed": {
      const icon = d.passed ? chalk.green("✔") : chalk.red("✘");
      const label = d.passed
        ? chalk.green(`${d.name || "check"}: passed`)
        : chalk.red(`${d.name || "check"}: failed${d.error ? ` — ${d.error}` : ""}`);
      return `${chalk.gray(ts)} ${icon} ${label}`;
    }

    case "cost": {
      const total = typeof d.total === "number" ? d.total : 0;
      return `${chalk.gray(ts)} ${chalk.gray(`$ ${total.toLocaleString("en-US")} tokens`)}`;
    }

    case "snapshot":
      return `${chalk.gray(ts)} ${chalk.gray(`📷 Snapshot: ${d.stepName || "captured"}`)}`;

    default:
      return `${chalk.gray(ts)} ${chalk.gray(`[${event.type}]`)} ${JSON.stringify(d) !== "{}" ? JSON.stringify(d) : ""}`;
  }
}

export function parseSSEData(chunk: string): RunEvent[] {
  const events: RunEvent[] = [];
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // skip malformed events
      }
    }
  }
  return events;
}

export async function logsFollowCommand(runId: string): Promise<void> {
  if (!isDaemonRunning()) {
    console.error(chalk.red("Daemon is not running."));
    process.exit(1);
  }

  const token = readDaemonToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
  const url = `${getDaemonUrl()}/api/v1/runs/${runId}/stream${tokenParam}`;
  try {
    const res = await fetch(url, { headers: getDaemonHeaders() });
    if (!res.ok || !res.body) {
      console.error(chalk.red(`Run not found or not accessible: ${runId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`Streaming logs for run ${runId}...\n`));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (terminated by double newline)
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const events = parseSSEData(part + "\n");
        for (const event of events) {
          console.log(formatSSEEvent(event));
          if (event.type === "completed" || event.type === "failed") {
            return;
          }
        }
      }
    }
  } catch (err) {
    console.error(chalk.red(`Failed to stream logs: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function logsHistoricalCommand(runId: string): Promise<void> {
  // Try daemon first
  if (isDaemonRunning()) {
    try {
      const res = await fetch(`${getDaemonUrl()}/runs/${runId}`, { headers: getDaemonHeaders() });
      if (res.ok) {
        const run = await res.json();
        console.log(JSON.stringify(run, null, 2));
        return;
      }
    } catch {
      // fall through to local log
    }
  }

  // Fall back to local log file
  const { readFileSync, existsSync } = await import("node:fs");
  const { loadConfig } = await import("../config/loader.js");
  const config = loadConfig();
  const logPath = `${config.output.log_dir}/${runId}.json`;
  if (existsSync(logPath)) {
    const log = JSON.parse(readFileSync(logPath, "utf-8"));
    console.log(JSON.stringify(log, null, 2));
  } else {
    console.error(chalk.red(`Run not found: ${runId}`));
    process.exit(1);
  }
}

export async function logsCommand(runId: string, opts: { follow?: boolean }): Promise<void> {
  if (opts.follow) {
    await logsFollowCommand(runId);
  } else {
    await logsHistoricalCommand(runId);
  }
}
