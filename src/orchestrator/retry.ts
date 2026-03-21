import type { AgentStatus } from "../agent/session.js";
import type { OrchestratorState } from "./state.js";
import type { RetryRepository } from "../storage/repositories/retries.js";

/**
 * Calculate exponential backoff delay for a retry attempt.
 * Formula: min(10000 * 2^(attempt-1), maxBackoffMs)
 */
export function calculateBackoff(attempt: number, maxBackoffMs: number): number {
  return Math.min(10000 * Math.pow(2, attempt - 1), maxBackoffMs);
}

/**
 * Classify an agent status into a failure type for retry decisions.
 * - "continuation": agent completed but more work may be needed (re-dispatch with short delay)
 * - "error": agent failed or timed out (exponential backoff)
 */
export function classifyFailure(status: AgentStatus): "continuation" | "error" {
  if (status === "completed") {
    return "continuation";
  }
  return "error";
}

/**
 * Schedule a retry for an issue after a delay.
 * Cancels any existing retry timer for the same issue before scheduling.
 * Stores the timer handle in state.retryTimers.
 * Optionally persists retry state to SQLite via retryRepo.
 */
export function scheduleRetry(
  issueId: string,
  delayMs: number,
  callback: () => void,
  state: OrchestratorState,
  retryRepo?: RetryRepository,
  failureReason?: string,
): void {
  // Cancel existing timer if present
  cancelRetry(issueId, state);

  const timer = setTimeout(callback, delayMs);
  state.retryTimers.set(issueId, timer);

  // Persist retry attempt to SQLite if repo available
  if (retryRepo) {
    const attempt = state.retryAttempts.get(issueId) ?? 1;
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    try {
      retryRepo.insert({
        runId: issueId,
        attempt,
        nextRetryAt,
        backoffMs: delayMs,
        failureReason,
      });
    } catch {
      // Best-effort — don't crash the retry flow
    }
  }
}

/**
 * Cancel a pending retry for an issue.
 * Clears the timeout and removes the timer handle from state.
 */
export function cancelRetry(issueId: string, state: OrchestratorState): void {
  const timer = state.retryTimers.get(issueId);
  if (timer !== undefined) {
    clearTimeout(timer);
    state.retryTimers.delete(issueId);
  }
}

/**
 * Clear all pending retry timers.
 */
export function clearAllRetries(state: OrchestratorState): void {
  for (const timer of state.retryTimers.values()) {
    clearTimeout(timer);
  }
  state.retryTimers.clear();
}

/**
 * Restore retry attempt counts from SQLite into in-memory state.
 * Called during startup recovery to survive daemon restarts.
 * Returns the set of runIds that had pending retries.
 */
export function restoreRetryState(
  state: OrchestratorState,
  retryRepo: RetryRepository,
  allRunIds: string[],
): string[] {
  const restoredIds: string[] = [];
  for (const runId of allRunIds) {
    const latest = retryRepo.latestAttempt(runId);
    if (latest > 0) {
      state.retryAttempts.set(runId, latest);
      restoredIds.push(runId);
    }
  }
  return restoredIds;
}

/**
 * Clean up retry records for a completed or abandoned issue.
 */
export function cleanupRetryRecords(
  issueId: string,
  retryRepo?: RetryRepository,
): void {
  if (retryRepo) {
    try {
      retryRepo.deleteByRunId(issueId);
    } catch {
      // Best-effort cleanup
    }
  }
}
