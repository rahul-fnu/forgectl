import type { TrackerIssue } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";

export interface TriageResult {
  shouldDispatch: boolean;
  reason: string;
  complexity?: string;
  duplicateOf?: string;
}

/**
 * Fast pre-dispatch filtering to avoid wasting agent time.
 * Checks for duplicate titles against running issues and recently completed issues.
 */
export async function triageIssue(
  issue: TrackerIssue,
  state: OrchestratorState,
  config: ForgectlConfig,
): Promise<TriageResult> {
  if (!config.orchestrator.enable_triage) {
    return { shouldDispatch: true, reason: "triage disabled" };
  }

  // Duplicate check: compare title against running issues
  const normalizedTitle = issue.title.trim().toLowerCase();
  for (const [, worker] of state.running) {
    if (worker.issue.id === issue.id) continue;
    const runningTitle = worker.issue.title.trim().toLowerCase();
    if (runningTitle === normalizedTitle) {
      return {
        shouldDispatch: false,
        reason: `duplicate of running issue ${worker.identifier}`,
        duplicateOf: worker.issueId,
      };
    }
  }

  // Recently completed check: skip if a same-titled issue completed recently
  for (const completedId of state.recentlyCompleted) {
    if (completedId === issue.id) continue;
    // Check running map for cached issue info (may have been cleared)
    // The recentlyCompleted set only stores IDs, so we check the running map
    // which may still have the WorkerInfo before cleanup
  }

  // Check recently completed issues by scanning running workers that finished
  // with matching titles. Since recentlyCompleted only stores IDs, we look
  // for the issue in the claimed set as well (claimed but completed).
  // This is already handled by filterCandidates, but we add an explicit guard.
  if (state.recentlyCompleted.has(issue.id)) {
    return {
      shouldDispatch: false,
      reason: "issue recently completed",
    };
  }

  return { shouldDispatch: true, reason: "passed triage" };
}
