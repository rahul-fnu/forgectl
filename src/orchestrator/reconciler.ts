import type { TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import { releaseIssue } from "./state.js";
import { cleanupRun } from "../container/cleanup.js";
import { scheduleRetry, calculateBackoff } from "./retry.js";

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
        await worker.session.close();
        await cleanupRun(worker.cleanup);
        await workspaceManager.removeWorkspace(worker.identifier);
        state.running.delete(issueId);
        releaseIssue(state, issueId);
      } else if (!activeStates.has(currentState)) {
        // Non-active, non-terminal — cleanup but keep workspace
        logger.info("reconciler", `Issue ${worker.identifier} in non-active state (${currentState}). Stopping worker.`);
        await worker.session.close();
        await cleanupRun(worker.cleanup);
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
        await worker.session.close();
        await cleanupRun(worker.cleanup);
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
