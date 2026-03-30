import { Command } from "commander";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { runCommand, runSummaryCommand } from "./cli/run.js";
import { authCommand } from "./cli/auth.js";
import { initCommand } from "./cli/init.js";
import { workflowsCommand } from "./cli/workflows.js";
import { inspectCommand, summaryCommand } from "./cli/inspect.js";
import { registerDoctorCommand } from "./cli/doctor.js";
import { cacheListCommand, cacheClearCommand, cachePrebuildCommand } from "./cli/cache.js";
import { imagesBuildCommand, imagesListCommand } from "./cli/images.js";
import { isDaemonRunning, readPid } from "./daemon/lifecycle.js";
import { isMergeDaemonRunning, readMergeDaemonPid } from "./merge-daemon/lifecycle.js";
import { logsCommand } from "./cli/logs.js";
import { repoListCommand, repoAddCommand, repoShowCommand } from "./cli/repo.js";
import { discordCommand } from "./cli/discord.js";

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
  .action((rawOpts: Record<string, unknown>) => {
    return runCommand(rawOpts as any);
  });

// forgectl run summary <run-id>
program
  .command("run-summary")
  .description("Show AI-generated summary of a completed run")
  .argument("<run-id>", "Run ID to summarize")
  .action(async (runId: string) => {
    await runSummaryCommand(runId);
  });

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

// forgectl inspect
program
  .command("inspect <runId>")
  .description("Show the full audit trail for a run")
  .action(inspectCommand);

// forgectl summary
program
  .command("summary <runId>")
  .description("Show the structured summary for a run")
  .action(summaryCommand);

// forgectl orchestrate — start daemon with orchestration enabled
program
  .command("orchestrate")
  .description("Start daemon with orchestration enabled")
  .option("-p, --port <port>", "daemon port", "4856")
  .option("--foreground", "Run in foreground (don't detach)")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts: { port: string; foreground?: boolean; config?: string }) => {
    const port = parseInt(opts.port, 10);
    const configPath = opts.config ? resolve(opts.config) : undefined;

    if (isDaemonRunning()) {
      const pid = readPid();
      console.log(`forgectl daemon is already running (PID ${pid})`);
      return;
    }

    if (opts.foreground) {
      const { startDaemon } = await import("./daemon/server.js");
      await startDaemon(port, true, configPath);
    } else {
      const extraArgs = opts.config ? ["--config", resolve(opts.config)] : [];
      const child = spawn(process.execPath, [process.argv[1], "orchestrate", "--foreground", "--port", String(port), ...extraArgs], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      await new Promise(r => setTimeout(r, 500));
      if (isDaemonRunning()) {
        console.log(`forgectl orchestrator started on http://127.0.0.1:${port}`);
      } else {
        console.error("Failed to start orchestrator. Run with --foreground to see errors.");
        process.exit(1);
      }
    }
  });

