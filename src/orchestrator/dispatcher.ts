import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import type { RetryRepository } from "../storage/repositories/retries.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { IssueContext, RepoContext } from "../github/types.js";
import type { GitHubDeps } from "./worker.js";
import type { DelegationManager } from "./delegation.js";
import type { SubIssueCache } from "../tracker/sub-issue-cache.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { EventRepository } from "../storage/repositories/events.js";
import { claimIssue, releaseIssue } from "./state.js";
import { classifyFailure, calculateBackoff, scheduleRetry, cleanupRetryRecords } from "./retry.js";
import { executeWorker } from "./worker.js";
import { createProgressComment } from "../github/comments.js";
import { emitRunEvent } from "../logging/events.js";
import { needsPreApproval } from "../governance/autonomy.js";
import { enterPendingApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";
import {
  upsertRollupComment,
  buildSubIssueProgressComment,
  allChildrenTerminal,
} from "../github/sub-issue-rollup.js";

/** GitHub context passed from webhook handler (octokit + repo). */
export interface GitHubContext {
  octokit: unknown;
  repo: RepoContext;
}

/** Optional outcome logging dependencies. */
export interface OutcomeDeps {
  outcomeRepo: OutcomeRepository;
  eventRepo?: EventRepository;
}

/** Optional governance context for pre-execution approval gate. */
export interface GovernanceOpts {
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  runRepo?: RunRepository;
  runId?: string;
  costRepo?: CostRepository;
  retryRepo?: RetryRepository;
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
 * Trigger a rollup comment update on the parent issue after a child issue completes.
 *
 * Finds the parent via SubIssueCache.getAllEntries() scan, builds ChildStatus[] from
 * cached childStates, and calls upsertRollupComment. If all children are terminal,
 * adds the forge:synthesize label to the parent.
 *
 * All errors are caught, warned, and swallowed — this never throws.
 */
export async function triggerParentRollup(
  childIssue: TrackerIssue,
  subIssueCache: SubIssueCache,
  tracker: TrackerAdapter,
  githubContext: GitHubContext,
  config: ForgectlConfig,
  logger: Logger,
): Promise<void> {
  const { owner, repo } = githubContext.repo;

  // Find the parent entry by scanning all cache entries
  const allEntries = subIssueCache.getAllEntries();
  const parentEntry = allEntries.find((entry) => entry.childIds.includes(childIssue.id));

  if (!parentEntry) {
    // Not a sub-issue or not in cache — silently skip
    return;
  }

  // Update child state in-place to reflect completion
  parentEntry.childStates.set(childIssue.id, "closed");

  try {
    // Build ChildStatus[] from entry
    const children = parentEntry.childIds.map((childId) => {
      const rawState = parentEntry.childStates.get(childId) ?? "open";
      const mappedState: "completed" | "pending" =
        rawState === "closed" ? "completed" : "pending";
      const url = `https://github.com/${owner}/${repo}/issues/${childId}`;
      const title = childId === childIssue.id ? childIssue.title : `#${childId}`;
      return { id: childId, title, url, state: mappedState };
    });

    const parentIssueNumber = Number(parentEntry.parentId);
    const body = buildSubIssueProgressComment(parentIssueNumber, children);
    await upsertRollupComment(githubContext.octokit as any, owner, repo, parentIssueNumber, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("dispatcher", `Failed to upsert rollup comment for parent ${parentEntry.parentId}: ${msg}`);
    return;
  }

  // Check if all children are now terminal
  const terminalStates = new Set(config.tracker?.terminal_states ?? ["closed"]);
  const allTerminal = allChildrenTerminal(parentEntry.childStates, terminalStates);

  if (allTerminal) {
    // Auto-close the parent epic — all sub-issues are done
    logger.info("dispatcher", `All sub-issues complete for parent #${parentEntry.parentId}, auto-closing`);
    tracker
      .updateState(parentEntry.parentId, "closed")
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to auto-close parent ${parentEntry.parentId}: ${msg}`);
      });
    tracker
      .postComment(parentEntry.parentId, `All sub-issues completed. Auto-closing.`)
      .catch(() => { /* best-effort */ });
  }
}

/**
 * Handle the synthesizer outcome for an issue tagged with forge:synthesize.
 *
 * Success: closes the issue and removes the forge:synthesize label (best-effort).
 * Failure: posts an error comment but does NOT close the issue (parent remains open).
 *
 * All tracker calls are fire-and-forget (.catch()), never throwing.
 */
export function handleSynthesizerOutcome(
  issue: TrackerIssue,
  outcome: "success" | "failure",
  tracker: TrackerAdapter,
  logger: Logger,
): void {
  if (outcome === "success") {
    tracker.updateState(issue.id, "closed").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to close synthesizer parent ${issue.identifier}: ${msg}`);
    });
    tracker.updateLabels(issue.id, [], ["forge:synthesize"]).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to remove forge:synthesize label for ${issue.identifier}: ${msg}`);
    });
  } else {
    tracker
      .postComment(
        issue.id,
        `Synthesizer run failed for ${issue.identifier}. Parent issue remains open.`,
      )
      .catch(() => {});
  }
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
  delegationManager?: DelegationManager,
  subIssueCache?: SubIssueCache,
  skills?: string[],
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string },
  outcomeDeps?: OutcomeDeps,
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
    delegationManager,
    subIssueCache,
    skills,
    validationConfig,
    outcomeDeps,
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
  delegationManager?: DelegationManager,
  subIssueCache?: SubIssueCache,
  skills?: string[],
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string },
  outcomeDeps?: OutcomeDeps,
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
  const slotWeight = config.team?.size ?? 1;
  state.running.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    issue,
    session: null, // Session is managed inside executeWorker
    cleanup: { tempDirs: [], secretCleanups: [] },
    startedAt,
    lastActivityAt: Date.now(),
    attempt,
    slotWeight,
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
      validationConfig,
      githubDeps,
      governanceWithRunId,
      skills,
    );

    // Remove from running
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);

    // --- Delegation hook: check if lead agent output contains a manifest ---
    if (delegationManager) {
      const specs = delegationManager.parseDelegationManifest(result.agentResult.stdout, issue.identifier);
      if (specs && specs.length > 0) {
        const maxChildren = config.orchestrator.child_slots ?? 5;
        const depth = 0; // top-level lead is always depth 0
        delegationManager.runDelegation(issue.identifier, issue, specs, depth, maxChildren).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("dispatcher", `Delegation run error for ${issue.identifier}: ${msg}`);
          },
        );
      }
    }

    // Trigger parent rollup if this issue is a sub-issue (best-effort)
    if (subIssueCache && githubContext) {
      await triggerParentRollup(
        issue,
        subIssueCache,
        tracker,
        githubContext,
        config,
        logger,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Rollup callback error for ${issue.identifier}: ${msg}`);
      });
    }

    // Post comment (best-effort)
    tracker.postComment(issue.id, result.comment).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to post comment for ${issue.identifier}: ${msg}`);
    });

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

    // Persist cost data to run_costs table and emit cost event
    if (governanceWithRunId?.costRepo && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
      const runId = governanceWithRunId.runId ?? issue.identifier;
      const costUsd = (tokenUsage.input * 3 + tokenUsage.output * 15) / 1_000_000;
      try {
        governanceWithRunId.costRepo.insert({
          runId,
          agentType: config.agent.type,
          model: config.agent.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          costUsd,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to insert cost record for ${issue.identifier}: ${msg}`);
      }
      emitRunEvent({
        runId: runId,
        type: "cost",
        timestamp: new Date().toISOString(),
        data: {
          agentType: config.agent.type,
          model: config.agent.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          costUsd,
        },
      });
    }

    // Record outcome for the Outcome Analyzer
    if (outcomeDeps) {
      try {
        const outcomeStatus = failureType === "continuation" ? "success" : "failure";
        let rawEventsJson: string | undefined;
        if (outcomeDeps.eventRepo) {
          const events = outcomeDeps.eventRepo.findByRunId(issue.identifier);
          if (events.length > 0) {
            rawEventsJson = JSON.stringify(events);
          }
        }
        const runId = issue.identifier;
        outcomeDeps.outcomeRepo.insert({
          id: runId,
          taskId: issue.id,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          status: outcomeStatus,
          totalTurns: result.agentResult.turnCount ?? undefined,
          failureMode: outcomeStatus === "failure" ? (result.loopDetected ? "LOOP" : (failureType ?? "unknown")) : undefined,
          failureDetail: outcomeStatus === "failure" ? result.agentResult.stderr?.slice(0, 2000) : undefined,
          rawEventsJson,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to record outcome for ${issue.identifier}: ${msg}`);
      }
    }

    // Create PR (fire-and-forget) — the merge daemon handles merging.
    // Close the issue after successful agent run regardless of merge status.
    let prCreated = false;
    if (result.branch && failureType === "continuation") {
      if (tracker.createPullRequest) {
        try {
          const prUrl = await tracker.createPullRequest(
            result.branch,
            `[forgectl] ${issue.title}`,
            `Closes #${issue.id}\n\nAutomated changes by forgectl for ${issue.identifier}.`,
          );
          if (prUrl) {
            logger.info("dispatcher", `PR created for ${issue.identifier}: ${prUrl}`);
            prCreated = true;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to create PR for ${issue.identifier}: ${msg}`);
        }
      }
    }

    if (failureType === "continuation") {
      // Synthesizer-gated close: if this issue has the forge:synthesize label, it is
      // a synthesizer run. Close the parent and remove the label instead of the
      // normal auto_close / done_label path.
      const isSynthesizerRun = issue.labels.includes("forge:synthesize");

      if (isSynthesizerRun) {
        handleSynthesizerOutcome(issue, "success", tracker, logger);
      } else if (prCreated || !result.branch) {
        // Fire-and-forget: close the issue after PR creation (merge daemon handles merging)
        if (config.tracker?.auto_close) {
          tracker.updateState(issue.id, "closed").catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Failed to auto-close ${issue.identifier}: ${msg}`);
          });
        }

        if (config.tracker?.done_label) {
          tracker.updateLabels(issue.id, [config.tracker.done_label], [orchestratorConfig.in_progress_label]).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Failed to add done label for ${issue.identifier}: ${msg}`);
          });
        }
      } else {
        // PR creation failed — leave issue open
        logger.warn("dispatcher", `Issue ${issue.identifier} completed but PR creation failed — leaving issue open`);
        tracker.postComment(
          issue.id,
          "**forgectl:** Agent completed work but PR could not be created. Issue left open for manual resolution.",
        ).catch(() => {});
        tracker.updateLabels(issue.id, [], [orchestratorConfig.in_progress_label]).catch(() => {});
      }

      logger.info("dispatcher", `Releasing completed issue ${issue.identifier} (id=${issue.id}) from claimed set`);
      cleanupRetryRecords(issue.id, governanceWithRunId?.retryRepo);
      releaseIssue(state, issue.id);
      logger.info("dispatcher", `Post-release: claimed=${state.claimed.size}, running=${state.running.size}`);
    } else {
      // Failure path: if this is a synthesizer run, post error comment and do NOT close parent
      const isSynthesizerFailure = issue.labels.includes("forge:synthesize");
      if (isSynthesizerFailure) {
        handleSynthesizerOutcome(issue, "failure", tracker, logger);
      }
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

        cleanupRetryRecords(issue.id, governanceWithRunId?.retryRepo);
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
          governanceWithRunId?.retryRepo,
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

    // Record outcome for unexpected failures
    if (outcomeDeps) {
      try {
        outcomeDeps.outcomeRepo.insert({
          id: issue.identifier,
          taskId: issue.id,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          status: "failure",
          failureMode: "unexpected_error",
          failureDetail: msg.slice(0, 2000),
        });
      } catch {
        // Best-effort — don't mask the original error
      }
    }

    releaseIssue(state, issue.id);
  }
}
