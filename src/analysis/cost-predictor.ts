export interface CostPrediction {
  estimatedCostUsd: number;
  estimatedDurationMin: number;
  confidence: "low" | "medium" | "high";
}
export function predictCost(_stack: string, _complexity?: number): CostPrediction {
  return { estimatedCostUsd: 0.50, estimatedDurationMin: 10, confidence: "low" };
}
