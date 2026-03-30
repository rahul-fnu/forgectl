export interface BudgetConfig {
  max_cost_per_run?: number;
  max_cost_per_day?: number;
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

  let percentUsed = 0;
  if (config.maxCostUsd !== undefined && config.maxCostUsd > 0) {
    percentUsed = Math.max(percentUsed, (cumulative.costUsd / config.maxCostUsd) * 100);
  }
  if (config.maxTokens !== undefined && config.maxTokens > 0) {
    percentUsed = Math.max(percentUsed, (totalTokens / config.maxTokens) * 100);
  }

  return { exceeded: false, percentUsed };
}
