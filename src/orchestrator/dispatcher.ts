import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import { claimIssue, releaseIssue } from "./state.js";
import { classifyFailure, calculateBackoff, scheduleRetry } from "./retry.js";
import { executeWorker } from "./worker.js";
import { emitRunEvent } from "../logging/events.js";

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
): TrackerIssue[] {
  return candidates.filter((issue) => {
    // Exclude already claimed
    if (state.claimed.has(issue.id)) return false;

    // Exclude already running
    if (state.running.has(issue.id)) return false;

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
    session: null as never, // Session is managed inside executeWorker
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

  try {
    const result = await executeWorker(
      issue,
      config,
      workspaceManager,
      promptTemplate,
      attempt,
      logger,
      onActivity,
    );

    // Remove from running
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);

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
