import type { OutcomeRow } from "../storage/repositories/outcomes.js";

export interface AnalysisReport {
  period: { from: string; to: string };
  totalRuns: number;
  rubberStampRate: number;
  topFailureModes: Array<{ mode: string; count: number; pct: number }>;
  riskyModules: Array<{ module: string; failureRate: number; avgRetries: number }>;
  turnEstimationBias: number;
  recommendations: string[];
}

export interface AnalyzeOptions {
  since?: string;
  module?: string;
}

function parseSinceDuration(since: string): Date {
  const match = since.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${since}". Use format like 24h, 7d, 30m`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case "m":
      return new Date(now.getTime() - value * 60 * 1000);
    case "h":
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case "d":
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function analyzeOutcomes(rows: OutcomeRow[], opts: AnalyzeOptions): AnalysisReport {
  let filtered = rows;

  if (opts.since) {
    const sinceDate = parseSinceDuration(opts.since);
    const sinceIso = sinceDate.toISOString();
    filtered = filtered.filter(r => (r.completedAt ?? r.startedAt ?? "") >= sinceIso);
  }

  if (opts.module) {
    const mod = opts.module;
    filtered = filtered.filter(r => {
      if (!r.modulesTouched) return false;
      try {
        const modules: string[] = JSON.parse(r.modulesTouched);
        return modules.some(m => m === mod || m.startsWith(mod + "/"));
      } catch {
        return false;
      }
    });
  }

  const totalRuns = filtered.length;

  // Period
  const timestamps = filtered
    .map(r => r.completedAt ?? r.startedAt)
    .filter((t): t is string => t !== null)
    .sort();
  const from = timestamps[0] ?? "";
  const to = timestamps[timestamps.length - 1] ?? "";

  // Rubber stamp rate
  const reviewedRuns = filtered.filter(r => r.humanReviewResult !== null);
  const rubberStamps = reviewedRuns.filter(r => r.humanReviewResult === "rubber_stamp");
  const rubberStampRate = reviewedRuns.length > 0
    ? rubberStamps.length / reviewedRuns.length
    : 0;

  // Failure mode distribution
  const failureCounts = new Map<string, number>();
  const failedRuns = filtered.filter(r => r.failureMode !== null);
  for (const r of failedRuns) {
    const mode = r.failureMode!;
    failureCounts.set(mode, (failureCounts.get(mode) ?? 0) + 1);
  }
  const topFailureModes = Array.from(failureCounts.entries())
    .map(([mode, count]) => ({
      mode,
      count,
      pct: totalRuns > 0 ? count / totalRuns : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Module retry rates (risky modules)
  const moduleStats = new Map<string, { total: number; failures: number; totalRetries: number }>();
  for (const r of filtered) {
    if (!r.modulesTouched) continue;
    let modules: string[];
    try {
      modules = JSON.parse(r.modulesTouched);
    } catch {
      continue;
    }
    const isFailed = r.status === "failure" || r.failureMode !== null;
    const retries = r.lintIterations ?? 0;
    for (const mod of modules) {
      const stats = moduleStats.get(mod) ?? { total: 0, failures: 0, totalRetries: 0 };
      stats.total++;
      if (isFailed) stats.failures++;
      stats.totalRetries += retries;
      moduleStats.set(mod, stats);
    }
  }
  const riskyModules = Array.from(moduleStats.entries())
    .map(([module, stats]) => ({
      module,
      failureRate: stats.total > 0 ? stats.failures / stats.total : 0,
      avgRetries: stats.total > 0 ? stats.totalRetries / stats.total : 0,
    }))
    .filter(m => m.failureRate > 0 || m.avgRetries > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.avgRetries - a.avgRetries);

  // Turn estimation bias: average turns across runs (positive = more turns than expected baseline)
  // Without an estimatedTurns field, we compute the mean turns as a proxy metric
  const runsWithTurns = filtered.filter(r => r.totalTurns !== null);
  const avgTurns = runsWithTurns.length > 0
    ? runsWithTurns.reduce((sum, r) => sum + r.totalTurns!, 0) / runsWithTurns.length
    : 0;
  const turnEstimationBias = Math.round(avgTurns * 100) / 100;

  // Review comment patterns
  const categoryCounts = new Map<string, number>();
  for (const r of filtered) {
    if (!r.reviewCommentsJson) continue;
    try {
      const parsed = JSON.parse(r.reviewCommentsJson);
      const comments: Array<{ category?: string }> = parsed.comments ?? parsed;
      for (const c of comments) {
        if (c.category) {
          categoryCounts.set(c.category, (categoryCounts.get(c.category) ?? 0) + 1);
        }
      }
    } catch {
      // skip malformed JSON
    }
  }

  // Generate recommendations
  const recommendations: string[] = [];

  if (rubberStampRate >= 0.8 && reviewedRuns.length >= 3) {
    recommendations.push(
      `Rubber stamp rate is ${(rubberStampRate * 100).toFixed(0)}% — consider reducing review overhead for low-risk runs.`
    );
  }
  if (rubberStampRate < 0.3 && reviewedRuns.length >= 3) {
    recommendations.push(
      `Rubber stamp rate is only ${(rubberStampRate * 100).toFixed(0)}% — review quality may need attention. Check top failure modes.`
    );
  }

  const loopMode = topFailureModes.find(f => f.mode === "LOOP");
  if (loopMode && loopMode.pct > 0.2) {
    recommendations.push(
      `LOOP failures account for ${(loopMode.pct * 100).toFixed(0)}% of runs — investigate loop detection thresholds.`
    );
  }

  const missingCtx = topFailureModes.find(f => f.mode === "MISSING_CONTEXT");
  if (missingCtx && missingCtx.pct > 0.15) {
    recommendations.push(
      `MISSING_CONTEXT failures at ${(missingCtx.pct * 100).toFixed(0)}% — improve context file selection or add more context paths.`
    );
  }

  const highRetryModules = riskyModules.filter(m => m.avgRetries >= 3);
  if (highRetryModules.length > 0) {
    const names = highRetryModules.slice(0, 3).map(m => m.module).join(", ");
    recommendations.push(
      `Modules with high retry rates: ${names} — consider adding targeted validation or splitting complex modules.`
    );
  }

  const topCategories = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topCategories.length > 0) {
    const cats = topCategories.map(([cat, count]) => `${cat} (${count})`).join(", ");
    recommendations.push(
      `Top review comment categories: ${cats} — address these patterns to improve first-pass quality.`
    );
  }

  if (turnEstimationBias > 15) {
    recommendations.push(
      `Average turns per run is ${turnEstimationBias} — tasks may be too complex. Consider breaking them down.`
    );
  }

  return {
    period: { from, to },
    totalRuns,
    rubberStampRate: Math.round(rubberStampRate * 10000) / 10000,
    topFailureModes,
    riskyModules,
    turnEstimationBias,
    recommendations,
  };
}
