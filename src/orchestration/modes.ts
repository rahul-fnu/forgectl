import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult, DurabilityDeps } from "./single.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { TraceRepository } from "../storage/repositories/traces.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import { executeSingleAgent } from "./single.js";
import { executeReviewMode } from "./review.js";
import { generateTraceId, createSpan, endSpan } from "../tracing/context.js";
import type { Span } from "../tracing/context.js";
import { predictCost, type CostPrediction } from "../analysis/cost-predictor.js";
import { getModelRate, calculateCost } from "../agent/cost-rates.js";

/** Optional outcome logging dependency. */
export interface OutcomeDeps {
  outcomeRepo?: OutcomeRepository;
  traceRepo?: TraceRepository;
  costRepo?: CostRepository;
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

  // --- Cost prediction before dispatch ---
  const prediction = runCostPrediction(plan, logger, outcomeDeps);
  if (prediction) {
    if (plan.costCeiling?.maxCostUsd && prediction.estimatedCostUsd > plan.costCeiling.maxCostUsd) {
      logger.warn(
        "cost-prediction",
        `Predicted cost $${prediction.estimatedCostUsd.toFixed(4)} exceeds ceiling $${plan.costCeiling.maxCostUsd.toFixed(4)} — proceeding with caution`,
      );
    }
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

/**
 * Run cost prediction before dispatch using historical outcome data.
 * Returns the prediction for logging/gating, or null if no data is available.
 */
function runCostPrediction(
  plan: RunPlan,
  logger: Logger,
  outcomeDeps?: OutcomeDeps,
): CostPrediction | null {
  try {
    const outcomeRepo = outcomeDeps?.outcomeRepo;
    const costRepo = outcomeDeps?.costRepo;

    // Build prediction from historical data if available
    const historicalOutcomes = outcomeRepo ? outcomeRepo.findAll().slice(-50) : [];
    const costsByRunId = new Map<string, { totalCostUsd: number }>();

    if (costRepo) {
      for (const outcome of historicalOutcomes) {
        try {
          const summary = costRepo.sumByRunId(outcome.id);
          costsByRunId.set(outcome.id, summary);
        } catch { /* skip entries without cost data */ }
      }
    }

    // If no historical data, use model rate for a rough estimate
    if (historicalOutcomes.length === 0) {
      const rate = getModelRate(plan.agent.model, plan.agent.type);
      const estimatedInputTokens = plan.agent.maxTurns * 4000;
      const estimatedOutputTokens = plan.agent.maxTurns * 1000;
      const estimatedCost = calculateCost(estimatedInputTokens, estimatedOutputTokens, rate);

      const prediction: CostPrediction = {
        estimatedCostUsd: Math.round(estimatedCost * 10000) / 10000,
        estimatedTurns: plan.agent.maxTurns,
        estimatedDurationMs: plan.agent.timeout,
        confidence: 0.1,
        basedOnRuns: 0,
        breakdown: {
          avgCostPerRun: estimatedCost,
          avgTurnsPerRun: plan.agent.maxTurns,
          avgDurationMsPerRun: plan.agent.timeout,
        },
      };

      logger.info(
        "cost-prediction",
        `Estimated cost: $${prediction.estimatedCostUsd.toFixed(4)} (model-based, confidence: ${(prediction.confidence * 100).toFixed(0)}%)`,
      );
      return prediction;
    }

    const prediction = predictCost(historicalOutcomes, costsByRunId as any);
    logger.info(
      "cost-prediction",
      `Estimated cost: $${prediction.estimatedCostUsd.toFixed(4)} based on ${prediction.basedOnRuns} historical runs (confidence: ${(prediction.confidence * 100).toFixed(0)}%)`,
    );
    return prediction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("cost-prediction", `Cost prediction unavailable: ${msg}`);
    return null;
  }
}
