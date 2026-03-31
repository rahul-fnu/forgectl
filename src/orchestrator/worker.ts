import crypto from "node:crypto";
import type { RunPlan } from "../workflow/types.js";
import type { TrackerIssue } from "../tracker/types.js";
import type { ForgectlConfig, ValidationStep } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { AgentResult } from "../agent/session.js";
import type { ExecutionResult } from "../orchestration/single.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CleanupContext } from "../container/cleanup.js";
import type { ValidationResult } from "../validation/runner.js";
import { prepareExecution } from "../orchestration/single.js";
import { createAgentSession } from "../agent/session.js";
import { cleanupRun } from "../container/cleanup.js";
import { runValidationLoop, runValidationGate, runLintGate } from "../validation/runner.js";
import { runReviewAgent } from "../validation/review-agent.js";
import type { ReviewOutput } from "../validation/review-agent.js";
import { collectGitOutput, recordPreAgentSha } from "../output/git.js";
import { buildResultComment as buildGHResultComment } from "../github/comments.js";
import type { RunResult } from "../github/comments.js";
import type { IssueContext } from "../github/types.js";
import type { RepoContext } from "../github/types.js";
import { updateProgressComment } from "../github/comments.js";
import { createCheckRun, updateCheckRun, completeCheckRun, buildCheckSummary } from "../github/checks.js";
import { createPRForBranch } from "../github/pr-description.js";
import type { PRDescriptionData } from "../github/pr-description.js";
import { renderPromptTemplate, buildTemplateVars } from "../workflow/template.js";
import { buildPrompt } from "../context/prompt.js";
import { parseDuration } from "../utils/duration.js";
import { formatDuration } from "../utils/duration.js";
import type { GovernanceOpts } from "./dispatcher.js";
import { emitRunEvent } from "../logging/events.js";
import { saveCheckpoint } from "../durability/checkpoint.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import { formatRunComment, shouldPostComment } from "../tracker/linear-comments.js";
import type { RunCommentData } from "../tracker/linear-comments.js";
import { BudgetExceededError, checkCostCeiling } from "../agent/budget.js";
import type { EventRepository } from "../storage/repositories/events.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { generateRunSummary } from "../analysis/run-summary.js";
import { UsageLimitDetector, UsageLimitError } from "../agent/usage-limit-detector.js";
import type { AlertManager } from "../alerting/manager.js";
import type { AlertEvent } from "../alerting/types.js";
import { createSpan, endSpan } from "../tracing/context.js";
import type { Span } from "../tracing/context.js";
import type { TraceRepository } from "../storage/repositories/traces.js";
import { detectClarificationNeed, extractQuestion } from "../discord/clarify.js";
import type { ClarificationCallback } from "../discord/clarify.js";

function persistSpan(traceRepo: TraceRepository | undefined, span: Span): void {
  if (!traceRepo) return;
  try {
    traceRepo.insert({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      operationName: span.name,
      startMs: span.startMs,
      durationMs: (span.endMs ?? Date.now()) - span.startMs,
      status: span.status,
    });
  } catch { /* best-effort */ }
}

export interface WorkerResult {
  agentResult: AgentResult;
  comment: string;
  executionResult?: ExecutionResult;
  validationResult?: ValidationResult;
  lintIterations?: number;
  branch?: string;
  pendingApproval?: boolean;
  reviewOutput?: ReviewOutput;
  diffStat?: string;
  costCeilingExceeded?: boolean;
}

/** Optional GitHub dependencies for progress comment updates during worker execution. */
export interface GitHubDeps {
  octokit: {
    rest: {
      issues: { updateComment(params: { owner: string; repo: string; comment_id: number; body: string }): Promise<unknown> };
      checks: {
        create(params: { owner: string; repo: string; head_sha: string; name: string; status: string; external_id?: string }): Promise<{ data: { id: number } }>;
        update(params: { owner: string; repo: string; check_run_id: number; status: string; conclusion?: string; output?: { title: string; summary: string } }): Promise<unknown>;
      };
      pulls: {
        list(params: { owner: string; repo: string; head: string; state: string }): Promise<{ data: Array<{ number: number; body: string | null }> }>;
        create(params: { owner: string; repo: string; title: string; body: string; head: string; base: string }): Promise<{ data: { number: number; html_url: string } }>;
        update(params: { owner: string; repo: string; pull_number: number; body: string }): Promise<unknown>;
      };
    };
  };
  issueContext: IssueContext;
  commentId: number;
  runId: string;
  /** Head SHA for check run creation (available on PR events, not issue-only). */
  headSha?: string;
  /** Repository context for check run and PR description API calls. */
  repoContext?: RepoContext;
}

