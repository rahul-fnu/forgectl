#!/usr/bin/env node
import {
  Logger,
  emitRunEvent,
  executeRun,
  formatDuration,
  getClaudeAuth,
  getWorkflow,
  isDaemonRunning,
  listWorkflows,
  readPid,
  resolveRunPlan,
  setClaudeApiKey
} from "./chunk-OJKWABHL.js";
import {
  loadConfig
} from "./chunk-DMQRMT43.js";
import {
  deleteCredential,
  getCodexAuth,
  listCredentials,
  setCodexApiKey
} from "./chunk-OH6J5HYU.js";

// src/index.ts
import { Command } from "commander";
import { spawn } from "child_process";

// src/cli/run.ts
import chalk from "chalk";

// src/orchestration/preflight.ts
import Docker from "dockerode";
import { existsSync } from "fs";
import { execSync } from "child_process";
async function runPreflightChecks(plan, logger) {
  const errors = [];
  const warnings = [];
  logger.debug("preflight", "Checking Docker...");
  try {
    const docker = new Docker();
    await docker.ping();
  } catch {
    errors.push("Docker is not running. Start Docker Desktop or the Docker daemon.");
  }
  logger.debug("preflight", "Checking credentials...");
  if (plan.agent.type === "claude-code") {
    const auth2 = await getClaudeAuth();
    if (!auth2) {
      errors.push("No Claude Code credentials found. Run: forgectl auth add claude-code");
    }
  } else if (plan.agent.type === "codex") {
    const auth2 = await getCodexAuth();
    if (!auth2) {
      errors.push("No Codex credentials found. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    }
  }
  logger.debug("preflight", "Checking inputs...");
  for (const source of plan.input.sources) {
    if (!existsSync(source)) {
      errors.push(`Input not found: ${source}`);
    }
  }
  if (plan.output.mode === "git") {
    const repoPath = plan.input.sources[0];
    if (repoPath && existsSync(repoPath)) {
      try {
        execSync("git rev-parse --is-inside-work-tree", { cwd: repoPath, stdio: "ignore" });
      } catch {
        errors.push(`Git output mode requires a git repository. ${repoPath} is not a git repo.`);
      }
      try {
        const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });
        if (status.trim()) {
          warnings.push("Working directory has uncommitted changes. Consider committing first.");
        }
      } catch {
      }
    }
  }
  for (const file of plan.context.files) {
    if (!existsSync(file)) {
      warnings.push(`Context file not found (will be skipped): ${file}`);
    }
  }
  return {
    passed: errors.length === 0,
    errors,
    warnings
  };
}

