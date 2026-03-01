import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult } from "./single.js";
import { executeSingleAgent } from "./single.js";

/**
 * Dispatch execution based on orchestration mode.
 * Phase 3 only implements "single". Review and parallel are Phase 5.
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
      logger.warn("orchestration", "Review mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger, noCleanup);
    case "parallel":
      logger.warn("orchestration", "Parallel mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger, noCleanup);
    default:
      return executeSingleAgent(plan, logger, noCleanup);
  }
}
