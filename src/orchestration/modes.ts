import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult, DurabilityDeps } from "./single.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import { executeSingleAgent } from "./single.js";
import { executeReviewMode } from "./review.js";

/** Optional outcome logging dependency. */
export interface OutcomeDeps {
  outcomeRepo?: OutcomeRepository;
}

/**
 * Dispatch execution based on orchestration mode.
 */
export async function executeRun(
  plan: RunPlan,
  logger: Logger,
  noCleanup = false,
  deps: DurabilityDeps = {},
  outcomeDeps?: OutcomeDeps,
): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString();
  let result: ExecutionResult;

  switch (plan.orchestration.mode) {
    case "single":
      result = await executeSingleAgent(plan, logger, noCleanup, deps);
      break;
    case "review":
      result = await executeReviewMode(plan, logger, noCleanup);
      break;
    case "parallel":
      logger.warn("orchestration", "Parallel mode not yet implemented, running as single agent");
      result = await executeSingleAgent(plan, logger, noCleanup, deps);
      break;
    default:
      result = await executeSingleAgent(plan, logger, noCleanup, deps);
      break;
  }

  if (outcomeDeps?.outcomeRepo) {
    try {
      outcomeDeps.outcomeRepo.insert({
        id: plan.runId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: result.success ? "success" : "failure",
        lintIterations: result.validation.totalAttempts || undefined,
        reviewRounds: result.review?.totalRounds ?? undefined,
        reviewCommentsJson: result.review?.reviewCommentsJson ?? undefined,
        failureMode: result.success ? undefined : "validation",
        failureDetail: result.error?.slice(0, 2000),
        filesChanged: result.output?.mode === "git" ? result.output.filesChanged : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("outcome", `Failed to record outcome for run ${plan.runId}: ${msg}`);
    }
  }

  return result;
}
