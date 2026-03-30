import type { OutcomeRow } from "../storage/repositories/outcomes.js";
import type { CostSummary } from "../storage/repositories/costs.js";

export interface CostPrediction {
  estimatedCostUsd: number;
  estimatedTurns: number;
  estimatedDurationMs: number;
  confidence: number;
  basedOnRuns: number;
  breakdown: {
    avgCostPerRun: number;
    avgTurnsPerRun: number;
    avgDurationMsPerRun: number;
  };
}

export interface PlanPreview {
  runId: string;
  task: string;
  prediction: CostPrediction;
  planBullets: string[];
}

interface HistoricalRun {
  outcome: OutcomeRow;
  costUsd: number;
}

const COMPLEXITY_MULTIPLIERS: Record<string, number> = {
  trivial: 0.5,
  low: 0.75,
  medium: 1.0,
  high: 1.5,
  critical: 2.0,
};

const DEFAULT_COST_USD = 0.50;
const DEFAULT_TURNS = 15;
const DEFAULT_DURATION_MS = 5 * 60 * 1000;

export function predictCost(
  historicalOutcomes: OutcomeRow[],
  costsByRunId: Map<string, CostSummary>,
  complexityLabel?: string,
): CostPrediction {
  const runs: HistoricalRun[] = [];
  for (const outcome of historicalOutcomes) {
    const cost = costsByRunId.get(outcome.id);
    if (cost && cost.totalCostUsd > 0) {
      runs.push({ outcome, costUsd: cost.totalCostUsd });
    }
  }

  if (runs.length === 0) {
    const multiplier = COMPLEXITY_MULTIPLIERS[complexityLabel ?? "medium"] ?? 1.0;
    return {
      estimatedCostUsd: round(DEFAULT_COST_USD * multiplier),
      estimatedTurns: Math.round(DEFAULT_TURNS * multiplier),
      estimatedDurationMs: Math.round(DEFAULT_DURATION_MS * multiplier),
      confidence: 0.1,
      basedOnRuns: 0,
      breakdown: {
        avgCostPerRun: DEFAULT_COST_USD,
        avgTurnsPerRun: DEFAULT_TURNS,
        avgDurationMsPerRun: DEFAULT_DURATION_MS,
      },
    };
  }

  let totalCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  let turnsCount = 0;
  let durationCount = 0;

  for (const run of runs) {
    totalCost += run.costUsd;
    if (run.outcome.totalTurns !== null) {
      totalTurns += run.outcome.totalTurns;
      turnsCount++;
    }
    if (run.outcome.startedAt && run.outcome.completedAt) {
      totalDuration +=
        new Date(run.outcome.completedAt).getTime() -
        new Date(run.outcome.startedAt).getTime();
      durationCount++;
    }
  }

  const avgCost = totalCost / runs.length;
  const avgTurns = turnsCount > 0 ? totalTurns / turnsCount : DEFAULT_TURNS;
  const avgDuration =
    durationCount > 0 ? totalDuration / durationCount : DEFAULT_DURATION_MS;

  const multiplier =
    COMPLEXITY_MULTIPLIERS[complexityLabel ?? "medium"] ?? 1.0;

  const confidence = Math.min(1, runs.length / 10);

  return {
    estimatedCostUsd: round(avgCost * multiplier),
    estimatedTurns: Math.round(avgTurns * multiplier),
    estimatedDurationMs: Math.round(avgDuration * multiplier),
    confidence: round(confidence),
    basedOnRuns: runs.length,
    breakdown: {
      avgCostPerRun: round(avgCost),
      avgTurnsPerRun: Math.round(avgTurns * 100) / 100,
      avgDurationMsPerRun: Math.round(avgDuration),
    },
  };
}

export function buildPlanPreview(
  runId: string,
  task: string,
  prediction: CostPrediction,
  planBullets?: string[],
): PlanPreview {
  const bullets = planBullets ?? extractPlanBullets(task);
  return { runId, task, prediction, planBullets: bullets };
}

function extractPlanBullets(task: string): string[] {
  const lines = task.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets: string[] = [];
  for (const line of lines) {
    if (/^[-*•]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, ""));
    }
  }
  if (bullets.length === 0 && lines.length > 0) {
    bullets.push(lines[0].slice(0, 120));
  }
  return bullets;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
