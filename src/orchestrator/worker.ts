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
import { runValidationLoop } from "../validation/runner.js";
import { collectGitOutput } from "../output/git.js";
import { buildResultComment as buildGHResultComment } from "../github/comments.js";
import type { RunResult } from "../github/comments.js";
import type { IssueContext } from "../github/types.js";
import type { RepoContext } from "../github/types.js";
import { updateProgressComment } from "../github/comments.js";
import { createCheckRun, updateCheckRun, completeCheckRun, buildCheckSummary } from "../github/checks.js";
import { updatePRDescriptionForBranch } from "../github/pr-description.js";
import type { PRDescriptionData } from "../github/pr-description.js";
import { renderPromptTemplate, buildTemplateVars } from "../workflow/template.js";
import { parseDuration } from "../utils/duration.js";
import { formatDuration } from "../utils/duration.js";
import type { GovernanceOpts } from "./dispatcher.js";
import { needsPostApproval } from "../governance/autonomy.js";
import { enterPendingOutputApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";

export interface WorkerResult {
  agentResult: AgentResult;
  comment: string;
  executionResult?: ExecutionResult;
  validationResult?: ValidationResult;
  branch?: string;
  pendingApproval?: boolean;
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
  validationConfig?: { steps: ValidationStep[]; on_failure: string },
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
        on_failure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
      },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
      autonomy: "full",
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
      onFailure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
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
  validationConfig?: { steps: ValidationStep[]; on_failure: string },
  githubDeps?: GitHubDeps,
  governance?: GovernanceOpts,
): Promise<WorkerResult> {
  // 1. Ensure workspace exists
  const wsInfo = await workspaceManager.ensureWorkspace(issue.identifier);
  const workspacePath = wsInfo.path;

  // 2. Run before hook
  try {
    await workspaceManager.runBeforeHook(issue.identifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("worker", `Before hook failed for ${issue.identifier}: ${message}`);
    const failResult: AgentResult = {
      stdout: "",
      stderr: message,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
    const failRunResult = toRunResult("unknown", failResult, 0);
    return {
      agentResult: failResult,
      comment: buildGHResultComment(failRunResult),
    };
  }

  // 3. Build RunPlan (with optional validationConfig)
  const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, attempt, validationConfig);

  // 4. Create CleanupContext with empty tempDirs (workspace persists)
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  let agentResult: AgentResult;
  let validationResult: ValidationResult | undefined;
  let branch: string | undefined;
  let checkRunId: number | undefined;
  let pendingApproval = false;

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
    const { container, agentOptions, agentEnv, adapter } = await prepareExecution(plan, logger, cleanup);

    // 6. Create agent session with onActivity callback for stall detection
    const session = createAgentSession(plan.agent.type, container, agentOptions, agentEnv, {
      onActivity,
    });

    // 7. Invoke agent
    logger.info("worker", `Running agent for ${issue.identifier} (attempt ${attempt})`);
    agentResult = await session.invoke(plan.task);

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

    // 8. Run validation loop BEFORE closing session (container must be alive)
    if (plan.validation.steps.length > 0) {
      logger.info("worker", `Running ${plan.validation.steps.length} validation steps for ${issue.identifier}`);
      validationResult = await runValidationLoop(container, plan, adapter, agentOptions, agentEnv, logger);
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

    // 9. Collect git output (non-critical -- catch and log errors)
    try {
      const gitResult = await collectGitOutput(container, plan, logger);
      branch = gitResult.branch;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("worker", `Git output collection failed for ${issue.identifier} (ignored): ${message}`);
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

    // --- Post-execution approval gate ---
    if (governance?.autonomy && needsPostApproval(governance.autonomy) && governance.runRepo && governance.runId) {
      const actualCost = agentResult.tokenUsage
        ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
        : undefined;
      const autoApproveCtx = {
        labels: issue.labels,
        workflowName: plan.workflow.name,
        actualCost,
      };
      if (governance.autoApprove && evaluateAutoApprove(governance.autoApprove, autoApproveCtx)) {
        logger.info("governance", `Auto-approved post-gate for run ${governance.runId}`);
      } else {
        enterPendingOutputApproval(governance.runRepo, governance.runId);
        logger.info("governance", `Run ${governance.runId} requires output approval (autonomy=${governance.autonomy})`);
        pendingApproval = true;
      }
    }

    // 10. Now close session
    await session.close();

    logger.info("worker", `Agent finished: status=${agentResult.status}, duration=${agentResult.durationMs}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("worker", `Agent execution failed for ${issue.identifier}: ${message}`);
    agentResult = {
      stdout: "",
      stderr: message,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
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

  // Generate PR description when branch and GitHub context available
  if (githubDeps?.repoContext && branch) {
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
      await updatePRDescriptionForBranch(
        githubDeps.octokit as any,
        githubDeps.repoContext.owner,
        githubDeps.repoContext.repo,
        branch,
        prData,
      );
    } catch (err) {
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

  // 12. Run after hook (catch and log errors)
  try {
    await workspaceManager.runAfterHook(issue.identifier);
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

  return { agentResult, comment, validationResult, branch, pendingApproval: pendingApproval || undefined };
}
