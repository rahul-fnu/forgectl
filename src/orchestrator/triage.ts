import type { TrackerIssue } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";

export type TriageComplexity = "low" | "medium" | "high";

export interface TriageResult {
  shouldDispatch: boolean;
  reason: string;
  complexity?: TriageComplexity;
  duplicateOf?: string;
}

/**
 * Estimate issue complexity from title + description heuristics.
 * Uses text length, file reference count, and keyword signals.
 */
export function estimateComplexity(issue: TrackerIssue): TriageComplexity {
  const text = `${issue.title}\n${issue.description}`;
  const len = text.length;

  const fileRefPattern = /(?:src|test|lib|packages?)\/[\w/.=-]+\.(?:ts|js|tsx|jsx|py|rs|go)/g;
  const fileRefs = (text.match(fileRefPattern) ?? []).length;

  const highSignals = /\b(breaking change|migration|redesign|refactor.*across|cross[- ]?cutting|architectural)\b/i;
  if (highSignals.test(text) || fileRefs >= 8 || len > 4000) {
    return "high";
  }

  const lowSignals = /\b(typo|rename|bump|update dep|fix import|lint|format|nit)\b/i;
  if (lowSignals.test(text) && fileRefs <= 2 && len < 800) {
    return "low";
  }

  if (fileRefs <= 3 && len < 1500) {
    return "low";
  }

  return "medium";
}

/**
 * Fast pre-dispatch filtering to avoid wasting agent time.
 * Checks for duplicate titles against running issues, recently completed issues,
 * and estimates complexity.
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

  if (state.recentlyCompleted.has(issue.id)) {
    return {
      shouldDispatch: false,
      reason: "issue recently completed",
    };
  }

  const complexity = estimateComplexity(issue);

  return { shouldDispatch: true, reason: "passed triage", complexity };
}
