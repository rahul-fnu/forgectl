import type { CostRepository } from "../storage/repositories/costs.js";

export interface BudgetConfig {
  max_cost_per_run?: number;
  max_cost_per_day?: number;
}

export interface BudgetStatus {
  runCostUsd: number;
  dayCostUsd: number;
  maxPerRun: number | null;
  maxPerDay: number | null;
  withinBudget: boolean;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly kind: "per_run" | "per_day",
    public readonly currentCost: number,
    public readonly limit: number,
  ) {
    const label = kind === "per_run" ? "per-run" : "per-day";
    super(
      `Budget exceeded: ${label} cost $${currentCost.toFixed(4)} exceeds limit $${limit.toFixed(4)}`
    );
    this.name = "BudgetExceededError";
  }
}

export interface CostCeilingConfig {
  maxCostUsd?: number;
  maxTokens?: number;
}

export interface CostCeilingResult {
  exceeded: boolean;
  reason?: string;
  percentUsed: number;
}

/**
 * Check cumulative agent usage against cost/token ceilings.
 * Returns whether the ceiling was exceeded and the percentage used.
 */
export function checkCostCeiling(
  cumulative: { inputTokens: number; outputTokens: number; costUsd: number },
  config: CostCeilingConfig,
): CostCeilingResult {
  const totalTokens = cumulative.inputTokens + cumulative.outputTokens;

  if (config.maxCostUsd !== undefined && cumulative.costUsd >= config.maxCostUsd) {
    return {
      exceeded: true,
      reason: `Cost $${cumulative.costUsd.toFixed(4)} exceeds ceiling $${config.maxCostUsd.toFixed(4)}`,
      percentUsed: (cumulative.costUsd / config.maxCostUsd) * 100,
    };
  }

  if (config.maxTokens !== undefined && totalTokens >= config.maxTokens) {
    return {
      exceeded: true,
      reason: `Token usage ${totalTokens} exceeds ceiling ${config.maxTokens}`,
      percentUsed: (totalTokens / config.maxTokens) * 100,
    };
  }

  // Compute percent used as the max of either metric
  let percentUsed = 0;
  if (config.maxCostUsd !== undefined && config.maxCostUsd > 0) {
    percentUsed = Math.max(percentUsed, (cumulative.costUsd / config.maxCostUsd) * 100);
  }
  if (config.maxTokens !== undefined && config.maxTokens > 0) {
    percentUsed = Math.max(percentUsed, (totalTokens / config.maxTokens) * 100);
  }

  return { exceeded: false, percentUsed };
}

/**
 * Check whether the current run is within budget.
 * Throws BudgetExceededError if over budget.
 */
export function checkBudget(
  costRepo: CostRepository,
  runId: string,
  budget: BudgetConfig,
): void {
  if (budget.max_cost_per_run !== undefined) {
    const runSummary = costRepo.sumByRunId(runId);
    if (runSummary.totalCostUsd >= budget.max_cost_per_run) {
      throw new BudgetExceededError("per_run", runSummary.totalCostUsd, budget.max_cost_per_run);
    }
  }

  if (budget.max_cost_per_day !== undefined) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const daySummary = costRepo.sumSince(startOfDay);
    if (daySummary.totalCostUsd >= budget.max_cost_per_day) {
      throw new BudgetExceededError("per_day", daySummary.totalCostUsd, budget.max_cost_per_day);
    }
  }
}

/**
 * Get the current budget status for a run.
 */
export function getBudgetStatus(
  costRepo: CostRepository,
  runId: string,
  budget: BudgetConfig | undefined,
): BudgetStatus {
  const runSummary = costRepo.sumByRunId(runId);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const daySummary = costRepo.sumSince(startOfDay);

  const maxPerRun = budget?.max_cost_per_run ?? null;
  const maxPerDay = budget?.max_cost_per_day ?? null;

  const withinBudget =
    (maxPerRun === null || runSummary.totalCostUsd < maxPerRun) &&
    (maxPerDay === null || daySummary.totalCostUsd < maxPerDay);

  return {
    runCostUsd: runSummary.totalCostUsd,
    dayCostUsd: daySummary.totalCostUsd,
    maxPerRun,
    maxPerDay,
    withinBudget,
  };
}