// src/logging/run-log.ts
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
function saveRunLog(log, logDir) {
  const dir = resolve(logDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${log.runId}.json`);
  writeFileSync(filePath, JSON.stringify(log, null, 2));
  return filePath;
}

// src/cli/run.ts
async function runCommand(options) {
  const config = loadConfig(options.config);
  const plan = resolveRunPlan(config, options);
  if (options.dryRun) {
    printDryRun(plan);
    return;
  }
  const logger = new Logger(options.verbose);
  console.log();
  console.log(chalk.bold(`\u{1F528} forgectl run`));
  console.log(chalk.gray(`  Run ID:   ${plan.runId}`));
  console.log(chalk.gray(`  Workflow: ${plan.workflow.name}`));
  console.log(chalk.gray(`  Agent:    ${plan.agent.type}`));
  console.log(chalk.gray(`  Image:    ${plan.container.image}`));
  if (plan.orchestration.mode === "review") {
    console.log(chalk.gray(`  Mode:     review (max ${plan.orchestration.review.maxRounds} rounds)`));
  }
  console.log();
  const preflight = await runPreflightChecks(plan, logger);
  for (const w of preflight.warnings) {
    logger.warn("preflight", w);
  }
  if (!preflight.passed) {
    for (const e of preflight.errors) {
      logger.error("preflight", e);
    }
    console.log(chalk.red("\nPre-flight checks failed. Aborting.\n"));
    process.exit(1);
  }
  emitRunEvent({ runId: plan.runId, type: "started", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { task: plan.task } });
  const noCleanup = options.noCleanup === true;
  const result = await executeRun(plan, logger, noCleanup);
  console.log();
  if (result.success) {
    console.log(chalk.green.bold("\u2714 Run completed successfully"));
  } else {
    console.log(chalk.red.bold("\u2717 Run failed"));
    if (result.error) {
      console.log(chalk.red(`  ${result.error}`));
    }
  }
  console.log(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));
  if (result.validation.stepResults.length > 0) {
    console.log(chalk.gray(`  Validation: ${result.validation.totalAttempts} round(s)`));
    for (const step of result.validation.stepResults) {
      const icon = step.passed ? chalk.green("\u2714") : chalk.red("\u2717");
      console.log(chalk.gray(`    ${icon} ${step.name} (${step.attempts} attempt(s))`));
    }
  }
  if (result.review) {
    if (result.review.approved) {
      console.log(chalk.gray(`  Review: ${result.review.totalRounds} round(s), approved on round ${result.review.approvedOnRound}`));
    } else {
      console.log(chalk.gray(`  Review: ${result.review.totalRounds} round(s), not approved`));
    }
  }
  if (result.output) {
    if (result.output.mode === "git") {
      console.log(chalk.cyan(`
  Branch: ${result.output.branch}`));
      console.log(chalk.gray(`  ${result.output.filesChanged} files changed, +${result.output.insertions} -${result.output.deletions}`));
      console.log(chalk.gray(`
  To review: git diff main...${result.output.branch}`));
      console.log(chalk.gray(`  To merge:  git merge ${result.output.branch}`));
    } else {
      console.log(chalk.cyan(`
  Output: ${result.output.dir}`));
      console.log(chalk.gray(`  ${result.output.files.length} files (${formatBytes(result.output.totalSize)})`));
      for (const f of result.output.files.slice(0, 10)) {
        console.log(chalk.gray(`    ${f}`));
      }
      if (result.output.files.length > 10) {
        console.log(chalk.gray(`    ... and ${result.output.files.length - 10} more`));
      }
    }
  }
  console.log();
  const runLog = {
    runId: plan.runId,
    task: plan.task,
    workflow: plan.workflow.name,
    agent: plan.agent.type,
    status: result.success ? "success" : "failed",
    startedAt: new Date(Date.now() - result.durationMs).toISOString(),
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    durationMs: result.durationMs,
    validation: {
      attempts: result.validation.totalAttempts,
      steps: result.validation.stepResults
    },
    output: result.output ? result.output.mode === "git" ? { mode: "git", branch: result.output.branch } : { mode: "files", dir: result.output.dir, files: result.output.files } : { mode: plan.output.mode },
    entries: logger.getEntries()
  };
  const logPath = saveRunLog(runLog, config.output.log_dir);
  console.log(chalk.gray(`Run log: ${logPath}
`));
  if (!result.success) process.exit(1);
}
function printDryRun(plan) {
  console.log(chalk.bold("\n\u{1F4CB} Run Plan (dry run)\n"));
  console.log(`  Run ID:     ${plan.runId}`);
  console.log(`  Task:       ${plan.task}`);
  console.log(`  Workflow:   ${plan.workflow.name}`);
  console.log(`  Agent:      ${plan.agent.type}${plan.agent.model ? ` (${plan.agent.model})` : ""}`);
  console.log(`  Image:      ${plan.container.image}`);
  console.log(`  Network:    ${plan.container.network.mode}`);
  console.log(`  Input:      ${plan.input.mode} \u2192 ${plan.input.mountPath}`);
  console.log(`  Output:     ${plan.output.mode}${plan.output.mode === "git" ? "" : ` \u2192 ${plan.output.hostDir}`}`);
  console.log(`  Validation: ${plan.validation.steps.length} steps`);
  for (const step of plan.validation.steps) {
    console.log(`    - ${step.name}: \`${step.command}\` (${step.retries} retries)`);
  }
  console.log(`  Review:     ${plan.orchestration.review.enabled ? `enabled (max ${plan.orchestration.review.maxRounds} rounds)` : "disabled"}`);
  console.log(`  Timeout:    ${plan.agent.timeout}ms`);
  console.log();
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// src/cli/auth.ts
import chalk2 from "chalk";
import { createInterface } from "readline";
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve2) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve2(answer.trim());
    });
  });
}
async function authCommand(action, provider) {
  if (action === "list") {
    const creds = await listCredentials();
    if (creds.length === 0) {
      console.log(chalk2.yellow("No credentials configured. Run `forgectl auth add <provider>`."));
      return;
    }
    console.log(chalk2.bold("\nConfigured credentials:\n"));
    for (const { provider: p, key } of creds) {
      console.log(`  ${chalk2.green("\u2714")} ${p} (${key})`);
    }
    console.log();
    return;
  }
  if (action === "add") {
    if (provider === "claude-code") {
      const existing = await getClaudeAuth();
      if (existing?.type === "oauth_session") {
        console.log(chalk2.green("\u2714 Found existing Claude Code OAuth session at ~/.claude/"));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your Anthropic API key: ");
      if (!key.startsWith("sk-ant-")) {
        console.log(chalk2.yellow("Warning: Key doesn't look like an Anthropic API key (expected sk-ant-...)"));
      }
      await setClaudeApiKey(key);
      console.log(chalk2.green("\u2714 Claude Code API key saved."));
    } else if (provider === "codex") {
      const { getCodexAuth: getCodexAuth2 } = await import("./codex-QJ4JILSY.js");
      const existing = await getCodexAuth2();
      if (existing?.type === "oauth_session") {
        console.log(chalk2.green("\u2714 Found existing Codex OAuth session at ~/.codex/"));
        console.log(chalk2.gray("  (from 'codex login'). This will be used automatically."));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your OpenAI API key: ");
      await setCodexApiKey(key);
      console.log(chalk2.green("\u2714 Codex (OpenAI) API key saved."));
    } else {
      console.error(chalk2.red(`Unknown provider: ${provider}. Use: claude-code | codex`));
      process.exit(1);
    }
    return;
  }
  if (action === "remove") {
    if (!provider) {
      console.error("Provider required.");
      process.exit(1);
    }
    await deleteCredential(provider, "api_key");
    console.log(chalk2.green(`\u2714 Removed credentials for ${provider}.`));
    return;
  }
}

// src/cli/init.ts
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
import chalk3 from "chalk";
var STARTER_CONFIGS = {
  node: `# forgectl config \u2014 Node.js project
agent:
  type: claude-code

container:
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: npm run lint
      retries: 3
    - name: test
      command: npm test
      retries: 3
    - name: build
      command: npm run build
      retries: 1
`,
  python: `# forgectl config \u2014 Python project
agent:
  type: claude-code

container:
  image: forgectl/code-python312
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: ruff check .
      retries: 3
    - name: typecheck
      command: mypy .
      retries: 2
    - name: test
      command: pytest
      retries: 3
`,
  go: `# forgectl config \u2014 Go project
agent:
  type: claude-code

container:
  image: forgectl/code-go122
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: golangci-lint run
      retries: 3
    - name: test
      command: go test ./...
      retries: 3
    - name: build
      command: go build ./...
      retries: 1
`,
  research: `# forgectl config \u2014 Research workflow
agent:
  type: claude-code

orchestration:
  mode: review

output:
  dir: ./research-output
`,
  data: `# forgectl config \u2014 Data workflow
agent:
  type: claude-code

output:
  dir: ./data-output
`,
  ops: `# forgectl config \u2014 Ops/Infrastructure workflow
agent:
  type: claude-code

validation:
  steps:
    - name: shellcheck
      command: find . -name '*.sh' -exec shellcheck {} +
      retries: 2
    - name: terraform-validate
      command: terraform validate
      retries: 2
`
};
async function initCommand(options) {
  const configDir = join2(process.cwd(), ".forgectl");
  const configPath = join2(configDir, "config.yaml");
  if (existsSync2(configPath)) {
    console.log(chalk3.yellow(`Config already exists at ${configPath}`));
    return;
  }
  mkdirSync2(configDir, { recursive: true });
  const stack = options.stack || "node";
  const content = STARTER_CONFIGS[stack] || STARTER_CONFIGS.node;
  writeFileSync2(configPath, content);
  console.log(chalk3.green(`\u2714 Created ${configPath} (stack: ${stack})`));
  console.log(`
Next steps:`);
  console.log(`  1. Edit .forgectl/config.yaml to match your project`);
  console.log(`  2. Run: forgectl auth add claude-code`);
  console.log(`  3. Run: forgectl run --task "your task" --dry-run`);
}

// src/cli/workflows.ts
import chalk4 from "chalk";
import yaml from "js-yaml";
function workflowsCommand(action, name) {
  if (action === "list") {
    const workflows2 = listWorkflows();
    console.log(chalk4.bold("\nAvailable workflows:\n"));
    for (const w of workflows2) {
      console.log(`  ${chalk4.cyan(w.name.padEnd(12))} ${w.description}`);
    }
    console.log(`
Use ${chalk4.cyan("forgectl workflows show <name>")} to see full definition.
`);
    return;
  }
  if (action === "show" && name) {
    const workflow = getWorkflow(name);
    console.log(chalk4.bold(`
Workflow: ${workflow.name}
`));
    console.log(yaml.dump(workflow, { lineWidth: 120, noRefs: true }));
    return;
  }
}

// src/index.ts
var program = new Command();
program.name("forgectl").description("Run AI agents in isolated Docker containers for any workflow").version("0.1.0");
program.command("run").description("Run a task synchronously").requiredOption("-t, --task <string>", "Task prompt").option("-w, --workflow <string>", "Workflow type").option("-r, --repo <path>", "Repository path").option("-i, --input <paths...>", "Input files/directories").option("--context <paths...>", "Context files for agent prompt").option("-a, --agent <string>", "Agent type: claude-code | codex").option("-m, --model <string>", "Model override").option("-c, --config <path>", "Config file path").option("--review", "Enable review mode").option("--no-review", "Disable review mode").option("-o, --output-dir <path>", "Output directory for file mode").option("--timeout <duration>", "Timeout override (e.g. 30m)").option("--verbose", "Show full agent output").option("--no-cleanup", "Leave container running after run").option("--dry-run", "Show run plan without executing").action(runCommand);
var auth = program.command("auth").description("Manage BYOK credentials");
auth.command("add <provider>").description("Add credentials (claude-code | codex)").action(async (provider) => {
  await authCommand("add", provider);
});
auth.command("list").description("List configured credentials").action(async () => {
  await authCommand("list");
});
auth.command("remove <provider>").description("Remove credentials").action(async (provider) => {
  await authCommand("remove", provider);
});
program.command("init").description("Generate starter config").option("--stack <string>", "Stack template: node|python|go|research|data|ops").action(initCommand);
var workflows = program.command("workflows").description("Manage workflows");
workflows.command("list").description("List available workflows").action(() => {
  workflowsCommand("list");
});
workflows.command("show <name>").description("Show workflow definition").action((name) => {
  workflowsCommand("show", name);
});
program.command("up").description("Start the forgectl daemon").option("-p, --port <number>", "Port to listen on", "4856").option("--foreground", "Run in foreground (don't detach)").action(async (opts) => {
  const port = parseInt(opts.port, 10);
  if (isDaemonRunning()) {
    const pid = readPid();
    console.log(`forgectl daemon is already running (PID ${pid})`);
    return;
  }
  if (opts.foreground) {
    const { startDaemon } = await import("./server-VJEB5URL.js");
    await startDaemon(port);
  } else {
    const child = spawn(process.execPath, [process.argv[1], "up", "--foreground", "--port", String(port)], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 500));
    if (isDaemonRunning()) {
      console.log(`forgectl daemon started on http://127.0.0.1:${port}`);
    } else {
      console.error("Failed to start daemon. Run with --foreground to see errors.");
      process.exit(1);
    }
  }
});
program.command("down").description("Stop the forgectl daemon").action(() => {
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
program.command("status").description("Show daemon status and recent runs").action(async () => {
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
      const runs = await res.json();
      if (runs.length === 0) {
        console.log("No runs queued.");
      } else {
        console.log(`
Runs (${runs.length}):`);
        for (const run of runs.slice(-10)) {
          console.log(`  ${run.id}  ${run.status.padEnd(10)}  ${run.task?.slice(0, 50) || ""}`);
        }
      }
    }
  } catch {
    console.log("(Could not fetch run status from daemon)");
  }
});
program.command("submit").description("Submit a task to the running daemon").requiredOption("-t, --task <string>", "Task prompt").option("-w, --workflow <string>", "Workflow type").option("-i, --input <paths...>", "Input files/directories").option("-a, --agent <string>", "Agent type: claude-code | codex").action(async (opts) => {
  if (!isDaemonRunning()) {
    console.error("Daemon is not running. Start it with: forgectl up");
    process.exit(1);
  }
  try {
    const res = await fetch("http://127.0.0.1:4856/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: opts.task, workflow: opts.workflow, input: opts.input, agent: opts.agent })
    });
    const data = await res.json();
    console.log(`Submitted run: ${data.id} (${data.status})`);
    console.log(`Stream logs: forgectl logs ${data.id} --follow`);
  } catch (err) {
    console.error(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});
program.command("logs <runId>").description("Show logs for a run").option("--follow", "Stream events as they arrive (SSE)").action(async (runId, opts) => {
  if (opts.follow) {
    if (!isDaemonRunning()) {
      console.error("Daemon is not running.");
      process.exit(1);
    }
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
    try {
      const res = await fetch(`http://127.0.0.1:4856/runs/${runId}`);
      if (!res.ok) {
        const { readFileSync, existsSync: existsSync3 } = await import("fs");
        const { loadConfig: loadConfig2 } = await import("./loader-SHPNPOKX.js");
        const config = loadConfig2();
        const logPath = `${config.output.log_dir}/${runId}.json`;
        if (existsSync3(logPath)) {
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
program.parse();
//# sourceMappingURL=index.js.map