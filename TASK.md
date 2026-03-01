# TASK: Build forgectl Phase 3 + Phase 4

## What Already Exists (DO NOT REBUILD)

Phase 1+2 is complete. The following is already working:

- **Config system** (`src/config/`): Zod schemas (`ConfigSchema`, `WorkflowSchema`, `ValidationStepSchema`), YAML loader, `deepMerge`
- **Workflow system** (`src/workflow/`): 6 built-in workflows (code, research, content, data, ops, general), registry, custom workflow loader, resolver that produces `RunPlan`
- **Auth/BYOK** (`src/auth/`): keytar + file fallback store, Claude/Codex credential management, container mount preparation
- **Container engine** (`src/container/`): builder (pull/build images), runner (`createContainer`, `execInContainer`, `destroyContainer`), workspace prep (repo mode with glob exclusions, files mode), network isolation (open/allowlist/airgapped), secrets mounting, cleanup
- **CLI skeleton** (`src/cli/`): `run` (dry-run only), `auth`, `init`, `workflows`. Stubs for `submit`, `up`, `down`, `status`, `logs`
- **Dockerfiles** (`dockerfiles/`): code-node20, research, content, data, ops + init-firewall.sh
- **Utils** (`src/utils/`): template, slug, duration, timer, hash, ports
- **Types** (`src/workflow/types.ts`): `RunPlan`, `NetworkConfig`, `ResourceConfig`, `ReviewConfig`, `CommitConfig`, etc.
- **77 unit tests passing**, 5 integration tests (Docker)

## What to Build Now

### Phase 3: Single-Agent Execution (the core loop)
1. Agent adapters (Claude Code + Codex)
2. Prompt builder (workflow-aware)
3. Context file injection
4. Validation runner (sequential steps, retry loop)
5. Validation feedback formatter (workflow-aware error messages)
6. Git output collector (branch, commit, extract to host)
7. File output collector (copy from container to host)
8. Output dispatcher
9. Pre-flight checks
10. Wire `forgectl run` end-to-end (replace the stub)
11. Terminal output (progress, phases, summary)
12. JSON run log
13. Logging infrastructure

### Phase 4: Daemon + API
14. Daemon lifecycle (PID file, start/stop)
15. Fastify REST server
16. Run queue
17. SSE event streaming
18. Wire daemon CLI commands (`up`, `down`, `status`, `submit`, `logs`)

After this task, `forgectl run --task "..." --workflow code` must work end-to-end: container starts → agent runs → validation checks → retries if needed → output collected → container destroyed.

---

## Step 1: Install New Dependencies

Add these to package.json and install:

```bash
npm install fastify @fastify/cors @fastify/static
npm install -D @types/tar
```

Note: `tar` is NOT needed. File extraction uses dockerode's `getArchive` which returns a tar stream — use the built-in `node:stream` and `node:zlib` APIs or `container.getArchive` + pipe to fs.

---

## Step 2: Logging Infrastructure (`src/logging/`)

Create a structured logging system that supports both terminal output and JSON run logs.

### `src/logging/logger.ts`

```typescript
import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private entries: LogEntry[] = [];
  private verbose: boolean;
  private listeners: Array<(entry: LogEntry) => void> = [];

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  private emit(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase,
      message,
      data,
    };
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  debug(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("debug", phase, message, data);
    if (this.verbose) console.log(chalk.gray(`  [${phase}] ${message}`));
  }

  info(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("info", phase, message, data);
    console.log(chalk.cyan(`  [${phase}]`) + ` ${message}`);
  }

  warn(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("warn", phase, message, data);
    console.log(chalk.yellow(`  ⚠ [${phase}]`) + ` ${message}`);
  }

  error(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("error", phase, message, data);
    console.error(chalk.red(`  ✗ [${phase}]`) + ` ${message}`);
  }

  /** Subscribe to log events (for SSE streaming) */
  onEntry(fn: (entry: LogEntry) => void): void {
    this.listeners.push(fn);
  }

  /** Get all entries (for JSON run log) */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }
}
```

### `src/logging/events.ts`

Event emitter for run lifecycle events (used by daemon SSE later):

```typescript
import { EventEmitter } from "node:events";

export interface RunEvent {
  runId: string;
  type: "started" | "phase" | "validation" | "retry" | "output" | "completed" | "failed";
  timestamp: string;
  data: Record<string, unknown>;
}

export const runEvents = new EventEmitter();

export function emitRunEvent(event: RunEvent): void {
  runEvents.emit("run", event);
  runEvents.emit(`run:${event.runId}`, event);
}
```

### `src/logging/run-log.ts`

Save a JSON run log after each run:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunPlan } from "../workflow/types.js";
import type { LogEntry } from "./logger.js";

export interface RunLog {
  runId: string;
  task: string;
  workflow: string;
  agent: string;
  status: "success" | "failed" | "abandoned";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  validation: {
    attempts: number;
    steps: Array<{
      name: string;
      passed: boolean;
      attempts: number;
    }>;
  };
  output: {
    mode: "git" | "files";
    branch?: string;
    dir?: string;
    files?: string[];
  };
  entries: LogEntry[];
}

