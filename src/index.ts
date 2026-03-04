import { Command } from "commander";
import { spawn } from "node:child_process";
import { runCommand } from "./cli/run.js";
import { authCommand } from "./cli/auth.js";
import { initCommand } from "./cli/init.js";
import { workflowsCommand } from "./cli/workflows.js";
import {
  pipelineShowCommand,
  pipelineRunCommand,
  pipelineStatusCommand,
  pipelineRerunCommand,
  pipelineRevertCommand,
} from "./cli/pipeline.js";
import { isDaemonRunning, readPid } from "./daemon/lifecycle.js";

const program = new Command();

program
  .name("forgectl")
  .description("Run AI agents in isolated Docker containers for any workflow")
  .version("0.1.0");

// forgectl run
program
  .command("run")
  .description("Run a task synchronously")
  .requiredOption("-t, --task <string>", "Task prompt")
  .option("-w, --workflow <string>", "Workflow type")
  .option("-r, --repo <path>", "Repository path")
  .option("-i, --input <paths...>", "Input files/directories")
  .option("--context <paths...>", "Context files for agent prompt")
  .option("-a, --agent <string>", "Agent type: claude-code | codex")
  .option("-m, --model <string>", "Model override")
  .option("-c, --config <path>", "Config file path")
  .option("--review", "Enable review mode")
  .option("--no-review", "Disable review mode")
  .option("-o, --output-dir <path>", "Output directory for file mode")
  .option("--timeout <duration>", "Timeout override (e.g. 30m)")
  .option("--verbose", "Show full agent output")
  .option("--no-cleanup", "Leave container running after run")
  .option("--dry-run", "Show run plan without executing")
  .action(runCommand);

// forgectl auth
const auth = program
  .command("auth")
  .description("Manage BYOK credentials");

auth
  .command("add <provider>")
  .description("Add credentials (claude-code | codex)")
  .action(async (provider: string) => { await authCommand("add", provider); });

auth
  .command("list")
  .description("List configured credentials")
  .action(async () => { await authCommand("list"); });

auth
  .command("remove <provider>")
  .description("Remove credentials")
  .action(async (provider: string) => { await authCommand("remove", provider); });

// forgectl init
program
  .command("init")
  .description("Generate starter config")
  .option("--stack <string>", "Stack template: node|python|go|research|data|ops")
  .action(initCommand);

// forgectl workflows
const workflows = program
  .command("workflows")
  .description("Manage workflows");

workflows
  .command("list")
  .description("List available workflows")
  .action(() => { workflowsCommand("list"); });

workflows
  .command("show <name>")
  .description("Show workflow definition")
  .action((name: string) => { workflowsCommand("show", name); });

