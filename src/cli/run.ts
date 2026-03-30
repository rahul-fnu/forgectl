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
    await printDryRun(plan);
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
  if (plan.orchestration.mode === "review") {
    console.log(chalk.gray(`  Mode:     review (max ${plan.orchestration.review.maxRounds} rounds)`));
  }
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

  const noCleanup = options.noCleanup === true;
  const result = await executeRun(plan, logger, noCleanup);

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

  if (result.review) {
    if (result.review.approved) {
      console.log(chalk.gray(`  Review: ${result.review.totalRounds} round(s), approved on round ${result.review.approvedOnRound}`));
    } else if (result.review.escalatedToHuman) {
      console.log(chalk.yellow(`  Review: ${result.review.totalRounds} round(s), escalated to human`));
    } else {
      console.log(chalk.gray(`  Review: ${result.review.totalRounds} round(s), not approved`));
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
      ? { mode: result.output.mode, branch: result.output.mode === "git" ? result.output.branch : undefined }
      : { mode: "git" },
    entries: logger.getEntries(),
  };
  const logPath = saveRunLog(runLog, config.output.log_dir);
  console.log(chalk.gray(`Run log: ${logPath}\n`));

  if (!result.success) process.exit(1);
}

async function printDryRun(plan: ReturnType<typeof resolveRunPlan>): Promise<void> {
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
  console.log(`  Review:     ${plan.orchestration.review.enabled ? `enabled (max ${plan.orchestration.review.maxRounds} rounds)` : "disabled"}`);
  console.log(`  Timeout:    ${formatDuration(plan.agent.timeout)}`);

  let credStatus: string;
  if (plan.agent.type === "claude-code") {
    const { getClaudeAuth } = await import("../auth/claude.js");
    const auth = await getClaudeAuth();
    credStatus = auth
      ? chalk.green(`✔ ${auth.type === "oauth_session" ? "OAuth session" : "API key"}`)
      : chalk.red("✗ not configured — run: forgectl auth add claude-code");
  } else if (plan.agent.type === "codex") {
    const { getCodexAuth } = await import("../auth/codex.js");
    const auth = await getCodexAuth();
    credStatus = auth
      ? chalk.green(`✔ ${auth.type === "oauth_session" ? "OAuth session" : "API key"}`)
      : chalk.red("✗ not configured — run: forgectl auth add codex");
  } else {
    credStatus = chalk.yellow("unknown agent type");
  }
  console.log(`  Credentials: ${credStatus}`);

  console.log();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function runSummaryCommand(runId: string): Promise<void> {
  console.log(`Run summary for ${runId} is not available (storage module removed).`);
}