// forgectl up — start the daemon
program
  .command("up")
  .description("Start the forgectl daemon")
  .option("-p, --port <number>", "Port to listen on", "4856")
  .option("--foreground", "Run in foreground (don't detach)")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts: { port: string; foreground?: boolean; config?: string }) => {
    const port = parseInt(opts.port, 10);
    const configPath = opts.config ? resolve(opts.config) : undefined;

    if (isDaemonRunning()) {
      const pid = readPid();
      console.log(`forgectl daemon is already running (PID ${pid})`);
      return;
    }

    if (opts.foreground) {
      const { startDaemon } = await import("./daemon/server.js");
      await startDaemon(port, false, configPath);
    } else {
      const extraArgs = opts.config ? ["--config", resolve(opts.config)] : [];
      const child = spawn(process.execPath, [process.argv[1], "up", "--foreground", "--port", String(port), ...extraArgs], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
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
  .description("Show logs for a run (use --follow for live SSE streaming)")
  .option("--follow", "Stream events as they arrive (SSE)")
  .action(logsCommand);

// forgectl merge-daemon
program
  .command("merge-daemon")
  .description("Start merge daemon (processes forge PRs sequentially: rebase, fix, review, CI, merge)")
  .option("-p, --port <port>", "daemon port", "4857")
  .option("--foreground", "Run in foreground (don't detach)")
  .option("--ci-timeout <minutes>", "CI timeout in minutes", "45")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts: { port: string; foreground?: boolean; ciTimeout: string; config?: string }) => {
    const port = parseInt(opts.port, 10);
    const ciTimeoutMs = parseInt(opts.ciTimeout, 10) * 60 * 1000;
    const configPath = opts.config ? resolve(opts.config) : undefined;

    if (isMergeDaemonRunning()) {
      const pid = readMergeDaemonPid();
      console.log(`forgectl merge-daemon is already running (PID ${pid})`);
      return;
    }

    if (opts.foreground) {
      const { startMergeDaemon } = await import("./merge-daemon/server.js");
      await startMergeDaemon(port, ciTimeoutMs, configPath);
    } else {
      const extraArgs = opts.config ? ["--config", resolve(opts.config)] : [];
      const child = spawn(process.execPath, [
        process.argv[1], "merge-daemon", "--foreground",
        "--port", String(port),
        "--ci-timeout", opts.ciTimeout,
        ...extraArgs,
      ], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      await new Promise(r => setTimeout(r, 500));
      if (isMergeDaemonRunning()) {
        console.log(`forgectl merge-daemon started on http://127.0.0.1:${port}`);
      } else {
        console.error("Failed to start merge-daemon. Run with --foreground to see errors.");
        process.exit(1);
      }
    }
  });

// forgectl doctor
registerDoctorCommand(program);

// forgectl cache
const cacheCmd = program
  .command("cache")
  .description("Manage container image cache");

cacheCmd
  .command("list")
  .description("Show cached images with workflow name, size, and age")
  .action(cacheListCommand);

cacheCmd
  .command("clear")
  .description("Prune cached images")
  .option("-w, --workflow <name>", "Only clear cache for this workflow")
  .option("--older-than <duration>", "Only clear images older than duration (e.g. 7d, 24h)")
  .option("--dangling", "Remove dangling/phantom forgectl images from failed builds")
  .action(cacheClearCommand);

cacheCmd
  .command("prebuild <workflow>")
  .description("Build and cache the image for a workflow without running anything")
  .action(cachePrebuildCommand);

// forgectl images
const imagesCmd = program
  .command("images")
  .description("Manage Docker images for workflows");

imagesCmd
  .command("build [workflow]")
  .description("Build Docker image for a workflow (default: code)")
  .option("--all", "Build all images")
  .action(imagesBuildCommand);

imagesCmd
  .command("list")
  .description("Show available images and their build status")
  .action(imagesListCommand);

// forgectl repo — manage per-repo config profiles
const repoCmd = program
  .command("repo")
  .description("Manage per-repo config profiles (~/.forgectl/repos/)");

repoCmd
  .command("list")
  .description("List configured repo profiles")
  .action(repoListCommand);

repoCmd
  .command("add <name>")
  .description("Add a repo profile (GitHub or Linear)")
  .option("--tracker-repo <owner/repo>", "GitHub repo (owner/repo)")
  .option("--linear", "Create a Linear tracker profile")
  .option("--team-id <uuid>", "Linear team ID (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--project-id <uuid>", "Linear project ID (optional)")
  .option("--webhook-secret <secret>", "Linear webhook signing secret")
  .option("--labels <labels>", "Comma-separated tracker labels")
  .option("--token <token>", "Token or env var reference (e.g. $GH_TOKEN, $gh, $linear)")
  .action(repoAddCommand);

repoCmd
  .command("show <name>")
  .description("Show merged config for a repo profile")
  .action(repoShowCommand);

// forgectl discord — start the Discord bot
program
  .command("discord")
  .description("Start the Discord bot interface for forgectl")
  .option("--token <string>", "Discord bot token (or set DISCORD_BOT_TOKEN)")
  .option("--daemon-url <url>", "Daemon URL (default: http://127.0.0.1:4856)")
  .option("-c, --config <path>", "Config file path")
  .action(discordCommand);

program.parse();