// forgectl up — start the daemon
program
  .command("up")
  .description("Start the forgectl daemon")
  .option("-p, --port <number>", "Port to listen on", "4856")
  .option("--foreground", "Run in foreground (don't detach)")
  .action(async (opts: { port: string; foreground?: boolean }) => {
    const port = parseInt(opts.port, 10);

    if (isDaemonRunning()) {
      const pid = readPid();
      console.log(`forgectl daemon is already running (PID ${pid})`);
      return;
    }

    if (opts.foreground) {
      const { startDaemon } = await import("./daemon/server.js");
      await startDaemon(port);
    } else {
      // Spawn detached background process
      const child = spawn(process.execPath, [process.argv[1], "up", "--foreground", "--port", String(port)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      // Give it a moment to start
      await new Promise(r => setTimeout(r, 500));
      if (isDaemonRunning()) {
        console.log(`forgectl daemon started on http://127.0.0.1:${port}`);
      } else {
        console.error("Failed to start daemon. Run with --foreground to see errors.");
        process.exit(1);
      }
    }
  });

// forgectl down — stop the daemon
program
  .command("down")
  .description("Stop the forgectl daemon")
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log("No daemon running.");
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped daemon (PID ${pid})`);
    } catch {
      console.error(`Failed to stop daemon (PID ${pid})`);
      process.exit(1);
    }
  });

// forgectl status — show daemon and run status
program
  .command("status")
  .description("Show daemon status and recent runs")
  .action(async () => {
    const pid = readPid();
    if (!pid) {
      console.log("Daemon: not running");
      console.log("Start with: forgectl up");
      return;
    }
    console.log(`Daemon: running (PID ${pid})`);

    // Fetch runs from daemon
    try {
      const res = await fetch("http://127.0.0.1:4856/runs");
      if (res.ok) {
        const runs = await res.json() as Array<{ id: string; status: string; task?: string; submittedAt: string }>;
        if (runs.length === 0) {
          console.log("No runs queued.");
        } else {
          console.log(`\nRuns (${runs.length}):`);
          for (const run of runs.slice(-10)) {
            console.log(`  ${run.id}  ${run.status.padEnd(10)}  ${run.task?.slice(0, 50) || ""}`);
          }
        }
      }
    } catch {
      console.log("(Could not fetch run status from daemon)");
    }
  });

// forgectl submit — submit a run to the daemon
program
  .command("submit")
  .description("Submit a task to the running daemon")
  .requiredOption("-t, --task <string>", "Task prompt")
  .option("-w, --workflow <string>", "Workflow type")
  .option("-i, --input <paths...>", "Input files/directories")
  .option("-a, --agent <string>", "Agent type: claude-code | codex")
  .action(async (opts: { task: string; workflow?: string; input?: string[]; agent?: string }) => {
    if (!isDaemonRunning()) {
      console.error("Daemon is not running. Start it with: forgectl up");
      process.exit(1);
    }

    try {
      const res = await fetch("http://127.0.0.1:4856/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: opts.task, workflow: opts.workflow, input: opts.input, agent: opts.agent }),
      });
      const data = await res.json() as { id: string; status: string };
      console.log(`Submitted run: ${data.id} (${data.status})`);
      console.log(`Stream logs: forgectl logs ${data.id} --follow`);
    } catch (err) {
      console.error(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// forgectl logs — show or stream logs for a run
program
  .command("logs <runId>")
  .description("Show logs for a run")
  .option("--follow", "Stream events as they arrive (SSE)")
  .action(async (runId: string, opts: { follow?: boolean }) => {
    if (opts.follow) {
      if (!isDaemonRunning()) {
        console.error("Daemon is not running.");
        process.exit(1);
      }
      // Stream SSE events
      const url = `http://127.0.0.1:4856/runs/${runId}/events`;
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) {
          console.error(`Run not found: ${runId}`);
          process.exit(1);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stdout.write(decoder.decode(value));
        }
      } catch (err) {
        console.error(`Failed to stream logs: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      // Show run status
      try {
        const res = await fetch(`http://127.0.0.1:4856/runs/${runId}`);
        if (!res.ok) {
          // Try reading from local log file
          const { readFileSync, existsSync } = await import("node:fs");
          const { loadConfig } = await import("./config/loader.js");
          const config = loadConfig();
          const logPath = `${config.output.log_dir}/${runId}.json`;
          if (existsSync(logPath)) {
            const log = JSON.parse(readFileSync(logPath, "utf-8"));
            console.log(JSON.stringify(log, null, 2));
          } else {
            console.error(`Run not found: ${runId}`);
            process.exit(1);
          }
        } else {
          const run = await res.json();
          console.log(JSON.stringify(run, null, 2));
        }
      } catch {
        console.error(`Failed to fetch logs for: ${runId}`);
        process.exit(1);
      }
    }
  });

// forgectl pipeline
const pipelineCmd = program
  .command("pipeline")
  .description("DAG pipeline orchestration");

pipelineCmd
  .command("show")
  .description("Display the pipeline DAG")
  .requiredOption("-f, --file <path>", "Pipeline YAML file")
  .action(pipelineShowCommand);

pipelineCmd
  .command("run")
  .description("Execute a pipeline")
  .requiredOption("-f, --file <path>", "Pipeline YAML file")
  .option("-r, --repo <path>", "Repository path override")
  .option("--dry-run", "Show execution plan without running")
  .option("--verbose", "Show detailed output")
  .option("--max-parallel <n>", "Max parallel nodes")
  .option("--from <node>", "Resume from this node")
  .action(pipelineRunCommand);

pipelineCmd
  .command("status")
  .description("Show pipeline status")
  .requiredOption("-f, --file <path>", "Pipeline YAML file")
  .action(pipelineStatusCommand);

pipelineCmd
  .command("rerun")
  .description("Re-run pipeline from a specific node")
  .requiredOption("-f, --file <path>", "Pipeline YAML file")
  .requiredOption("--from <node>", "Node to start from")
  .option("-r, --repo <path>", "Repository path override")
  .option("--verbose", "Show detailed output")
  .action(pipelineRerunCommand);

pipelineCmd
  .command("revert")
  .description("Revert to a checkpoint")
  .requiredOption("-f, --file <path>", "Pipeline YAML file")
  .requiredOption("--to <node>", "Node to revert to")
  .option("--pipeline-run <id>", "Pipeline run ID")
  .action(pipelineRevertCommand);

program.parse();
