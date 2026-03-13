import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { IssueContext, RepoContext } from "../github/types.js";
import type { GitHubDeps } from "./worker.js";
import { claimIssue, releaseIssue } from "./state.js";
import { classifyFailure, calculateBackoff, scheduleRetry } from "./retry.js";
import { executeWorker } from "./worker.js";
import { createProgressComment } from "../github/comments.js";
import { emitRunEvent } from "../logging/events.js";
import { needsPreApproval } from "../governance/autonomy.js";
import { enterPendingApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";

/** GitHub context passed from webhook handler (octokit + repo). */
export interface GitHubContext {
  octokit: unknown;
  repo: RepoContext;
}

/** Optional governance context for pre-execution approval gate. */
export interface GovernanceOpts {
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  runRepo?: RunRepository;
  runId?: string;
}

/**
 * Extract a numeric priority from issue priority field and labels.
 * Supports P0-P4 labels, priority:critical/high/medium/low labels, and numeric priority field.
 * Returns Infinity if no priority can be determined.
 */
export function extractPriorityNumber(priority: string | null, labels: string[]): number {
  // Check direct priority field (numeric string)
  if (priority !== null && priority !== "") {
    const parsed = Number(priority);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  // Check labels for P0/P1/P2/P3/P4 pattern
  for (const label of labels) {
    const pMatch = /^P(\d)$/i.exec(label);
    if (pMatch) {
      return Number(pMatch[1]);
    }
  }

  // Check labels for priority:critical/high/medium/low pattern
  const priorityMap: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  for (const label of labels) {
    const colonMatch = /^priority:(\w+)$/i.exec(label);
    if (colonMatch) {
      const level = colonMatch[1].toLowerCase();
      if (level in priorityMap) {
        return priorityMap[level];
      }
    }
  }

  return Infinity;
}

/**
 * Filter candidate issues by excluding those that are:
 * - Already claimed
 * - Already running
 * - Blocked by non-terminal issues
 */
export function filterCandidates(
  candidates: TrackerIssue[],
  state: OrchestratorState,
  terminalIssueIds: Set<string>,
  doneLabel?: string,
): TrackerIssue[] {
  return candidates.filter((issue) => {
    // Exclude already claimed
    if (state.claimed.has(issue.id)) return false;

    // Exclude already running
    if (state.running.has(issue.id)) return false;

    // Exclude issues already marked as done
    if (doneLabel && issue.labels.includes(doneLabel)) return false;

    // Exclude if any blocker is not terminal
    if (issue.blocked_by.length > 0) {
      const allBlockersTerminal = issue.blocked_by.every((blockerId) =>
        terminalIssueIds.has(blockerId),
      );
      if (!allBlockersTerminal) return false;
    }

    return true;
  });
}

/**
 * Sort candidate issues by priority (ascending), then by created_at (oldest first),
 * then by identifier (alphabetical) as final tiebreaker.
 */
export function sortCandidates(issues: TrackerIssue[]): TrackerIssue[] {
  return [...issues].sort((a, b) => {
    const priorityA = extractPriorityNumber(a.priority, a.labels);
    const priorityB = extractPriorityNumber(b.priority, b.labels);

    if (priorityA !== priorityB) return priorityA - priorityB;

    // Tiebreak by created_at (oldest first)
    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    if (timeA !== timeB) return timeA - timeB;

    // Final tiebreak by identifier
    return a.identifier.localeCompare(b.identifier);
  });
}

/**
 * Dispatch an issue: claim it, start a worker in the background,
 * and handle completion with retry logic.
 */
export function dispatchIssue(
  issue: TrackerIssue,
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  logger: Logger,
  metrics: MetricsCollector,
  governance?: GovernanceOpts,
  githubContext?: GitHubContext,
): void {
  // Claim issue — if already claimed, skip
  if (!claimIssue(state, issue.id)) {
    return;
  }

  const orchestratorConfig = config.orchestrator;

  // Best-effort label update
  tracker
    .updateLabels(issue.id, [orchestratorConfig.in_progress_label], [])
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to add in_progress label for ${issue.identifier}: ${msg}`);
    });

  // Fire-and-forget worker execution
  void executeWorkerAndHandle(
    issue,
    state,
    tracker,
    config,
    workspaceManager,
    promptTemplate,
    logger,
    metrics,
    governance,
    githubContext,
  );
}

async function executeWorkerAndHandle(
  issue: TrackerIssue,
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  logger: Logger,
  metrics: MetricsCollector,
  governance?: GovernanceOpts,
  githubContext?: GitHubContext,
): Promise<void> {
  const orchestratorConfig = config.orchestrator;
  const attempt = (state.retryAttempts.get(issue.id) ?? 0) + 1;

  // Activity callback for stall detection
  const onActivity = (): void => {
    const worker = state.running.get(issue.id);
    if (worker) {
      worker.lastActivityAt = Date.now();
    }
  };

  // Add WorkerInfo to running map
  const startedAt = Date.now();
  state.running.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    issue,
    session: null, // Session is managed inside executeWorker
    cleanup: { tempDirs: [], secretCleanups: [] },
    startedAt,
    lastActivityAt: Date.now(),
    attempt,
  });

  // Record dispatch metrics and emit SSE event
  metrics.recordDispatch(issue.id, issue.identifier);
  emitRunEvent({
    runId: "orchestrator",
    type: "dispatch",
    timestamp: new Date().toISOString(),
    data: { issueId: issue.id, identifier: issue.identifier, attempt },
  });

  // --- Pre-execution approval gate ---
  const autonomy = governance?.autonomy ?? "full";
  if (needsPreApproval(autonomy)) {
    // Check auto-approve bypass
    const autoApproveCtx = {
      labels: issue.labels,
      workflowName: promptTemplate, // best available workflow identifier
    };
    if (governance?.autoApprove && evaluateAutoApprove(governance.autoApprove, autoApproveCtx)) {
      logger.info("dispatcher", `Auto-approved pre-gate for ${issue.identifier}`);
    } else if (governance?.runRepo && governance?.runId) {
      // Gate the run: enter pending_approval and return early
      enterPendingApproval(governance.runRepo, governance.runId);
      emitRunEvent({
        runId: "orchestrator",
        type: "approval_required",
        timestamp: new Date().toISOString(),
        data: { issueId: issue.id, identifier: issue.identifier, autonomy },
      });
      logger.info("dispatcher", `Run ${issue.identifier} requires pre-approval (autonomy=${autonomy})`);
      state.running.delete(issue.id);
      return;
    } else {
      logger.warn("dispatcher", `Pre-approval needed for ${issue.identifier} but no runRepo available, proceeding`);
    }
  }

  // --- Construct GitHubDeps if GitHub context is available ---
  let githubDeps: GitHubDeps | undefined;
  if (githubContext) {
    const issueContext: IssueContext = {
      ...githubContext.repo,
      issueNumber: Number(issue.id),
    };
    const runId = issue.identifier;
    let commentId = 0;

    // Create initial progress comment (best-effort)
    try {
      commentId = await createProgressComment(githubContext.octokit as any, issueContext, {
        runId,
        status: "started",
        completedStages: [],
      });
      // Persist commentId if runRepo is available
      if (governance?.runRepo) {
        try {
          governance.runRepo.setGithubCommentId(runId, commentId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to persist commentId for ${issue.identifier}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to create progress comment for ${issue.identifier}: ${msg}`);
    }

    githubDeps = {
      octokit: githubContext.octokit as any,
      issueContext,
      commentId,
      runId,
      repoContext: githubContext.repo,
    };
  }

  // --- Insert run record for governance state machine ---
  let governanceWithRunId = governance;
  if (governance?.runRepo) {
    const runId = issue.identifier;
    try {
      governance.runRepo.insert({
        id: runId,
        task: promptTemplate,
        workflow: "orchestrated",
        status: "running",
        submittedAt: new Date().toISOString(),
      });
      governanceWithRunId = { ...governance, runId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to insert run record for ${issue.identifier}: ${msg}`);
    }
  }

  try {
    const result = await executeWorker(
      issue,
      config,
      workspaceManager,
      promptTemplate,
      attempt,
      logger,
      onActivity,
      undefined,
      githubDeps,
      governanceWithRunId,
    );

    // Remove from running
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);

    // Post comment (best-effort)
    tracker.postComment(issue.id, result.comment).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to post comment for ${issue.identifier}: ${msg}`);
    });

    // Create PR if branch exists and tracker supports it
    if (result.branch && tracker.createPullRequest) {
      tracker.createPullRequest(
        result.branch,
        `[forgectl] ${issue.title}`,
        `Closes #${issue.id}\n\nAutomated changes by forgectl for ${issue.identifier}.`,
      ).then((prUrl) => {
        if (prUrl) logger.info("dispatcher", `PR created for ${issue.identifier}: ${prUrl}`);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to create PR for ${issue.identifier}: ${msg}`);
      });
    }

    // Classify failure and handle retry
    const failureType = classifyFailure(result.agentResult.status);

    // Record completion metrics
    const tokenUsage = result.agentResult.tokenUsage ?? { input: 0, output: 0, total: 0 };
    metrics.recordCompletion(
      issue.id,
      tokenUsage,
      runtimeMs,
      failureType === "continuation" ? "completed" : "failed",
    );

    if (failureType === "continuation") {
      // Auto-close issue when configured
      if (config.tracker?.auto_close) {
        tracker.updateState(issue.id, "closed").catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to auto-close ${issue.identifier}: ${msg}`);
        });
      }

      // Add done label when configured
      if (config.tracker?.done_label) {
        tracker.updateLabels(issue.id, [config.tracker.done_label], [orchestratorConfig.in_progress_label]).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to add done label for ${issue.identifier}: ${msg}`);
        });
      }

      // Re-dispatch after short delay
      scheduleRetry(
        issue.id,
        orchestratorConfig.continuation_delay_ms,
        () => {
          releaseIssue(state, issue.id);
        },
        state,
      );
    } else {
      // Error — check retry budget
      const currentAttempts = (state.retryAttempts.get(issue.id) ?? 0) + 1;
      state.retryAttempts.set(issue.id, currentAttempts);

      if (currentAttempts >= orchestratorConfig.max_retries) {
        // Exhausted — release and clean up
        logger.warn(
          "dispatcher",
          `Max retries exhausted for ${issue.identifier} after ${currentAttempts} attempts`,
        );

        // Post failure comment (best-effort)
        tracker
          .postComment(
            issue.id,
            `Max retries (${orchestratorConfig.max_retries}) exhausted. Releasing issue.`,
          )
          .catch(() => {});

        // Remove in_progress label (best-effort)
        tracker
          .updateLabels(issue.id, [], [orchestratorConfig.in_progress_label])
          .catch(() => {});

        releaseIssue(state, issue.id);
      } else {
        // Schedule error retry with backoff
        const delay = calculateBackoff(
          currentAttempts,
          orchestratorConfig.max_retry_backoff_ms,
        );
        metrics.recordRetry(issue.id);
        emitRunEvent({
          runId: "orchestrator",
          type: "orch_retry",
          timestamp: new Date().toISOString(),
          data: { issueId: issue.id, identifier: issue.identifier, attempt: currentAttempts, delayMs: delay },
        });
        scheduleRetry(
          issue.id,
          delay,
          () => {
            releaseIssue(state, issue.id);
          },
          state,
        );
      }
    }
  } catch (err) {
    // Unexpected error in worker
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);
    metrics.recordCompletion(issue.id, { input: 0, output: 0, total: 0 }, runtimeMs, "failed");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("dispatcher", `Unexpected worker error for ${issue.identifier}: ${msg}`);
    releaseIssue(state, issue.id);
  }
}
