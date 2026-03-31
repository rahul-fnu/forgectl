import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult, DurabilityDeps } from "./single.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { TraceRepository } from "../storage/repositories/traces.js";
import { executeSingleAgent } from "./single.js";
import { executeReviewMode } from "./review.js";
import { generateTraceId, createSpan, endSpan } from "../tracing/context.js";
import type { Span } from "../tracing/context.js";

/** Optional outcome logging dependency. */
export interface OutcomeDeps {
  outcomeRepo?: OutcomeRepository;
  traceRepo?: TraceRepository;
}

function persistSpan(traceRepo: TraceRepository | undefined, span: Span): void {
  if (!traceRepo) return;
  try {
    traceRepo.insert({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      operationName: span.name,
      startMs: span.startMs,
      durationMs: (span.endMs ?? Date.now()) - span.startMs,
      status: span.status,
    });
  } catch { /* best-effort */ }
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

  const traceRepo = outcomeDeps?.traceRepo;
  const traceId = generateTraceId();
  const rootSpan = createSpan(traceId, "run", null);

  // Store traceId on run record if runRepo is available
  if (deps.runRepo) {
    try { deps.runRepo.setTraceId(plan.runId, traceId); } catch { /* best-effort */ }
  }

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

  persistSpan(traceRepo, endSpan(rootSpan, result.success ? "ok" : "error"));

  if (outcomeDeps?.outcomeRepo) {
    try {
      // Determine failure mode from result context
      let failureMode: string | undefined;
      if (!result.success) {
        if (result.validation.loopDetected) {
          failureMode = "loop_detected";
        } else if (result.error?.includes("Lint gate failed")) {
          failureMode = "lint";
        } else if (result.error?.includes("Review not approved") || result.review?.escalatedToHuman) {
          failureMode = "review";
        } else {
          failureMode = "validation";
        }
      }

      // Collect review comments JSON from either review summary or top-level
      const commentsJson = result.review?.reviewCommentsJson ?? result.reviewCommentsJson;

      outcomeDeps.outcomeRepo.insert({
        id: plan.runId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: result.success ? "success" : "failure",
        lintIterations: result.validation.totalAttempts || undefined,
        reviewRounds: result.review?.totalRounds ?? undefined,
        reviewCommentsJson: commentsJson,
        failureMode,
        failureDetail: result.error?.slice(0, 2000),
        filesChanged: result.output?.mode === "git" ? result.output.filesChanged : undefined,
        contextEnabled: plan.noContext ? 0 : 1,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("outcome", `Failed to record outcome for run ${plan.runId}: ${msg}`);
    }
  }

  return result;
}