export function saveRunLog(log: RunLog, logDir: string): string {
  const dir = resolve(logDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${log.runId}.json`);
  writeFileSync(filePath, JSON.stringify(log, null, 2));
  return filePath;
}
```

---

## Step 3: Agent Adapters (`src/agent/`)

### `src/agent/types.ts`

```typescript
export interface AgentAdapter {
  name: string;
  /** Build the command array to exec inside the container */
  buildCommand(prompt: string, options: AgentOptions): string[];
  /** Build environment variables needed */
  buildEnv(secretEnv: Record<string, string>): string[];
}

export interface AgentOptions {
  model: string;
  maxTurns: number;
  timeout: number;     // ms
  flags: string[];
  workingDir: string;
}
```

### `src/agent/claude-code.ts`

```typescript
import type { AgentAdapter, AgentOptions } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  buildCommand(prompt: string, options: AgentOptions): string[] {
    const cmd = [
      "claude",
      "-p", prompt,            // Print mode (non-interactive)
      "--output-format", "text",
    ];

    if (options.maxTurns > 0) {
      cmd.push("--max-turns", String(options.maxTurns));
    }

    if (options.model) {
      cmd.push("--model", options.model);
    }

    // Pass through any extra flags from config
    for (const flag of options.flags) {
      cmd.push(flag);
    }

    return cmd;
  },

  buildEnv(secretEnv: Record<string, string>): string[] {
    const env: string[] = [];
    // Read API key from mounted secret file
    if (secretEnv.ANTHROPIC_API_KEY_FILE) {
      env.push(`ANTHROPIC_API_KEY=$(cat ${secretEnv.ANTHROPIC_API_KEY_FILE})`);
    }
    // Disable telemetry in container
    env.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    return env;
  },
};
```

### `src/agent/codex.ts`

```typescript
import type { AgentAdapter, AgentOptions } from "./types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildCommand(prompt: string, options: AgentOptions): string[] {
    const cmd = [
      "codex",
      "--quiet",
      "--approval-mode", "full-auto",
      prompt,
    ];

    if (options.model) {
      cmd.push("--model", options.model);
    }

    for (const flag of options.flags) {
      cmd.push(flag);
    }

    return cmd;
  },

  buildEnv(secretEnv: Record<string, string>): string[] {
    const env: string[] = [];
    if (secretEnv.OPENAI_API_KEY_FILE) {
      env.push(`OPENAI_API_KEY=$(cat ${secretEnv.OPENAI_API_KEY_FILE})`);
    }
    return env;
  },
};
```

### `src/agent/registry.ts`

```typescript
import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";

const ADAPTERS: Record<string, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex": codexAdapter,
};

export function getAgentAdapter(name: string): AgentAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}
```

---

## Step 4: Prompt Builder (`src/context/`)

### `src/context/prompt.ts`

Build the full prompt string from a RunPlan. This is what gets passed to the agent via `claude -p "..."`.

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { RunPlan } from "../workflow/types.js";

export function buildPrompt(plan: RunPlan): string {
  const parts: string[] = [];

  // 1. Workflow system prompt
  parts.push(plan.context.system || plan.workflow.system);

  // 2. Context files (contents inlined with filename headers)
  for (const file of plan.context.files) {
    const absPath = resolve(file);
    if (existsSync(absPath)) {
      const content = readFileSync(absPath, "utf-8");
      parts.push(`\n--- Context: ${basename(file)} ---\n${content}\n`);
    }
  }

  // 3. Available tools description
  if (plan.workflow.tools.length > 0) {
    parts.push(`\nAvailable tools in this container: ${plan.workflow.tools.join(", ")}\n`);
  }

  // 4. The task
  parts.push(`\n--- Task ---\n${plan.task}\n`);

  // 5. Validation instructions (so the agent knows what will be checked)
  if (plan.validation.steps.length > 0) {
    parts.push(`\nAfter you finish, these validation checks will run:`);
    for (const step of plan.validation.steps) {
      parts.push(`- ${step.name}: \`${step.command}\` — ${step.description}`);
    }
    parts.push(`\nIf any check fails, you'll receive the error output and must fix it.\n`);
  }

  // 6. Output instructions
  if (plan.output.mode === "files") {
    parts.push(`\nSave all output files to ${plan.output.path}\n`);
  }

  return parts.join("\n");
}
```

### `src/context/inject.ts`

Copy context files into the container:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type Docker from "dockerode";
import { execInContainer } from "../container/runner.js";

/**
 * Copy context files from host into /input/context/ inside the container.
 * These supplement the input files — they're extra reference material.
 */
export async function injectContextFiles(
  container: Docker.Container,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;

  await execInContainer(container, ["mkdir", "-p", "/input/context"]);

  for (const file of files) {
    const absPath = resolve(file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath);
    const name = basename(absPath);

    // Write file content via exec (simpler than tar archive for small files)
    await execInContainer(container, [
      "sh", "-c", `cat > /input/context/${name}`,
    ]);
    // Alternative: use container.putArchive for binary files
    // For now, rely on the prompt builder to inline context
  }
}
```

---

## Step 5: Validation System (`src/validation/`)

This is the critical loop. Build it carefully.

### `src/validation/step.ts`

Execute a single validation step:

```typescript
import type Docker from "dockerode";
import { execInContainer, type ExecResult } from "../container/runner.js";
import type { ValidationStep } from "../config/schema.js";
import { parseDuration } from "../utils/duration.js";

export interface StepResult {
  step: ValidationStep;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a single validation step inside the container.
 */
export async function runValidationStep(
  container: Docker.Container,
  step: ValidationStep,
  workingDir: string
): Promise<StepResult> {
  const timeout = step.timeout ? parseDuration(step.timeout) : 60_000; // default 60s per step

  const result: ExecResult = await execInContainer(
    container,
    ["sh", "-c", step.command],
    { workingDir, timeout }
  );

  return {
    step,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
```

### `src/validation/feedback.ts`

Format validation errors for the agent, with workflow-aware instructions:

```typescript
import type { StepResult } from "./step.js";

const WORKFLOW_INSTRUCTIONS: Record<string, string> = {
  code: "Fix the code issues. Do NOT weaken linting rules or delete tests.",
  research: "Fix the report. Ensure sources are cited with URLs and claims are supported.",
  content: "Revise the content. Address the style and quality issues.",
  data: "Fix the data pipeline. Ensure output matches expected schema and no PII is present.",
  ops: "Fix the infrastructure code. Ensure it passes validation/dry-run.",
  general: "Fix the issues identified above.",
};

/**
 * Format validation failure into a clear error message for the agent.
 * Truncates long output to avoid blowing up the context window.
 */
export function formatFeedback(failedSteps: StepResult[], workflowName: string): string {
  const parts: string[] = [
    "VALIDATION FAILED. The following checks did not pass:\n",
  ];

  for (const { step, exitCode, stdout, stderr } of failedSteps) {
    parts.push(`--- ${step.name} (exit code ${exitCode}) ---`);
    parts.push(`Command: ${step.command}`);
    if (stdout.trim()) {
      parts.push(`STDOUT:\n${truncate(stdout, 3000)}`);
    }
    if (stderr.trim()) {
      parts.push(`STDERR:\n${truncate(stderr, 3000)}`);
    }
    parts.push("");
  }

  const instruction = WORKFLOW_INSTRUCTIONS[workflowName] || WORKFLOW_INSTRUCTIONS.general;
  parts.push(instruction);
  parts.push("\nFix the issues and the checks will run again.");

  return parts.join("\n");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + "\n\n... (truncated) ...\n\n" + text.slice(-half);
}
```

### `src/validation/runner.ts`

The main validation retry loop. This is the core quality gate.

```typescript
import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { AgentAdapter, AgentOptions } from "../agent/types.js";
import { runValidationStep, type StepResult } from "./step.js";
import { formatFeedback } from "./feedback.js";
import { execInContainer } from "../container/runner.js";

export interface ValidationResult {
  passed: boolean;
  totalAttempts: number;
  stepResults: Array<{
    name: string;
    passed: boolean;
    attempts: number;
  }>;
}

/**
 * Run all validation steps. If any fail, format feedback, re-invoke the agent,
 * then restart ALL validation steps from the top. Repeat up to maxRetries.
 *
 * This is the core quality loop:
 * 1. Run all steps sequentially
 * 2. Collect all failures
 * 3. If any failed: feed errors to agent → agent fixes → go to step 1
 * 4. If all pass: return success
 */
export async function runValidationLoop(
  container: Docker.Container,
  plan: RunPlan,
  adapter: AgentAdapter,
  agentEnv: string[],
  logger: Logger
): Promise<ValidationResult> {
  const steps = plan.validation.steps;
  if (steps.length === 0) {
    logger.info("validation", "No validation steps configured");
    return { passed: true, totalAttempts: 0, stepResults: [] };
  }

  const maxRetries = Math.max(...steps.map(s => s.retries));
  const stepAttemptCounts: Record<string, number> = {};
  for (const step of steps) {
    stepAttemptCounts[step.name] = 0;
  }

  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;
    logger.info("validation", `Validation round ${attempt}/${maxRetries + 1}`);

    // Run ALL steps sequentially
    const results: StepResult[] = [];
    let allPassed = true;

    for (const step of steps) {
      logger.debug("validation", `Running: ${step.name} — ${step.command}`);
      const result = await runValidationStep(container, step, plan.input.mountPath);
      results.push(result);
      stepAttemptCounts[step.name]++;

      if (result.passed) {
        logger.info("validation", `✔ ${step.name} passed (${result.durationMs}ms)`);
      } else {
        logger.warn("validation", `✗ ${step.name} failed (exit ${result.exitCode})`);
        allPassed = false;
      }
    }

    if (allPassed) {
      logger.info("validation", "All validation steps passed");
      return {
        passed: true,
        totalAttempts: attempt,
        stepResults: steps.map(s => ({
          name: s.name,
          passed: true,
          attempts: stepAttemptCounts[s.name],
        })),
      };
    }

    // Check if we have retries left
    if (attempt > maxRetries) {
      break;
    }

    // Feed errors back to agent
    const failedSteps = results.filter(r => !r.passed);
    const feedback = formatFeedback(failedSteps, plan.workflow.name);
    logger.info("validation", `${failedSteps.length} step(s) failed, sending feedback to agent`);

    // Re-invoke agent with feedback
    const fixPrompt = feedback;
    const agentCmd = adapter.buildCommand(fixPrompt, {
      model: plan.agent.model,
      maxTurns: plan.agent.maxTurns,
      timeout: plan.agent.timeout,
      flags: plan.agent.flags,
      workingDir: plan.input.mountPath,
    });

    // Wrap in shell to inject env
    const envPrefix = agentEnv.join(" ");
    const fullCmd = envPrefix
      ? ["sh", "-c", `${envPrefix} ${agentCmd.map(escapeShell).join(" ")}`]
      : agentCmd;

    logger.info("agent", "Agent fixing validation failures...");
    const fixResult = await execInContainer(container, fullCmd, {
      workingDir: plan.input.mountPath,
      timeout: plan.agent.timeout,
    });

    if (fixResult.exitCode !== 0) {
      logger.warn("agent", `Agent fix attempt exited with code ${fixResult.exitCode}`);
    }
  }

  // Exhausted retries
  logger.error("validation", `Validation failed after ${attempt} attempts`);
  return {
    passed: false,
    totalAttempts: attempt,
    stepResults: steps.map(s => ({
      name: s.name,
      passed: false, // Approximate — last round results
      attempts: stepAttemptCounts[s.name],
    })),
  };
}

function escapeShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
```

---

## Step 6: Output Collectors (`src/output/`)

### `src/output/types.ts`

```typescript
export interface GitResult {
  mode: "git";
  branch: string;
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileResult {
  mode: "files";
  dir: string;
  files: string[];
  totalSize: number;
}

export type OutputResult = GitResult | FileResult;
```

### `src/output/git.ts`

Collect git output: commit changes inside container, extract branch to host repo.

```typescript
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Docker from "dockerode";
import { execInContainer } from "../container/runner.js";
import { expandTemplate } from "../utils/template.js";
import { slugify } from "../utils/slug.js";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { GitResult } from "./types.js";

export async function collectGitOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<GitResult> {
  const slug = slugify(plan.task);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const branchName = expandTemplate(plan.commit.message.template, {
    slug, ts, prefix: plan.commit.message.prefix, summary: slug,
  }).replace(/\s+/g, "-");

  // Use plan's branch template for the branch name
  const branch = expandTemplate(plan.commit.author ? plan.commit.message.prefix : "forge/{{slug}}/{{ts}}", { slug, ts })
    .replace(/[^a-zA-Z0-9/_-]/g, "-");

  // Actually, use the repo.branch.template from the plan
  const branchFromTemplate = expandTemplate("forge/{{slug}}/{{ts}}", { slug, ts });

  logger.info("output", `Creating branch: ${branchFromTemplate}`);

  // Stage all changes
  const addResult = await execInContainer(container, ["git", "add", "-A"], {
    workingDir: "/workspace",
  });

  // Check if there are changes
  const diffResult = await execInContainer(container, ["git", "diff", "--cached", "--stat"], {
    workingDir: "/workspace",
  });

  if (!diffResult.stdout.trim()) {
    logger.warn("output", "No changes detected in workspace");
    return { mode: "git", branch: branchFromTemplate, sha: "", filesChanged: 0, insertions: 0, deletions: 0 };
  }

  // Create branch
  await execInContainer(container, ["git", "checkout", "-b", branchFromTemplate], {
    workingDir: "/workspace",
  });

  // Commit
  const commitMsg = expandTemplate(plan.commit.message.template, {
    prefix: plan.commit.message.prefix,
    summary: plan.task.slice(0, 72),
  });

  const commitCmd = [
    "git", "commit",
    "-m", commitMsg,
    "--author", `${plan.commit.author.name} <${plan.commit.author.email}>`,
  ];
  if (plan.commit.sign) commitCmd.push("-S");

  await execInContainer(container, commitCmd, { workingDir: "/workspace" });

  // Get commit SHA
  const shaResult = await execInContainer(container, ["git", "rev-parse", "HEAD"], {
    workingDir: "/workspace",
  });
  const sha = shaResult.stdout.trim();

  // Get diff stat
  const statResult = await execInContainer(container, ["git", "diff", "--stat", "HEAD~1"], {
    workingDir: "/workspace",
  });

  // Parse stats (last line: "N files changed, N insertions(+), N deletions(-)")
  const statLine = statResult.stdout.trim().split("\n").pop() || "";
  const filesChanged = parseInt(statLine.match(/(\d+) file/)?.[1] || "0", 10);
  const insertions = parseInt(statLine.match(/(\d+) insertion/)?.[1] || "0", 10);
  const deletions = parseInt(statLine.match(/(\d+) deletion/)?.[1] || "0", 10);

  // Extract .git from container and fetch into host repo
  const tmpGit = mkdtempSync(join(tmpdir(), "forgectl-git-"));
  try {
    // Copy .git dir from container
    const archive = await container.getArchive({ path: "/workspace/.git" });
    // Extract tar stream to temp dir
    await new Promise<void>((resolve, reject) => {
      const extract = require("node:child_process").spawn("tar", ["xf", "-", "-C", tmpGit]);
      archive.pipe(extract.stdin);
      extract.on("close", (code: number) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });

    // Fetch the branch from the extracted git dir into the host repo
    const gitDir = join(tmpGit, ".git");
    const hostRepo = plan.input.sources[0]; // The original repo path
    execSync(`git fetch "${gitDir}" "${branchFromTemplate}:${branchFromTemplate}"`, {
      cwd: hostRepo,
      stdio: "pipe",
    });

    logger.info("output", `Branch ${branchFromTemplate} fetched to host repo`);
  } finally {
    rmSync(tmpGit, { recursive: true, force: true });
  }

  return {
    mode: "git",
    branch: branchFromTemplate,
    sha,
    filesChanged,
    insertions,
    deletions,
  };
}
```

### `src/output/files.ts`

Collect file output: copy `/output` from container to host directory.

```typescript
import { mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { FileResult } from "./types.js";

export async function collectFileOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<FileResult> {
  const outputDir = plan.output.hostDir;
  mkdirSync(outputDir, { recursive: true });

  logger.info("output", `Collecting files from container ${plan.output.path} → ${outputDir}`);

  // Get archive of the output directory from container
  const archive = await container.getArchive({ path: plan.output.path });

  // Extract to a temp dir first, then move files to outputDir
  const tmpDir = mkdtempSync(join(tmpdir(), "forgectl-output-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const extract = require("node:child_process").spawn("tar", ["xf", "-", "-C", tmpDir]);
      archive.pipe(extract.stdin);
      extract.on("close", (code: number) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });

    // The tar extracts into a subdirectory named after the container path
    // e.g., /output becomes tmpDir/output/
    const extractedDir = join(tmpDir, "output");

    // Copy files to final output dir
    execSync(`cp -r "${extractedDir}/." "${outputDir}/"`, { stdio: "pipe" });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // List all files in the output dir
  const files = listFilesRecursive(outputDir);
  const totalSize = files.reduce((sum, f) => sum + statSync(join(outputDir, f)).size, 0);

  logger.info("output", `Collected ${files.length} files (${formatBytes(totalSize)})`);

  return {
    mode: "files",
    dir: outputDir,
    files,
    totalSize,
  };
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
```

### `src/output/collector.ts`

Dispatch to the right collector:

```typescript
import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "./types.js";
import { collectGitOutput } from "./git.js";
import { collectFileOutput } from "./files.js";

export async function collectOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<OutputResult> {
  if (plan.output.mode === "git") {
    return collectGitOutput(container, plan, logger);
  }
  return collectFileOutput(container, plan, logger);
}
```

---

## Step 7: Pre-flight Checks (`src/orchestration/preflight.ts`)

Verify everything before burning tokens:

```typescript
import Docker from "dockerode";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { RunPlan } from "../workflow/types.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import type { Logger } from "../logging/logger.js";

export interface PreflightResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export async function runPreflightChecks(plan: RunPlan, logger: Logger): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Docker available?
  logger.debug("preflight", "Checking Docker...");
  try {
    const docker = new Docker();
    await docker.ping();
  } catch {
    errors.push("Docker is not running. Start Docker Desktop or the Docker daemon.");
  }

  // 2. Credentials configured?
  logger.debug("preflight", "Checking credentials...");
  if (plan.agent.type === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) {
      errors.push('No Claude Code credentials found. Run: forgectl auth add claude-code');
    }
  } else if (plan.agent.type === "codex") {
    const auth = await getCodexAuth();
    if (!auth) {
      errors.push('No Codex credentials found. Run: forgectl auth add codex');
    }
  }

  // 3. Input files/repo exist?
  logger.debug("preflight", "Checking inputs...");
  for (const source of plan.input.sources) {
    if (!existsSync(source)) {
      errors.push(`Input not found: ${source}`);
    }
  }

  // 4. For git output mode, verify we're in a git repo
  if (plan.output.mode === "git") {
    const repoPath = plan.input.sources[0];
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: repoPath, stdio: "ignore" });
    } catch {
      errors.push(`Git output mode requires a git repository. ${repoPath} is not a git repo.`);
    }

    // Check for uncommitted changes
    try {
      const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });
      if (status.trim()) {
        warnings.push("Working directory has uncommitted changes. Consider committing first.");
      }
    } catch { /* ignore */ }
  }

  // 5. Context files exist?
  for (const file of plan.context.files) {
    if (!existsSync(file)) {
      warnings.push(`Context file not found (will be skipped): ${file}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
```

---

## Step 8: The Execution Engine (`src/orchestration/single.ts`)

This wires everything together for single-agent mode:

```typescript
import Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "../output/types.js";
import type { ValidationResult } from "../validation/runner.js";
import { getAgentAdapter } from "../agent/registry.js";
import { buildPrompt } from "../context/prompt.js";
import { createContainer, execInContainer, destroyContainer } from "../container/runner.js";
import { ensureImage } from "../container/builder.js";
import { prepareRepoWorkspace, prepareFilesWorkspace } from "../container/workspace.js";
import { createIsolatedNetwork, applyFirewall, removeNetwork } from "../container/network.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { prepareClaudeMounts, prepareCodexMounts, type ContainerMounts } from "../auth/mount.js";
import { runValidationLoop } from "../validation/runner.js";
import { collectOutput } from "../output/collector.js";
import { cleanupRun, type CleanupContext } from "../container/cleanup.js";
import { Timer } from "../utils/timer.js";
import { emitRunEvent } from "../logging/events.js";

export interface ExecutionResult {
  success: boolean;
  output?: OutputResult;
  validation: ValidationResult;
  durationMs: number;
  error?: string;
}

export async function executeSingleAgent(
  plan: RunPlan,
  logger: Logger
): Promise<ExecutionResult> {
  const timer = new Timer();
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  try {
    // --- Phase: Prepare ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "prepare" } });

    // 1. Ensure Docker image exists
    logger.info("prepare", `Ensuring image: ${plan.container.image}`);
    const image = await ensureImage(plan.container.image, plan.container.dockerfile);

    // 2. Prepare workspace
    const binds: string[] = [];
    if (plan.input.mode === "repo") {
      logger.info("prepare", "Preparing repo workspace...");
      const workspaceDir = prepareRepoWorkspace(plan.input.sources[0], plan.input.exclude);
      cleanup.tempDirs.push(workspaceDir);
      binds.push(`${workspaceDir}:${plan.input.mountPath}`);
    } else {
      logger.info("prepare", "Preparing file workspace...");
      const { inputDir, outputDir } = prepareFilesWorkspace(plan.input.sources);
      cleanup.tempDirs.push(inputDir, outputDir);
      binds.push(`${inputDir}:${plan.input.mountPath}:ro`);
      binds.push(`${outputDir}:${plan.output.path}`);
    }

    // 3. Prepare credentials
    let mounts: ContainerMounts;
    if (plan.agent.type === "claude-code") {
      const auth = await getClaudeAuth();
      if (!auth) throw new Error("No Claude Code credentials configured");
      mounts = prepareClaudeMounts(auth, plan.runId);
    } else {
      const apiKey = await getCodexAuth();
      if (!apiKey) throw new Error("No Codex credentials configured");
      mounts = prepareCodexMounts(apiKey, plan.runId);
    }
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);

    // 4. Create network (only for allowlist mode)
    if (plan.container.network.mode === "allowlist") {
      logger.info("prepare", "Creating isolated network...");
      await createIsolatedNetwork(plan.container.network.dockerNetwork);
      cleanup.networkName = plan.container.network.dockerNetwork;
    }

    // 5. Create container
    logger.info("prepare", "Starting container...");
    // Override the plan's image with the resolved one
    const resolvedPlan = { ...plan, container: { ...plan.container, image } };
    const container = await createContainer(resolvedPlan, binds);
    cleanup.container = container;

    // 6. Apply firewall (only for allowlist mode)
    if (plan.container.network.mode === "allowlist" && plan.container.network.allow) {
      logger.info("prepare", "Applying network firewall...");
      await applyFirewall(container, plan.container.network.allow);
    }

    // --- Phase: Execute ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "execute" } });

    // 7. Build prompt and invoke agent
    const prompt = buildPrompt(plan);
    const adapter = getAgentAdapter(plan.agent.type);
    const agentCmd = adapter.buildCommand(prompt, {
      model: plan.agent.model,
      maxTurns: plan.agent.maxTurns,
      timeout: plan.agent.timeout,
      flags: plan.agent.flags,
      workingDir: plan.input.mountPath,
    });
    const agentEnv = adapter.buildEnv(mounts.env);

    // Wrap in shell for env injection
    const envPrefix = agentEnv.join(" ");
    const fullCmd = envPrefix
      ? ["sh", "-c", `${envPrefix} ${agentCmd.map(escapeShell).join(" ")}`]
      : agentCmd;

    logger.info("agent", `Running ${plan.agent.type}...`);
    const agentResult = await execInContainer(container, fullCmd, {
      workingDir: plan.input.mountPath,
      timeout: plan.agent.timeout,
    });

    logger.info("agent", `Agent finished (exit ${agentResult.exitCode}, ${agentResult.durationMs}ms)`);
    if (agentResult.exitCode !== 0) {
      logger.warn("agent", `Agent exited with non-zero code: ${agentResult.exitCode}`);
      if (agentResult.stderr) {
        logger.debug("agent", `stderr: ${agentResult.stderr.slice(0, 500)}`);
      }
    }

    // --- Phase: Validate ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "validate" } });

    logger.info("validate", `Running ${plan.validation.steps.length} validation steps...`);
    const validationResult = await runValidationLoop(
      container, plan, adapter, agentEnv, logger
    );

    // --- Phase: Collect Output ---
    if (validationResult.passed || plan.validation.onFailure === "output-wip") {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "output" } });

      logger.info("output", `Collecting ${plan.output.mode} output...`);
      const output = await collectOutput(container, plan, logger);

      emitRunEvent({
        runId: plan.runId,
        type: "completed",
        timestamp: new Date().toISOString(),
        data: { success: true, output },
      });

      return {
        success: validationResult.passed,
        output,
        validation: validationResult,
        durationMs: timer.elapsed(),
      };
    }

    // Validation failed and on_failure = "abandon"
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: new Date().toISOString(),
      data: { reason: "validation_failed" },
    });

    return {
      success: false,
      validation: validationResult,
      durationMs: timer.elapsed(),
      error: "Validation failed and on_failure is set to 'abandon'",
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("execution", message);
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: new Date().toISOString(),
      data: { error: message },
    });
    return {
      success: false,
      validation: { passed: false, totalAttempts: 0, stepResults: [] },
      durationMs: timer.elapsed(),
      error: message,
    };
  } finally {
    // Always cleanup unless --no-cleanup
    if (!plan.agent.flags.includes("--no-cleanup")) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup flag)");
    }
  }
}

function escapeShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
```

### `src/orchestration/modes.ts`

Dispatch based on orchestration mode:

```typescript
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult } from "./single.js";
import { executeSingleAgent } from "./single.js";

/**
 * Dispatch execution based on orchestration mode.
 * Phase 3 only implements "single". Review and parallel are Phase 5.
 */
export async function executeRun(
  plan: RunPlan,
  logger: Logger
): Promise<ExecutionResult> {
  switch (plan.orchestration.mode) {
    case "single":
      return executeSingleAgent(plan, logger);
    case "review":
      // TODO: Phase 5 — for now, fall through to single
      logger.warn("orchestration", "Review mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger);
    case "parallel":
      // TODO: Phase 5
      logger.warn("orchestration", "Parallel mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger);
    default:
      return executeSingleAgent(plan, logger);
  }
}
```

---

## Step 9: Wire `forgectl run` End-to-End (`src/cli/run.ts`)

Replace the current stub with the full implementation:

```typescript
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";
import { runPreflightChecks } from "../orchestration/preflight.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import { saveRunLog, type RunLog } from "../logging/run-log.js";
import { emitRunEvent } from "../logging/events.js";
import { formatDuration } from "../utils/duration.js";

export async function runCommand(options: CLIOptions): Promise<void> {
  const config = loadConfig(options.config);
  const plan = resolveRunPlan(config, options);

  // --- Dry run ---
  if (options.dryRun) {
    printDryRun(plan);
    return;
  }

  const logger = new Logger(options.verbose);

  // --- Header ---
  console.log();
  console.log(chalk.bold(`🔨 forgectl run`));
  console.log(chalk.gray(`  Run ID:   ${plan.runId}`));
  console.log(chalk.gray(`  Workflow: ${plan.workflow.name}`));
  console.log(chalk.gray(`  Agent:    ${plan.agent.type}`));
  console.log(chalk.gray(`  Image:    ${plan.container.image}`));
  console.log();

  // --- Pre-flight ---
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

  // --- Execute ---
  emitRunEvent({ runId: plan.runId, type: "started", timestamp: new Date().toISOString(), data: { task: plan.task } });

  const result = await executeRun(plan, logger);

  // --- Summary ---
  console.log();
  if (result.success) {
    console.log(chalk.green.bold("✔ Run completed successfully"));
  } else {
    console.log(chalk.red.bold("✗ Run failed"));
    if (result.error) {
      console.log(chalk.red(`  ${result.error}`));
    }
  }

  console.log(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));

  if (result.validation.stepResults.length > 0) {
    console.log(chalk.gray(`  Validation: ${result.validation.totalAttempts} round(s)`));
    for (const step of result.validation.stepResults) {
      const icon = step.passed ? chalk.green("✔") : chalk.red("✗");
      console.log(chalk.gray(`    ${icon} ${step.name} (${step.attempts} attempt(s))`));
    }
  }

  if (result.output) {
    if (result.output.mode === "git") {
      console.log(chalk.cyan(`\n  Branch: ${result.output.branch}`));
      console.log(chalk.gray(`  ${result.output.filesChanged} files changed, +${result.output.insertions} -${result.output.deletions}`));
      console.log(chalk.gray(`\n  To review: git diff main...${result.output.branch}`));
      console.log(chalk.gray(`  To merge:  git merge ${result.output.branch}`));
    } else {
      console.log(chalk.cyan(`\n  Output: ${result.output.dir}`));
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

  // --- Save run log ---
  const runLog: RunLog = {
    runId: plan.runId,
    task: plan.task,
    workflow: plan.workflow.name,
    agent: plan.agent.type,
    status: result.success ? "success" : "failed",
    startedAt: new Date(Date.now() - result.durationMs).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    validation: {
      attempts: result.validation.totalAttempts,
      steps: result.validation.stepResults,
    },
    output: result.output
      ? result.output.mode === "git"
        ? { mode: "git", branch: result.output.branch }
        : { mode: "files", dir: result.output.dir, files: result.output.files }
      : { mode: plan.output.mode },
    entries: logger.getEntries(),
  };
  const logPath = saveRunLog(runLog, config.output.log_dir);
  console.log(chalk.gray(`Run log: ${logPath}\n`));

  if (!result.success) process.exit(1);
}

function printDryRun(plan: ReturnType<typeof resolveRunPlan>): void {
  // Keep existing dry-run implementation
  console.log(chalk.bold("\n📋 Run Plan (dry run)\n"));
  console.log(`  Run ID:     ${plan.runId}`);
  console.log(`  Task:       ${plan.task}`);
  console.log(`  Workflow:   ${plan.workflow.name}`);
  console.log(`  Agent:      ${plan.agent.type}${plan.agent.model ? ` (${plan.agent.model})` : ""}`);
  console.log(`  Image:      ${plan.container.image}`);
  console.log(`  Network:    ${plan.container.network.mode}`);
  console.log(`  Input:      ${plan.input.mode} → ${plan.input.mountPath}`);
  console.log(`  Output:     ${plan.output.mode}${plan.output.mode === "git" ? "" : ` → ${plan.output.hostDir}`}`);
  console.log(`  Validation: ${plan.validation.steps.length} steps`);
  for (const step of plan.validation.steps) {
    console.log(`    - ${step.name}: \`${step.command}\` (${step.retries} retries)`);
  }
  console.log(`  Review:     ${plan.orchestration.review.enabled ? "enabled" : "disabled"}`);
  console.log(`  Timeout:    ${plan.agent.timeout}ms`);
  console.log();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
```

---

## Step 10: Daemon + API (`src/daemon/`)

### `src/daemon/lifecycle.ts`

Daemon PID management:

```typescript
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const PID_DIR = join(process.env.HOME || "/tmp", ".forgectl");
const PID_FILE = join(PID_DIR, "daemon.pid");

export function savePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  // Check if process is actually running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    unlinkSync(PID_FILE);
    return null;
  }
}

export function removePid(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

export function isDaemonRunning(): boolean {
  return readPid() !== null;
}
```

### `src/daemon/queue.ts`

Simple in-memory run queue:

```typescript
import type { CLIOptions } from "../workflow/resolver.js";
import type { ExecutionResult } from "../orchestration/single.js";

export type QueuedRunStatus = "queued" | "running" | "completed" | "failed";

export interface QueuedRun {
  id: string;
  options: CLIOptions;
  status: QueuedRunStatus;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;
  error?: string;
}

export class RunQueue {
  private queue: QueuedRun[] = [];
  private running = false;
  private onExecute: (run: QueuedRun) => Promise<ExecutionResult>;

  constructor(onExecute: (run: QueuedRun) => Promise<ExecutionResult>) {
    this.onExecute = onExecute;
  }

  submit(id: string, options: CLIOptions): QueuedRun {
    const run: QueuedRun = {
      id,
      options,
      status: "queued",
      submittedAt: new Date().toISOString(),
    };
    this.queue.push(run);
    this.processNext();
    return run;
  }

  get(id: string): QueuedRun | undefined {
    return this.queue.find(r => r.id === id);
  }

  list(): QueuedRun[] {
    return [...this.queue];
  }

  private async processNext(): Promise<void> {
    if (this.running) return;
    const next = this.queue.find(r => r.status === "queued");
    if (!next) return;

    this.running = true;
    next.status = "running";
    next.startedAt = new Date().toISOString();

    try {
      next.result = await this.onExecute(next);
      next.status = next.result.success ? "completed" : "failed";
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : String(err);
    } finally {
      next.completedAt = new Date().toISOString();
      this.running = false;
      this.processNext();
    }
  }
}
```

### `src/daemon/routes.ts`

REST API routes:

```typescript
import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";

export function registerRoutes(app: FastifyInstance, queue: RunQueue): void {
  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Submit a run
  app.post<{ Body: { task: string; workflow?: string; input?: string[]; agent?: string } }>(
    "/runs",
    async (request, reply) => {
      const { task, workflow, input, agent } = request.body;
      const id = `forge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const run = queue.submit(id, { task, workflow, input, agent });
      reply.code(202);
      return { id: run.id, status: run.status };
    }
  );

  // List runs
  app.get("/runs", async () => {
    return queue.list().map(r => ({
      id: r.id,
      status: r.status,
      workflow: r.options.workflow,
      task: r.options.task,
      submittedAt: r.submittedAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  });

  // Get run status
  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = queue.get(request.params.id);
    if (!run) { reply.code(404); return { error: "Run not found" }; }
    return run;
  });

  // SSE stream for a run
  app.get<{ Params: { id: string } }>("/runs/:id/events", async (request, reply) => {
    const runId = request.params.id;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const handler = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    runEvents.on(`run:${runId}`, handler);

    request.raw.on("close", () => {
      runEvents.off(`run:${runId}`, handler);
    });
  });
}
```

### `src/daemon/server.ts`

Main daemon server:

```typescript
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";
import { savePid, removePid } from "./lifecycle.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import type { QueuedRun } from "./queue.js";

export async function startDaemon(port = 4856): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const queue = new RunQueue(async (run: QueuedRun) => {
    const config = loadConfig();
    const plan = resolveRunPlan(config, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger);
  });

  registerRoutes(app, queue);

  await app.listen({ port, host: "127.0.0.1" });
  savePid(process.pid);

  console.log(`forgectl daemon running on http://127.0.0.1:${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    removePid();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
```

---

## Step 11: Wire Daemon CLI Commands

Update `src/index.ts` to wire up the daemon commands. Replace the stubs for `submit`, `up`, `down`, `status`, and `logs`.

The `up` command should fork a background process running the daemon (or run in foreground with `--foreground`).

The `submit` command should POST to the daemon's `/runs` endpoint.

The `status` command should GET from `/health` and `/runs`.

The `logs` command should GET from `/runs/:id/events` (SSE) or `/runs/:id` (status).

The `down` command should send SIGTERM to the daemon PID.

---

## Step 12: Tests

### `test/unit/prompt.test.ts`
- Test `buildPrompt` produces correct sections (system, context, tools, task, validation)
- Test validation instructions are included when steps exist
- Test file output instructions are added for files mode

### `test/unit/validation.test.ts`
- Test `formatFeedback` produces correct output for each workflow type
- Test truncation works for long output
- Test `runValidationStep` mock returns correct StepResult shape

### `test/unit/agent.test.ts`
- Test Claude Code adapter builds correct command array
- Test Codex adapter builds correct command array
- Test `getAgentAdapter` throws for unknown name

### `test/unit/output.test.ts`
- Test `listFilesRecursive` returns correct file list
- Test `formatBytes` formats correctly

### `test/unit/preflight.test.ts`
- Test preflight with missing Docker produces error
- Test preflight with missing credentials produces error
- Test preflight with missing input files produces error

### `test/unit/daemon.test.ts`
- Test RunQueue submit/get/list
- Test queue processes sequentially
- Test PID lifecycle (save/read/remove)

---

## Summary of What Must Work After This Phase

```bash
# End-to-end execution (requires Docker + credentials)
forgectl run --task "Add a healthcheck endpoint to server.ts" --workflow code --repo .

# Research workflow
forgectl run --task "Competitive analysis of vector databases" --workflow research

# Data workflow
forgectl run --task "Clean and deduplicate" --workflow data --input ./data.csv

# Pre-flight catches missing Docker
forgectl run --task "test" --workflow code
# → Error: Docker is not running

# Pre-flight catches missing credentials
forgectl run --task "test" --workflow code
# → Error: No Claude Code credentials found

# Dry run still works
forgectl run --task "test" --workflow code --dry-run

# Daemon
forgectl up                         # Starts daemon on :4856
forgectl status                     # Shows daemon status + runs
forgectl submit --task "..." --workflow code  # Async submission
forgectl logs <run-id> --follow     # Stream logs
forgectl down                       # Stops daemon

# Run log saved after each run
cat .forgectl/runs/forge-*.json

# Tests
npm test                            # All unit tests pass (old + new)
```

## IMPORTANT Implementation Notes

1. **The `--no-cleanup` flag** — When building `src/cli/run.ts`, make sure the `noCleanup` CLI option is threaded through. The existing `plan.agent.flags` approach in the `single.ts` won't work cleanly. Add a `noCleanup` field to the RunPlan or pass it separately.

2. **Shell escaping** — The agent prompt can be very long (system prompt + context + task). When wrapping in `sh -c`, the prompt goes through shell expansion. Use proper escaping or write the prompt to a temp file in the container and read it from there:
   ```
   execInContainer(container, ["sh", "-c", "cat /tmp/prompt.txt | claude -p -"]);
   ```
   This is more robust than trying to escape a multi-kilobyte string.

3. **The `require("node:child_process")` in output collectors** — The project uses ESM (`"type": "module"`). Use `import` instead of `require`. Import `spawn` and `execSync` from `"node:child_process"` at the top of the file.

4. **Git output: tar extraction** — When extracting the `.git` dir from the container, use `spawn("tar", ...)` with the archive stream piped to stdin. This avoids loading the entire tar into memory.

5. **Files output: container path handling** — Docker's `getArchive` returns a tar with the path component. If you request `/output`, the tar contains `output/...`. Strip the leading directory when extracting to the host output dir.

6. **Agent timeout** — `execInContainer` already supports a timeout option. Make sure the agent invocation uses `plan.agent.timeout` to kill runaway agents.

7. **Daemon forking** — For `forgectl up`, spawn a detached child process:
   ```typescript
   import { spawn } from "node:child_process";
   const child = spawn(process.execPath, [daemonScript], {
     detached: true, stdio: "ignore",
   });
   child.unref();
   ```
