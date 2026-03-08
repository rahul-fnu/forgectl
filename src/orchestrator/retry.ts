import type { AgentStatus } from "../agent/session.js";
import type { OrchestratorState } from "./state.js";

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
 */
export function scheduleRetry(
  issueId: string,
  delayMs: number,
  callback: () => void,
  state: OrchestratorState,
): void {
  // Cancel existing timer if present
  cancelRetry(issueId, state);

  const timer = setTimeout(callback, delayMs);
  state.retryTimers.set(issueId, timer);
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
