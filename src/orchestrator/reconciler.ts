import type { TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { DelegationRepository } from "../storage/repositories/delegations.js";
import type { DelegationManager, SubtaskSpec } from "./delegation.js";
import { releaseIssue } from "./state.js";
import { cleanupRun } from "../container/cleanup.js";
import { scheduleRetry, calculateBackoff } from "./retry.js";

/** Run a promise with a timeout. Resolves even if the promise hangs. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, logger: Logger): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("reconciler", `${label} timed out after ${ms}ms — continuing`);
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

const CLEANUP_TIMEOUT_MS = 15_000; // 15s max for session close + container cleanup

/**
 * Reconcile running workers against tracker state.
 *
 * For each running worker:
 * - Terminal state: close session, cleanup container, remove workspace, release
 * - Non-active/non-terminal state: close session, cleanup container, release (no workspace removal)
 * - Active state: update issue state in memory
 *
 * Also detects stalled workers (no activity past stall_timeout_ms).
 */
export async function reconcile(
  state: OrchestratorState,
  tracker: TrackerAdapter,
  workspaceManager: WorkspaceManager,
  config: ForgectlConfig,
  logger: Logger,
): Promise<void> {
  if (state.running.size === 0) {
    return;
  }

  const runningIds = [...state.running.keys()];
  const orchestratorConfig = config.orchestrator;
  const trackerConfig = config.tracker;

  // Fetch current states — on failure, keep all workers running
  let issueStates: Map<string, string>;
  try {
    issueStates = await tracker.fetchIssueStatesByIds(runningIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("reconciler", `Failed to fetch issue states: ${msg}. Keeping all workers running.`);
    return;
  }

  const activeStates = new Set(trackerConfig!.active_states);
  const terminalStates = new Set(trackerConfig!.terminal_states);

  // State reconciliation loop
  for (const issueId of runningIds) {
    const worker = state.running.get(issueId);
    if (!worker) continue;

    const currentState = issueStates.get(issueId);
    if (currentState === undefined) continue; // No state data, skip

    try {
      if (terminalStates.has(currentState)) {
        // Terminal state — full cleanup including workspace
        logger.info("reconciler", `Issue ${worker.identifier} reached terminal state (${currentState}). Cleaning up.`);
        await withTimeout(
          (async () => {
            if (worker.session) await worker.session.close();
            await cleanupRun(worker.cleanup);
          })(),
          CLEANUP_TIMEOUT_MS,
          `Cleanup for ${worker.identifier}`,
          logger,
        );
        await workspaceManager.removeWorkspace(worker.identifier);
        state.running.delete(issueId);
        releaseIssue(state, issueId);
      } else if (!activeStates.has(currentState)) {
        // Non-active, non-terminal — cleanup but keep workspace
        logger.info("reconciler", `Issue ${worker.identifier} in non-active state (${currentState}). Stopping worker.`);
        await withTimeout(
          (async () => {
            if (worker.session) await worker.session.close();
            await cleanupRun(worker.cleanup);
          })(),
          CLEANUP_TIMEOUT_MS,
          `Cleanup for ${worker.identifier}`,
          logger,
        );
        state.running.delete(issueId);
        releaseIssue(state, issueId);
      } else {
        // Active state — update snapshot
        worker.issue.state = currentState;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("reconciler", `Error reconciling worker for ${worker.identifier}: ${msg}`);
    }
  }

  // Stall detection loop (separate from state reconciliation)
  const now = Date.now();
  for (const [issueId, worker] of [...state.running.entries()]) {
    const elapsed = now - worker.lastActivityAt;
    if (elapsed > orchestratorConfig.stall_timeout_ms) {
      logger.warn(
        "reconciler",
        `Stall detected for ${worker.identifier}: no activity for ${Math.round(elapsed / 1000)}s (threshold: ${orchestratorConfig.stall_timeout_ms / 1000}s)`,
      );

      try {
        await withTimeout(
          (async () => {
            if (worker.session) await worker.session.close();
            await cleanupRun(worker.cleanup);
          })(),
          CLEANUP_TIMEOUT_MS,
          `Stall cleanup for ${worker.identifier}`,
          logger,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("reconciler", `Error cleaning up stalled worker ${worker.identifier}: ${msg}`);
      }

      state.running.delete(issueId);

      // Handle retry for stalled worker
      const currentAttempts = (state.retryAttempts.get(issueId) ?? 0) + 1;
      state.retryAttempts.set(issueId, currentAttempts);

      if (currentAttempts >= orchestratorConfig.max_retries) {
        logger.warn("reconciler", `Max retries exhausted for stalled ${worker.identifier}`);
        releaseIssue(state, issueId);
      } else {
        const delay = calculateBackoff(currentAttempts, orchestratorConfig.max_retry_backoff_ms);
        scheduleRetry(
          issueId,
          delay,
          () => {
            releaseIssue(state, issueId);
          },
          state,
        );
      }
    }
  }
}

/**
 * Recover in-flight delegations after a daemon restart.
 *
 * - 'running' rows: were interrupted mid-execution — mark as failed
 * - 'pending' rows: were queued but never started — group by parentRunId and re-dispatch
 *
 * Recovery is non-fatal: errors are caught and logged as warnings.
 */
export async function recoverDelegations(
  delegationRepo: DelegationRepository,
  delegationManager: DelegationManager,
  _tracker: TrackerAdapter,
  logger: Logger,
): Promise<{ recovered: number; failed: number; redispatched: number }> {
  const allRows = delegationRepo.list();
  const inFlight = allRows.filter((r) => r.status === "pending" || r.status === "running");

  if (inFlight.length === 0) {
    return { recovered: inFlight.length, failed: 0, redispatched: 0 };
  }

  let failedCount = 0;
  let redispatchedCount = 0;

  // Mark running rows as failed (they were interrupted by daemon crash)
  const runningRows = inFlight.filter((r) => r.status === "running");
  for (const row of runningRows) {
    try {
      delegationRepo.updateStatus(row.id, "failed", {
        lastError: "daemon restart — execution interrupted",
      });
      failedCount++;
    } catch (err) {
      logger.warn(
        "reconciler",
        `Failed to mark running delegation ${row.id} as failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Group pending rows by parentRunId for batch re-dispatch
  const pendingRows = inFlight.filter((r) => r.status === "pending");
  const byParent = new Map<string, typeof pendingRows>();
  for (const row of pendingRows) {
    const existing = byParent.get(row.parentRunId) ?? [];
    existing.push(row);
    byParent.set(row.parentRunId, existing);
  }

  const parentCount = byParent.size;

  logger.info(
    "reconciler",
    `Delegation recovery: ${inFlight.length} in-flight delegations for ${parentCount} parents. ` +
    `${runningRows.length} marked failed (interrupted), ${pendingRows.length} pending for re-dispatch.`,
  );

  // Re-dispatch pending children per parent
  for (const [parentRunId, rows] of byParent.entries()) {
    try {
      // Reconstruct SubtaskSpecs from stored taskSpec JSON
      const maybeSpecs = rows.map((r) => {
        const spec = r.taskSpec as Record<string, unknown>;
        if (!spec || typeof spec.id !== "string" || typeof spec.task !== "string") {
          return null;
        }
        const result: SubtaskSpec = {
          id: spec.id,
          task: spec.task,
          workflow: typeof spec.workflow === "string" ? spec.workflow : undefined,
          agent: typeof spec.agent === "string" ? spec.agent : undefined,
        };
        return result;
      });
      const specs: SubtaskSpec[] = maybeSpecs.filter((s): s is SubtaskSpec => s !== null);

      if (specs.length === 0) {
        logger.warn("reconciler", `No valid specs for parent ${parentRunId} — skipping re-dispatch`);
        continue;
      }

      // Reconstruct a minimal parentIssue from the first row's parentRunId
      // We use parentRunId as the issue id for posting the synthesis comment
      const parentIssue = {
        id: parentRunId,
        identifier: parentRunId,
        title: `Recovered delegation (${parentRunId})`,
        description: "",
        state: "open",
        priority: null,
        labels: [],
        assignees: [],
        url: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        blocked_by: [],
        metadata: { recovered: true },
      };

      await delegationManager.runDelegation(parentRunId, parentIssue, specs, 0, specs.length);
      redispatchedCount += specs.length;
    } catch (err) {
      logger.warn(
        "reconciler",
        `Failed to re-dispatch delegation for parent ${parentRunId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { recovered: inFlight.length, failed: failedCount, redispatched: redispatchedCount };
}
