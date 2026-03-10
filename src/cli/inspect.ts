import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createRunRepository } from "../storage/repositories/runs.js";
import { createEventRepository } from "../storage/repositories/events.js";
import { createSnapshotRepository } from "../storage/repositories/snapshots.js";
import type { EventRow } from "../storage/repositories/events.js";
import type { RunRow } from "../storage/repositories/runs.js";

/**
 * Format a relative timestamp as MM:SS from the start time.
 */
function formatRelativeTime(eventTime: string, startTime: string): string {
  const diffMs = new Date(eventTime).getTime() - new Date(startTime).getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Extract a human-readable description from an event based on its type and data.
 */
function describeEvent(type: string, data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;

  switch (type) {
    case "started":
      return "Run started";
    case "completed":
      return "Run completed";
    case "failed":
      return d.error ? `Run failed: ${d.error}` : "Run failed";
    case "phase":
      return d.phase ? `Phase: ${d.phase}` : "Phase change";
    case "prompt":
      return d.length ? `Prompt sent (${Number(d.length).toLocaleString("en-US")} chars)` : "Prompt sent";
    case "agent_response":
      return d.status ? `Agent response: ${d.status}` : "Agent response received";
    case "validation_step": {
      const name = d.name ?? "unknown";
      const passed = d.passed ? "passed" : "failed";
      const err = !d.passed && d.error ? ` - ${d.error}` : "";
      return `${name}: ${passed}${err}`;
    }
    case "retry":
      return d.attempt ? `Retry attempt ${d.attempt}${d.reason ? `: ${d.reason}` : ""}` : "Retry";
    case "cost": {
      const total = typeof d.total === "number" ? d.total : 0;
      return `Token usage: ${total.toLocaleString("en-US")} tokens`;
    }
    case "snapshot":
      return d.stepName ? `Snapshot: ${d.stepName}` : "Snapshot captured";
    case "output":
      return d.mode ? `Output collected (${d.mode}${d.branch ? `: ${d.branch}` : ""})` : "Output collected";
    default:
      return JSON.stringify(data) !== "{}" ? JSON.stringify(data) : type;
  }
}

/**
 * Format a duration between two ISO timestamps as a human-readable string.
 */
function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "N/A";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Format the header block for a run.
 */
export function formatInspectHeader(run: RunRow): string {
  const lines: string[] = [];
  lines.push(`Run: ${run.id}`);
  lines.push(`Task: ${run.task}`);
  lines.push(`Workflow: ${run.workflow ?? "N/A"}`);
  lines.push(`Status: ${run.status}`);
  lines.push(`Duration: ${formatDuration(run.startedAt, run.completedAt)}`);
  return lines.join("\n");
}

/**
 * Format a chronological timeline of events.
 */
export function formatTimeline(events: EventRow[], startTime: string): string {
  if (events.length === 0) {
    return "No events recorded";
  }

  const lines: string[] = [];
  for (const event of events) {
    const relTime = formatRelativeTime(event.timestamp, startTime);
    const typeStr = `[${event.type}]`.padEnd(20);
    const desc = describeEvent(event.type, event.data);
    lines.push(`  ${relTime}  ${typeStr} ${desc}`);
  }
  return lines.join("\n");
}

/**
 * CLI handler: inspect a run's audit trail.
 */
export async function inspectCommand(runId: string): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);

    const runRepo = createRunRepository(db);
    const eventRepo = createEventRepository(db);
    const _snapshotRepo = createSnapshotRepository(db);

    const run = runRepo.findById(runId);
    if (!run) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }

    // Print header
    console.log(chalk.bold("\n" + formatInspectHeader(run)));

    // Print timeline
    const events = eventRepo.findByRunId(runId);
    console.log(chalk.bold("\nTimeline:"));
    console.log(formatTimeline(events, run.startedAt ?? run.submittedAt));

    // Cost summary
    const costEvents = eventRepo.findByRunIdAndType(runId, "cost");
    if (costEvents.length > 0) {
      let totalInput = 0;
      let totalOutput = 0;
      for (const ce of costEvents) {
        const d = (ce.data && typeof ce.data === "object" ? ce.data : {}) as Record<string, number>;
        totalInput += d.input ?? 0;
        totalOutput += d.output ?? 0;
      }
      const total = totalInput + totalOutput;
      // Rough cost estimate: $3/MTok input, $15/MTok output (Claude Sonnet-like pricing)
      const inputCost = (totalInput / 1_000_000) * 3;
      const outputCost = (totalOutput / 1_000_000) * 15;
      const totalCost = inputCost + outputCost;

      console.log(chalk.bold("\nCost Summary:"));
      console.log(`  Input:  ${totalInput.toLocaleString("en-US")} tokens (~$${inputCost.toFixed(4)})`);
      console.log(`  Output: ${totalOutput.toLocaleString("en-US")} tokens (~$${outputCost.toFixed(4)})`);
      console.log(`  Total:  ${total.toLocaleString("en-US")} tokens (~$${totalCost.toFixed(4)})`);
    }

    console.log("");
  } finally {
    closeDatabase(db);
  }
}