/**
 * Map worker execution data to the github/comments.ts RunResult interface.
 * Exported for testing.
 */
export function toRunResult(
  runId: string,
  agentResult: AgentResult,
  durationMs: number,
  validationResult?: ValidationResult,
  _branch?: string,
  workflow?: string,
): RunResult {
  const cost = agentResult.tokenUsage
    ? {
        input_tokens: agentResult.tokenUsage.input,
        output_tokens: agentResult.tokenUsage.output,
        estimated_usd: `$${((agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000).toFixed(4)}`,
      }
    : undefined;

  return {
    runId,
    status: agentResult.status === "completed" ? "success" : "failure",
    duration: formatDuration(durationMs),
    cost,
    changes: [],
    validationResults: validationResult?.stepResults.map((sr) => ({
      step: sr.name,
      passed: sr.passed,
    })),
    workflow,
    agent: agentResult.status === "completed" ? "claude-code" : undefined,
  };
}

/**
 * Build a RunPlan adapted for orchestrated runs.
 * Uses WorkspaceManager paths instead of temp dirs.
 */
export function buildOrchestratedRunPlan(
  issue: TrackerIssue,
  config: ForgectlConfig,
  workspacePath: string,
  promptTemplate: string,
  attempt: number,
  validationConfig?: { steps: ValidationStep[]; lint_steps?: ValidationStep[]; on_failure: string; max_same_failures?: number; on_repeated_failure?: string },
  skills?: string[],
): RunPlan {
  const runId = crypto.randomUUID();

  // Render the prompt template with issue data
  const vars = buildTemplateVars(issue, attempt);
  const task = renderPromptTemplate(promptTemplate, vars);

  // Agent settings from config
  const agentConfig = config.agent;
  const timeoutMs = parseDuration(agentConfig.timeout);

  // Container image from config
  const containerConfig = config.container;
  const image = containerConfig.image ?? "node:20";

  return {
    runId,
    task,
    workflow: {
      name: "orchestrated",
      description: `Orchestrated run for ${issue.identifier}`,
      container: { image, network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: [],
      system: "",
      validation: {
        steps: validationConfig?.steps ?? [],
        lint_steps: validationConfig?.lint_steps ?? [],
        on_failure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
        max_same_failures: validationConfig?.max_same_failures ?? 2,
        on_repeated_failure: (validationConfig?.on_repeated_failure as "abort" | "change_strategy" | "escalate") ?? "abort",
      },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
      cache: { enabled: true, ttl: "7d" },
      autonomy: "full",
      skills: skills ?? [],
    },
    agent: {
      type: agentConfig.type,
      model: agentConfig.model,
      maxTurns: agentConfig.max_turns,
      timeout: timeoutMs,
      flags: agentConfig.flags,
    },
    container: {
      image,
      network: {
        mode: containerConfig.network.mode ?? "open",
        dockerNetwork: containerConfig.network.mode === "airgapped" ? "none" : "bridge",
      },
      resources: {
        memory: containerConfig.resources.memory,
        cpus: containerConfig.resources.cpus,
      },
    },
    input: {
      mode: "repo",
      sources: [workspacePath],
      mountPath: "/workspace",
      exclude: config.repo.exclude,
    },
    context: {
      system: "",
      files: [],
      inject: [],
    },
    validation: {
      steps: validationConfig?.steps ?? [],
      lintSteps: validationConfig?.lint_steps ?? [],
      onFailure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
      maxSameFailures: validationConfig?.max_same_failures ?? 2,
      onRepeatedFailure: (validationConfig?.on_repeated_failure as "abort" | "change_strategy" | "escalate") ?? "abort",
    },
    output: {
      mode: "git",
      path: "/workspace",
      collect: [],
      hostDir: workspacePath,
    },
    orchestration: {
      mode: "single",
      review: {
        enabled: false,
        system: "",
        maxRounds: 0,
        agent: "claude-code",
        model: "",
      },
    },
    commit: {
      message: {
        prefix: config.commit.message.prefix,
        template: config.commit.message.template,
        includeTask: config.commit.message.include_task,
      },
      author: config.commit.author,
      sign: config.commit.sign,
    },
    // Team config from forgectl.yaml flows to RunPlan for env var injection and checkpoint bypass
    ...(config.team?.size && config.team.size >= 2
      ? {
          team: { size: config.team.size, slotWeight: config.team.size },
          skipCheckpoints: true,
        }
      : {}),
  };
}

/**
 * Execute a single worker lifecycle for an issue.
 * Adapts the existing prepareExecution flow to use WorkspaceManager paths.
 */
export async function executeWorker(
  issue: TrackerIssue,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  attempt: number,
  logger: Logger,
  onActivity?: () => void,
  validationConfig?: { steps: ValidationStep[]; lint_steps?: ValidationStep[]; on_failure: string; max_same_failures?: number; on_repeated_failure?: string },
  githubDeps?: GitHubDeps,
  governance?: GovernanceOpts,
  skills?: string[],
  _kgContext?: unknown,
  snapshotRepo?: SnapshotRepository,
  promotedFindings?: import("../storage/repositories/review-findings.js").ReviewFindingRow[],
  tracker?: TrackerAdapter,
  costRepo?: CostRepository,
  eventRepo?: EventRepository,
  runRepo?: RunRepository,
  traceRepo?: TraceRepository,
  traceId?: string,
  alertManager?: AlertManager,
  discordClarification?: ClarificationCallback,
): Promise<WorkerResult> {
  // 1. Ensure workspace exists
  // With max_concurrent_agents > 1, use per-issue workspaces to avoid conflicts.
  // With max_concurrent_agents == 1, use shared workspace for chaining.
  const maxAgents = config.orchestrator?.max_concurrent_agents ?? 1;
  const workspaceId = maxAgents > 1
    ? issue.identifier
    : (config.tracker?.repo?.replace("/", "_") ?? issue.identifier);
  const wsInfo = await workspaceManager.ensureWorkspace(workspaceId);
  const workspacePath = wsInfo.path;

  // 2. Run before hook
  try {
    await workspaceManager.runBeforeHook(workspaceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("worker", `Before hook failed for ${issue.identifier}: ${message}`);
    const failResult: AgentResult = {
      stdout: "",
      stderr: `Workspace setup (before hook) failed: ${message}`,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
    return {
      agentResult: failResult,
      comment: `**forgectl:** Workspace setup failed (before hook error, not agent failure).\n\n\`\`\`\n${message}\n\`\`\``,
    };
  }

  // 2.5. Pre-flight: verify workspace is a git repo (prevents silent output loss)
  const { existsSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  if (existsSync(workspacePath) && !existsSync(pathJoin(workspacePath, ".git"))) {
    const message = `Workspace ${workspacePath} is not a git repository (no .git directory). The after_create hook may have failed or is not configured. Agent output would be lost.`;
    logger.error("worker", message);
    const failResult: AgentResult = {
      stdout: "",
      stderr: message,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
    return {
      agentResult: failResult,
      comment: `**forgectl:** Workspace is not a git repository — agent output would be lost. Check workspace hooks.\n\n\`\`\`\n${message}\n\`\`\``,
    };
  }

  // 2.7. Load per-repo config (forgectl.yaml) from workspace after clone
  let effectiveConfig = config;
  let effectiveValidationConfig = validationConfig;
  try {
    const { loadRepoConfig, mergeWithRepoConfig } = await import("../config/loader.js");
    const repoConfig = loadRepoConfig(workspacePath);
    if (repoConfig) {
      effectiveConfig = mergeWithRepoConfig(config, repoConfig);
      // Convert validate strings to ValidationStep objects if present
      if (repoConfig.validate.length > 0) {
        effectiveValidationConfig = {
          steps: repoConfig.validate.map((cmd, i) => ({
            name: `step-${i + 1}`,
            command: cmd,
            retries: 3,
            description: "",
          })),
          on_failure: "abandon",
        };
      }
      logger.info("worker", `Loaded per-repo config from ${workspacePath}/forgectl.yaml`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `Failed to load per-repo config: ${msg}`);
  }

  // 3. Build RunPlan (with optional validationConfig and skills)
  const plan = buildOrchestratedRunPlan(issue, effectiveConfig, workspacePath, promptTemplate, attempt, effectiveValidationConfig, skills);

  // Create root span for the entire worker execution
  const rootSpan = traceId ? createSpan(traceId, "run", null) : undefined;

  // Save prepare checkpoint with workspace metadata
  if (snapshotRepo) {
    saveCheckpoint(snapshotRepo, plan.runId, "prepare", {
      workspacePath,
      issueId: issue.id,
    });
  }

  // 4. Create CleanupContext with empty tempDirs (workspace persists)
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  let agentResult: AgentResult | undefined;
  let validationResult: ValidationResult | undefined;
  let lintIterations: number | undefined;
  let branch: string | undefined;
  let diffStat: string | undefined;
  let checkRunId: number | undefined;
  let pendingApproval = false;
  let reviewOutput: ReviewOutput | undefined;
  let costCeilingExceeded = false;
  let prUrl: string | undefined;

  // Create check run at start (if headSha available)
  if (githubDeps?.headSha && githubDeps?.repoContext) {
    try {
      checkRunId = await createCheckRun(
        githubDeps.octokit as any,
        githubDeps.repoContext.owner,
        githubDeps.repoContext.repo,
        githubDeps.headSha,
        plan.runId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("worker", `Failed to create check run: ${msg}`);
    }
  }

  try {
    // 5. Prepare execution (container, credentials, network)
    const prepareSpan = traceId ? createSpan(traceId, "prepare", rootSpan?.spanId) : undefined;
    const { container, agentOptions, agentEnv, adapter } = await prepareExecution(plan, logger, cleanup);
    if (prepareSpan) persistSpan(traceRepo, endSpan(prepareSpan, "ok"));

    // Ensure container is in worker-level cleanup context so it is destroyed on errors
    cleanup.container = container;

    // 6. Create agent session with onActivity callback for stall detection
    const session = createAgentSession(plan.agent.type, container, agentOptions, agentEnv, {
      onActivity,
      onOutput: (chunk, stream) => {
        emitRunEvent({
          runId: plan.runId,
          type: "agent_output",
          timestamp: new Date().toISOString(),
          data: { stream, chunk },
        });
      },
      onClarification: discordClarification,
    });

    // 6.5. Record pre-agent HEAD so we can detect agent changes later
    let preAgentSha: string | undefined;
    try {
      preAgentSha = await recordPreAgentSha(container);
    } catch {
      // Non-critical — fallback to root commit detection
    }

    // 7. Invoke agent with full prompt (includes validation step descriptions)
    const fullPrompt = buildPrompt(plan, promotedFindings ? { promotedFindings } : undefined);
    logger.info("worker", `Running agent for ${issue.identifier} (attempt ${attempt})`);

    emitRunEvent({
      runId: plan.runId,
      type: "agent_started",
      timestamp: new Date().toISOString(),
      data: { issueId: issue.id, identifier: issue.identifier, attempt },
    });

    const agentSpan = traceId ? createSpan(traceId, "agent_invoke", rootSpan?.spanId) : undefined;
    agentResult = await session.invoke(fullPrompt);
    if (agentSpan) persistSpan(traceRepo, endSpan(agentSpan, agentResult.status === "completed" ? "ok" : "error"));

    // --- Usage limit detection ---
    const usageLimitConfig = config.agent.usage_limit;
    if (usageLimitConfig?.enabled) {
      const detector = new UsageLimitDetector({
        enabled: true,
        patterns: usageLimitConfig.detection_patterns,
        hangTimeoutMs: usageLimitConfig.hang_timeout_ms,
      });
      const combined = `${agentResult.stdout}\n${agentResult.stderr}`;
      const detection = detector.checkOutput(combined);
      if (detection) {
        throw new UsageLimitError(detection);
      }
    }

    // --- Clarification detection from agent output ---
    if (discordClarification && agentResult.status !== "failed") {
      const combined = `${agentResult.stdout}\n${agentResult.stderr}`;
      const clarificationLine = detectClarificationNeed(combined);
      if (clarificationLine) {
        const question = extractQuestion(combined, clarificationLine);
        logger.info("worker", `Clarification needed for ${issue.identifier}: ${clarificationLine}`);
        emitRunEvent({
          runId: plan.runId,
          type: "clarification_requested",
          timestamp: new Date().toISOString(),
          data: { question },
        });
        const answer = await discordClarification(question);
        if (answer) {
          logger.info("worker", `Clarification received for ${issue.identifier}, re-invoking agent`);
          const clarificationPrompt = `${fullPrompt}\n\n## Clarification from user\n\n${answer}`;
          agentResult = await session.invoke(clarificationPrompt);
        } else {
          logger.info("worker", `No clarification received for ${issue.identifier}, proceeding with best judgment`);
        }
      }
    }

    // --- Cost ceiling check ---
    const ceilingConfig = {
      maxCostUsd: config.agent.max_cost_usd,
      maxTokens: config.agent.max_tokens,
    };
    if (ceilingConfig.maxCostUsd !== undefined || ceilingConfig.maxTokens !== undefined) {
      const costUsd = agentResult.tokenUsage
        ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
        : 0;
      const cumulative = {
        inputTokens: agentResult.tokenUsage?.input ?? 0,
        outputTokens: agentResult.tokenUsage?.output ?? 0,
        costUsd,
      };
      const ceilingResult = checkCostCeiling(cumulative, ceilingConfig);
      if (ceilingResult.percentUsed >= 80 && !ceilingResult.exceeded) {
        logger.warn("budget", `Run ${plan.runId} at 80% of cost ceiling (${ceilingResult.percentUsed.toFixed(1)}% used)`);
      }
      if (ceilingResult.exceeded) {
        throw new BudgetExceededError("per_run", cumulative.costUsd, ceilingConfig.maxCostUsd ?? 0);
      }
    }

    // Save execute checkpoint with workspace metadata
    if (snapshotRepo) {
      saveCheckpoint(snapshotRepo, plan.runId, "execute", {
        workspacePath,
        issueId: issue.id,
        metadata: { agentStatus: agentResult.status },
      });
    }

    // Update progress: agent_executing complete
    if (githubDeps) {
      try {
        await updateProgressComment(githubDeps.octokit as any, githubDeps.issueContext, githubDeps.commentId, {
          runId: githubDeps.runId,
          status: "running",
          completedStages: ["agent_executing"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to update progress comment (agent stage): ${msg}`);
      }
    }

    // 7.5. Run lint gate BEFORE validation loop (deterministic checks first)
    if (plan.validation.lintSteps.length > 0) {
      logger.info("worker", `Running ${plan.validation.lintSteps.length} lint steps for ${issue.identifier}`);
      const lintResult = await runLintGate(
        container, plan.validation.lintSteps, plan.input.mountPath,
        adapter, agentOptions, agentEnv, logger,
      );
      lintIterations = lintResult.lintIterations;
      if (!lintResult.passed) {
        logger.error("worker", `Lint gate failed for ${issue.identifier} after ${lintResult.lintIterations} iterations`);
        agentResult = {
          ...agentResult,
          status: "failed",
          stderr: "Lint gate failed: lint checks did not pass after retries",
        };
      }
    }

    // 8. Run validation loop BEFORE closing session (container must be alive)
    if (plan.validation.steps.length > 0 && agentResult.status !== "failed") {
      logger.info("worker", `Running ${plan.validation.steps.length} validation steps for ${issue.identifier}`);
      const validationSpan = traceId ? createSpan(traceId, "validation", rootSpan?.spanId) : undefined;
      validationResult = await runValidationLoop(container, plan, adapter, agentOptions, agentEnv, logger);
      if (validationSpan) persistSpan(traceRepo, endSpan(validationSpan, validationResult.passed ? "ok" : "error"));

      // Halt on loop detection
      if (validationResult.loopDetected) {
        const loop = validationResult.loopDetected;
        logger.error("worker", `Loop detected for ${issue.identifier}: ${loop.type} — ${loop.detail}`);

        emitRunEvent({
          runId: plan.runId,
          type: "loop_detected",
          timestamp: new Date().toISOString(),
          data: { issueId: issue.id, identifier: issue.identifier, loopType: loop.type, detail: loop.detail },
        });

        agentResult = {
          ...agentResult,
          status: "failed",
          stderr: `Loop detected (${loop.type}): ${loop.detail}`,
        };
      }
    }

    // Save validate checkpoint
    if (snapshotRepo) {
      saveCheckpoint(snapshotRepo, plan.runId, "validate", {
        workspacePath,
        issueId: issue.id,
        metadata: { validationPassed: validationResult?.passed ?? true },
      });
    }

    // Update progress: validating complete
    if (githubDeps) {
      try {
        await updateProgressComment(githubDeps.octokit as any, githubDeps.issueContext, githubDeps.commentId, {
          runId: githubDeps.runId,
          status: "running",
          completedStages: ["agent_executing", "validating"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to update progress comment (validation stage): ${msg}`);
      }
    }

    // Post-validation build gate: run validation steps once more with no retries.
    // If it fails, mark run as failed and skip output collection entirely.
    if (plan.validation.steps.length > 0 && validationResult?.passed) {
      const gateResult = await runValidationGate(
        container,
        plan.validation.steps,
        plan.input.mountPath,
        logger,
      );
      if (!gateResult.passed) {
        logger.error("worker", `Build gate failed for ${issue.identifier} — skipping output collection`);
        agentResult = {
          ...agentResult,
          status: "failed",
          stderr: "Post-validation build gate failed: validation steps did not pass final check",
        };
        validationResult = gateResult;
      }
    }

    // Update check run after validation
    if (checkRunId && githubDeps?.repoContext) {
      try {
        await updateCheckRun(
          githubDeps.octokit as any,
          githubDeps.repoContext.owner,
          githubDeps.repoContext.repo,
          checkRunId,
          "in_progress",
          { title: "Validation complete", summary: "Validation finished, collecting output..." },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to update check run: ${msg}`);
      }
    }

    // 8.5. Run review agent — only after lint gate passes
    if (agentResult.status !== "failed" && validationResult?.passed !== false) {
      const reviewSpan = traceId ? createSpan(traceId, "review", rootSpan?.spanId) : undefined;
      try {
        reviewOutput = await runReviewAgent(
          container, adapter, agentOptions, agentEnv, plan.task, logger,
        );
        if (reviewSpan) persistSpan(traceRepo, endSpan(reviewSpan, "ok"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Review agent failed (non-blocking): ${msg}`);
        if (reviewSpan) persistSpan(traceRepo, endSpan(reviewSpan, "error"));
      }
    }

    // 9. Collect git output — skip if build gate already failed
    if (agentResult.status !== "failed") {
      const outputSpan = traceId ? createSpan(traceId, "output", rootSpan?.spanId) : undefined;
      try {
        const pushToken = config.tracker?.token;
        const gitResult = await collectGitOutput(container, plan, logger, preAgentSha, pushToken);
        branch = gitResult.branch;
        diffStat = gitResult.diffStat;
        if (outputSpan) persistSpan(traceRepo, endSpan(outputSpan, "ok"));
      } catch (err) {
        if (outputSpan) persistSpan(traceRepo, endSpan(outputSpan, "error"));
        const message = err instanceof Error ? err.message : String(err);
        logger.error("worker", `Git output collection failed for ${issue.identifier}: ${message}`);
        // Override agent result — the work is lost if we can't collect output
        agentResult = {
          ...agentResult,
          status: "failed",
          stderr: `Agent completed but git output collection failed (work lost): ${message}`,
        };
      }
    } else {
      logger.warn("worker", `Skipping output collection for ${issue.identifier} — agent/gate already failed`);
    }

    // Save output checkpoint
    if (snapshotRepo) {
      saveCheckpoint(snapshotRepo, plan.runId, "output", {
        workspacePath,
        branchName: branch,
        issueId: issue.id,
      });
    }

    // Update progress: collecting_output complete
    if (githubDeps) {
      try {
        await updateProgressComment(githubDeps.octokit as any, githubDeps.issueContext, githubDeps.commentId, {
          runId: githubDeps.runId,
          status: "running",
          completedStages: ["agent_executing", "validating", "collecting_output"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to update progress comment (output stage): ${msg}`);
      }
    }

    // 10. Now close session
    await session.close();

    logger.info("worker", `Agent finished: status=${agentResult!.status}, duration=${agentResult!.durationMs}ms`);
    if (agentResult!.status === "failed" && agentResult!.stderr) {
      logger.warn("worker", `Agent stderr: ${agentResult!.stderr.slice(0, 1000)}`);
    }
  } catch (err) {
    if (err instanceof UsageLimitError) {
      // Re-throw so the dispatcher can handle recovery
      throw err;
    }
    if (err instanceof BudgetExceededError) {
      logger.error("worker", `Cost ceiling exceeded for ${issue.identifier}: ${err.message}`);
      agentResult = {
        stdout: "",
        stderr: `cost_ceiling_exceeded: ${err.message}`,
        status: "failed",
        tokenUsage: agentResult?.tokenUsage ?? { input: 0, output: 0, total: 0 },
        durationMs: agentResult?.durationMs ?? 0,
        turnCount: agentResult?.turnCount ?? 0,
      };

      // Record cost to DB before aborting
      const tu = agentResult.tokenUsage;
      if (costRepo && (tu.input > 0 || tu.output > 0)) {
        const costUsd = (tu.input * 3 + tu.output * 15) / 1_000_000;
        try {
          costRepo.insert({
            runId: githubDeps?.runId ?? plan.runId,
            agentType: config.agent.type,
            model: config.agent.model,
            inputTokens: tu.input,
            outputTokens: tu.output,
            costUsd,
            timestamp: new Date().toISOString(),
          });
        } catch { /* best-effort */ }
      }

      // Update run status to cost_ceiling_exceeded
      if (runRepo) {
        try {
          const runId = githubDeps?.runId ?? plan.runId;
          runRepo.updateStatus(runId, {
            status: "cost_ceiling_exceeded",
            completedAt: new Date().toISOString(),
            error: err.message,
          });
        } catch { /* best-effort */ }
      }

      costCeilingExceeded = true;

      emitRunEvent({
        runId: plan.runId,
        type: "failed",
        timestamp: new Date().toISOString(),
        data: { reason: "cost_ceiling_exceeded", error: err.message },
      });

      if (alertManager) {
        const alertEvt: AlertEvent = {
          type: "cost_ceiling_hit",
          timestamp: new Date().toISOString(),
          runId: githubDeps?.runId ?? plan.runId,
          issueIdentifier: issue.identifier,
          message: `Cost ceiling exceeded for ${issue.identifier}: ${err.message}`,
        };
        alertManager.fire(alertEvt).catch(() => {});
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error("worker", `Agent execution failed for ${issue.identifier}: ${message}`);
      if (stack) logger.debug("worker", `Stack trace: ${stack}`);
      agentResult = {
        stdout: "",
        stderr: `Infrastructure error (not agent): ${message}`,
        status: "failed",
        tokenUsage: { input: 0, output: 0, total: 0 },
        durationMs: 0,
        turnCount: 0,
      };
    }
  }

  // 11. Build structured result comment using github/comments.ts
  const runResult = toRunResult(
    githubDeps?.runId ?? "unknown",
    agentResult,
    agentResult.durationMs,
    validationResult,
    branch,
    "orchestrated",
  );
  const comment = buildGHResultComment(runResult);

  // Complete check run at worker end
  if (checkRunId && githubDeps?.repoContext) {
    try {
      const success = agentResult.status === "completed" &&
        (!validationResult || validationResult.passed);
      const checkSummary = buildCheckSummary(runResult);
      await completeCheckRun(
        githubDeps.octokit as any,
        githubDeps.repoContext.owner,
        githubDeps.repoContext.repo,
        checkRunId,
        success,
        checkSummary,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("worker", `Failed to complete check run: ${msg}`);
    }
  }

  // Create PR and set description when branch and GitHub context available
  if (githubDeps?.repoContext && branch) {
    const prSpan = traceId ? createSpan(traceId, "pr_creation", rootSpan?.spanId) : undefined;
    try {
      const prData: PRDescriptionData = {
        issueNumber: githubDeps.issueContext.issueNumber,
        changes: runResult.changes ?? [],
        validationResults: runResult.validationResults?.map((v) => ({ step: v.step, passed: v.passed })) ?? [],
        cost: runResult.cost
          ? {
              estimated_usd: runResult.cost.estimated_usd ?? "$0",
              input_tokens: runResult.cost.input_tokens ?? 0,
              output_tokens: runResult.cost.output_tokens ?? 0,
            }
          : { estimated_usd: "$0", input_tokens: 0, output_tokens: 0 },
        workflow: runResult.workflow ?? "orchestrated",
        agent: runResult.agent ?? "unknown",
      };
      // Create PR if it doesn't exist, then update description
      const prNumber = await createPRForBranch(
        githubDeps.octokit as any,
        githubDeps.repoContext.owner,
        githubDeps.repoContext.repo,
        branch,
        issue.title,
        prData,
      );
      if (prNumber != null) {
        prUrl = `https://github.com/${githubDeps.repoContext.owner}/${githubDeps.repoContext.repo}/pull/${prNumber}`;
      }
      if (prSpan) persistSpan(traceRepo, endSpan(prSpan, "ok"));
    } catch (err) {
      if (prSpan) persistSpan(traceRepo, endSpan(prSpan, "error"));
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("worker", `Failed to update PR description: ${msg}`);
    }
  }

  // Update progress comment in-place with final result
  if (githubDeps) {
    try {
      await updateProgressComment(githubDeps.octokit as any, githubDeps.issueContext, githubDeps.commentId, {
        runId: githubDeps.runId,
        status: agentResult.status === "completed" ? "completed" : "failed",
        completedStages: ["agent_executing", "validating", "collecting_output"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("worker", `Failed to update final progress comment: ${msg}`);
    }
  }

  // 11.5. Post Linear comment if tracker is available and comments are enabled
  if (tracker && config.tracker?.comments_enabled !== false) {
    const commentEvents = config.tracker?.comment_events ?? ["completed", "failed", "timeout", "aborted"];
    const statusMap: Record<string, RunCommentData["status"]> = {
      completed: "success",
      failed: "failure",
      timeout: "timeout",
      aborted: "aborted",
    };
    const commentStatus: RunCommentData["status"] = statusMap[agentResult.status] ?? "failure";

    if (shouldPostComment(commentStatus, commentEvents)) {
      let costUsd: number | undefined;
      if (costRepo && githubDeps?.runId) {
        try {
          const summary = costRepo.sumByRunId(githubDeps.runId);
          if (summary.totalCostUsd > 0) costUsd = summary.totalCostUsd;
        } catch { /* best-effort */ }
      }
      if (costUsd == null && agentResult.tokenUsage) {
        costUsd = (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000;
      }

      // For failed runs, generate summary before posting comment so it can be included
      let runSummaryForComment: import("../storage/repositories/runs.js").RunSummary | undefined;
      const summaryRunId = githubDeps?.runId ?? plan.runId;
      if (commentStatus !== "success" && eventRepo && costRepo && runRepo) {
        try {
          runSummaryForComment = await generateRunSummary(summaryRunId, eventRepo, costRepo);
          runRepo.setSummary(summaryRunId, runSummaryForComment);
          logger.info("worker", `Run summary stored for ${summaryRunId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("worker", `Failed to generate run summary for ${summaryRunId}: ${msg}`);
        }
      }

      const runCommentData: RunCommentData = {
        runId: githubDeps?.runId ?? "unknown",
        issueIdentifier: issue.identifier,
        status: commentStatus,
        durationMs: agentResult.durationMs,
        tokenUsage: agentResult.tokenUsage
          ? { input: agentResult.tokenUsage.input, output: agentResult.tokenUsage.output }
          : undefined,
        costUsd,
        prUrl,
        validationResults: validationResult?.stepResults?.map((sr) => ({
          name: sr.name,
          passed: sr.passed,
          attempts: sr.attempts ?? 1,
        })),
        errorSummary: agentResult.status !== "completed"
          ? agentResult.stderr
          : undefined,
        branch,
        runSummary: runSummaryForComment,
      };

      const formattedComment = formatRunComment(runCommentData);
      try {
        await tracker.postComment(issue.id, formattedComment);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to post Linear comment for ${issue.identifier}: ${msg}`);
      }
    }
  }

  // 12. Run after hook (catch and log errors)
  try {
    await workspaceManager.runAfterHook(workspaceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `After hook failed for ${issue.identifier} (ignored): ${message}`);
  }

  // 13. Cleanup container (but not workspace — tempDirs is empty)
  try {
    await cleanupRun(cleanup);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `Cleanup failed for ${issue.identifier} (ignored): ${message}`);
  }

  // Fire-and-forget: generate LLM summary for successful runs (failed runs already generated above)
  const summaryRunId = githubDeps?.runId ?? plan.runId;
  if (eventRepo && costRepo && runRepo && agentResult.status === "completed") {
    generateRunSummary(summaryRunId, eventRepo, costRepo)
      .then((summary) => {
        runRepo.setSummary(summaryRunId, summary);
        logger.info("worker", `Run summary stored for ${summaryRunId}`);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("worker", `Failed to generate run summary for ${summaryRunId}: ${msg}`);
      });
  }

  if (alertManager) {
    const alertEvt: AlertEvent = {
      type: agentResult.status === "completed" ? "run_completed" : "run_failed",
      timestamp: new Date().toISOString(),
      runId: githubDeps?.runId ?? plan.runId,
      issueIdentifier: issue.identifier,
      message: agentResult.status === "completed"
        ? `Run completed for ${issue.identifier}`
        : `Run failed for ${issue.identifier}: ${agentResult.stderr?.slice(0, 200) ?? "unknown error"}`,
    };
    alertManager.fire(alertEvt).catch(() => {});
  }

  // End root trace span
  if (rootSpan) {
    persistSpan(traceRepo, endSpan(rootSpan, agentResult.status === "completed" ? "ok" : "error"));
  }

  return { agentResult, comment, validationResult, lintIterations, branch, diffStat, pendingApproval: pendingApproval || undefined, reviewOutput, costCeilingExceeded: costCeilingExceeded || undefined };
}
