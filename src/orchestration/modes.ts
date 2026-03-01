import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult } from "./single.js";
import { executeSingleAgent } from "./single.js";
import { executeReviewMode } from "./review.js";

/**
 * Dispatch execution based on orchestration mode.
 */
export async function executeRun(
  plan: RunPlan,
  logger: Logger,
  noCleanup = false
): Promise<ExecutionResult> {
  switch (plan.orchestration.mode) {
    case "single":
      return executeSingleAgent(plan, logger, noCleanup);
    case "review":
      return executeReviewMode(plan, logger, noCleanup);
    case "parallel":
      logger.warn("orchestration", "Parallel mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger, noCleanup);
    default:
      return executeSingleAgent(plan, logger, noCleanup);
  }
}
