import yaml from "js-yaml";
import type { OutcomeRow } from "../storage/repositories/outcomes.js";
import type { CalibrationRow } from "../storage/repositories/review-findings.js";
import type { ReviewQualityStats } from "../storage/repositories/review-metrics.js";
import type { ReviewFindingRow } from "../storage/repositories/review-findings.js";
import type { TaskSpec } from "../task/types.js";

export interface AnalysisReport {
  period: { from: string; to: string };
  totalRuns: number;
  rubberStampRate: number;
  topFailureModes: Array<{ mode: string; count: number; pct: number }>;
  riskyModules: Array<{ module: string; failureRate: number; avgRetries: number }>;
  turnEstimationBias: number;
  recommendations: string[];
  contextSuggestions?: ContextSuggestion[];
}

export interface ImprovementSuggestion {
  id: string;
  title: string;
  description: string;
  confidence: number;
  category: "testing" | "error-handling" | "context" | "calibration";
  taskSpec: TaskSpec;
  taskSpecYaml: string;
}

export interface ContextSuggestion {
  module: string;
  action: "boost" | "demote" | "watch";
  reason: string;
  confidence: number;
}

export interface AnalyzeOptions {
  since?: string;
  module?: string;
  compareContext?: boolean;
}

export interface ContextComparisonReport {
  withContext: ContextGroupStats;
  withoutContext: ContextGroupStats;
  contextHitRate: number;
}

export interface ContextGroupStats {
  runCount: number;
  avgTurns: number;
  avgFilesExplored: number;
  avgDurationMs: number;
  successRate: number;
  firstPassValidation: number;
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

  const timestamps = filtered
    .map(r => r.completedAt ?? r.startedAt)
    .filter((t): t is string => t !== null)
    .sort();
  const from = timestamps[0] ?? "";
  const to = timestamps[timestamps.length - 1] ?? "";

  const reviewedRuns = filtered.filter(r => r.humanReviewResult !== null);
  const rubberStamps = reviewedRuns.filter(r => r.humanReviewResult === "rubber_stamp");
  const rubberStampRate = reviewedRuns.length > 0
    ? rubberStamps.length / reviewedRuns.length
    : 0;

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

  const runsWithTurns = filtered.filter(r => r.totalTurns !== null);
  const avgTurns = runsWithTurns.length > 0
    ? runsWithTurns.reduce((sum, r) => sum + r.totalTurns!, 0) / runsWithTurns.length
    : 0;
  const turnEstimationBias = Math.round(avgTurns * 100) / 100;

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

  const contextSuggestions = generateContextSuggestions(moduleStats, riskyModules);

  return {
    period: { from, to },
    totalRuns,
    rubberStampRate: Math.round(rubberStampRate * 10000) / 10000,
    topFailureModes,
    riskyModules,
    turnEstimationBias,
    recommendations,
    contextSuggestions,
  };
}

function generateContextSuggestions(
  moduleStats: Map<string, { total: number; failures: number; totalRetries: number }>,
  riskyModules: Array<{ module: string; failureRate: number; avgRetries: number }>,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];

  for (const risky of riskyModules) {
    const stats = moduleStats.get(risky.module);
    if (!stats || stats.total < 2) continue;

    if (risky.failureRate >= 0.5 && stats.total >= 3) {
      suggestions.push({
        module: risky.module,
        action: "watch",
        reason: `${Math.round(risky.failureRate * 100)}% failure rate across ${stats.total} runs — include more context for this module`,
        confidence: Math.min(1, risky.failureRate * stats.total / 5),
      });
    }

    if (risky.avgRetries >= 3) {
      suggestions.push({
        module: risky.module,
        action: "boost",
        reason: `avg ${risky.avgRetries.toFixed(1)} retries — agent needs more context upfront to avoid loops`,
        confidence: Math.min(1, risky.avgRetries / 5),
      });
    }
  }

  for (const [module, stats] of moduleStats) {
    if (stats.total < 3) continue;
    const failureRate = stats.failures / stats.total;
    const avgRetries = stats.totalRetries / stats.total;
    if (failureRate <= 0.1 && avgRetries <= 1) {
      suggestions.push({
        module,
        action: "demote",
        reason: `${Math.round((1 - failureRate) * 100)}% success with avg ${avgRetries.toFixed(1)} retries — safe to use compressed context`,
        confidence: Math.min(1, (1 - failureRate) * stats.total / 5),
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

function computeGroupStats(rows: OutcomeRow[]): ContextGroupStats {
  const total = rows.length;
  if (total === 0) {
    return { runCount: 0, avgTurns: 0, avgFilesExplored: 0, avgDurationMs: 0, successRate: 0, firstPassValidation: 0 };
  }

  const withTurns = rows.filter(r => r.totalTurns !== null);
  const avgTurns = withTurns.length > 0
    ? withTurns.reduce((s, r) => s + r.totalTurns!, 0) / withTurns.length
    : 0;

  let totalFilesExplored = 0;
  for (const r of rows) {
    totalFilesExplored += countFileReads(r.rawEventsJson);
  }
  const avgFilesExplored = totalFilesExplored / total;

  let totalDuration = 0;
  let durationCount = 0;
  for (const r of rows) {
    if (r.startedAt && r.completedAt) {
      totalDuration += new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
      durationCount++;
    }
  }
  const avgDurationMs = durationCount > 0 ? totalDuration / durationCount : 0;

  const successes = rows.filter(r => r.status === "success").length;
  const successRate = successes / total;

  const firstPass = rows.filter(r => (r.lintIterations ?? 0) <= 1 && r.status === "success").length;
  const firstPassValidation = firstPass / total;

  return {
    runCount: total,
    avgTurns: Math.round(avgTurns * 100) / 100,
    avgFilesExplored: Math.round(avgFilesExplored * 100) / 100,
    avgDurationMs: Math.round(avgDurationMs),
    successRate: Math.round(successRate * 10000) / 10000,
    firstPassValidation: Math.round(firstPassValidation * 10000) / 10000,
  };
}

function countFileReads(rawEventsJson: string | null): number {
  if (!rawEventsJson) return 0;
  try {
    const events: Array<{ type?: string; data?: { tool?: string } }> = JSON.parse(rawEventsJson);
    return events.filter(e =>
      e.type === "tool_use" && (e.data?.tool === "Read" || e.data?.tool === "file_read")
    ).length;
  } catch {
    return 0;
  }
}

export function computeContextHitRate(rows: OutcomeRow[]): number {
  let totalProvided = 0;
  let totalUsed = 0;

  for (const r of rows) {
    if (r.contextEnabled !== 1 || !r.contextFilesJson || !r.rawEventsJson) continue;

    let contextFiles: string[];
    try {
      contextFiles = JSON.parse(r.contextFilesJson);
    } catch {
      continue;
    }

    let readFiles: Set<string>;
    try {
      const events: Array<{ type?: string; data?: { tool?: string; file?: string; path?: string } }> = JSON.parse(r.rawEventsJson);
      readFiles = new Set(
        events
          .filter(e => e.type === "tool_use" && (e.data?.tool === "Read" || e.data?.tool === "file_read"))
          .map(e => e.data?.file ?? e.data?.path ?? "")
          .filter(p => p.length > 0)
      );
    } catch {
      continue;
    }

    totalProvided += contextFiles.length;
    for (const cf of contextFiles) {
      if (readFiles.has(cf)) {
        totalUsed++;
      }
    }
  }

  return totalProvided > 0 ? Math.round((totalUsed / totalProvided) * 10000) / 10000 : 0;
}

export function compareContextOutcomes(rows: OutcomeRow[], opts: AnalyzeOptions): ContextComparisonReport {
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

  const withContext = filtered.filter(r => r.contextEnabled === 1);
  const withoutContext = filtered.filter(r => r.contextEnabled === 0);

  return {
    withContext: computeGroupStats(withContext),
    withoutContext: computeGroupStats(withoutContext),
    contextHitRate: computeContextHitRate(withContext),
  };
}

// --- Calibration (RAH-29) ---

export interface CalibrationModuleReport {
  module: string;
  totalComments: number;
  falsePositives: number;
  rate: number;
}

export interface CalibrationReport {
  modules: CalibrationModuleReport[];
  overall: CalibrationModuleReport;
  warnings: string[];
}

export function computeCalibrationFromOutcomes(rows: OutcomeRow[]): Map<string, { total: number; falsePositives: number }> {
  const moduleStats = new Map<string, { total: number; falsePositives: number }>();

  for (const row of rows) {
    if (!row.reviewCommentsJson) continue;

    let parsed: { comments?: Array<{ file?: string; severity?: string }> };
    try {
      parsed = JSON.parse(row.reviewCommentsJson);
    } catch {
      continue;
    }

    const comments = parsed.comments;
    if (!Array.isArray(comments)) continue;

    const mustFixComments = comments.filter(
      (c) => c && typeof c.severity === "string" && c.severity.toUpperCase() === "MUST_FIX",
    );

    if (mustFixComments.length === 0) continue;

    const isFalsePositive = row.humanReviewResult === "rubber_stamp";

    const moduleSet = new Set<string>();
    for (const c of mustFixComments) {
      if (typeof c.file === "string") {
        const parts = c.file.split("/");
        const mod = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0] || "*";
        moduleSet.add(mod);
      }
    }

    for (const mod of moduleSet) {
      const modComments = mustFixComments.filter((c) => {
        if (typeof c.file !== "string") return false;
        const parts = c.file.split("/");
        const m = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0] || "*";
        return m === mod;
      });

      const stats = moduleStats.get(mod) ?? { total: 0, falsePositives: 0 };
      stats.total += modComments.length;
      if (isFalsePositive) {
        stats.falsePositives += modComments.length;
      }
      moduleStats.set(mod, stats);
    }
  }

  return moduleStats;
}

export function buildCalibrationReport(
  calibrationRows: CalibrationRow[],
  outcomeRows: OutcomeRow[],
): CalibrationReport {
  const fromOutcomes = computeCalibrationFromOutcomes(outcomeRows);

  const moduleMap = new Map<string, { total: number; falsePositives: number }>();

  for (const cal of calibrationRows) {
    moduleMap.set(cal.module, {
      total: cal.totalComments,
      falsePositives: cal.overriddenComments,
    });
  }

  for (const [mod, stats] of fromOutcomes) {
    const existing = moduleMap.get(mod) ?? { total: 0, falsePositives: 0 };
    existing.total += stats.total;
    existing.falsePositives += stats.falsePositives;
    moduleMap.set(mod, existing);
  }

  const modules: CalibrationModuleReport[] = [];
  let overallTotal = 0;
  let overallFP = 0;

  for (const [mod, stats] of moduleMap) {
    const rate = stats.total > 0 ? stats.falsePositives / stats.total : 0;
    modules.push({
      module: mod,
      totalComments: stats.total,
      falsePositives: stats.falsePositives,
      rate,
    });
    overallTotal += stats.total;
    overallFP += stats.falsePositives;
  }

  modules.sort((a, b) => b.rate - a.rate || b.totalComments - a.totalComments);

  const overallRate = overallTotal > 0 ? overallFP / overallTotal : 0;
  const overall: CalibrationModuleReport = {
    module: "(overall)",
    totalComments: overallTotal,
    falsePositives: overallFP,
    rate: overallRate,
  };

  const warnings: string[] = [];
  for (const m of modules) {
    if (m.rate > 0.3 && m.totalComments > 0) {
      warnings.push(
        `Module ${m.module} has ${(m.rate * 100).toFixed(1)}% false positive rate (${m.falsePositives}/${m.totalComments}) — review agent needs tuning for this module.`,
      );
    }
  }
  if (overallRate > 0.3 && overallTotal > 0) {
    warnings.push(
      `Overall false positive rate is ${(overallRate * 100).toFixed(1)}% — review agent is miscalibrated and should be tuned.`,
    );
  }

  return { modules, overall, warnings };
}

// --- Improvement Suggestions (RAH-30) ---

export function generateImprovementSuggestions(report: AnalysisReport): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];

  // Pattern 1: Modules with high retry/failure rate -> add tests
  for (const risky of report.riskyModules) {
    if (risky.failureRate >= 0.4 && risky.avgRetries >= 2) {
      const id = `add-tests-${slugify(risky.module)}`;
      const confidence = Math.min(1, risky.failureRate * 0.8 + risky.avgRetries * 0.1);
      const taskSpec: TaskSpec = {
        id,
        title: `Add unit tests for ${risky.module}`,
        description: `Module ${risky.module} has a ${Math.round(risky.failureRate * 100)}% failure rate with avg ${risky.avgRetries.toFixed(1)} retries. Add targeted unit tests to catch regressions earlier.`,
        context: { files: [`${risky.module}/**/*.ts`], modules: [risky.module] },
        constraints: ["Do not modify existing public APIs", "Tests must pass in CI"],
        acceptance: [
          { run: "npm test", description: "All tests pass" },
          { description: `New tests cover key paths in ${risky.module}` },
        ],
        decomposition: { strategy: "auto" },
        effort: { max_turns: 50, max_review_rounds: 3, timeout: "30m" },
        metadata: { priority: "high", source: "outcome-analyzer", confidence: String(Math.round(confidence * 100)) },
      };
      suggestions.push({ id, title: taskSpec.title, description: taskSpec.description!, confidence, category: "testing", taskSpec, taskSpecYaml: dumpTaskSpecYaml(taskSpec) });
    }
  }

  // Pattern 2: Review comments with recurring categories -> add conventions
  const reviewCategories = extractReviewCategories(report);
  for (const [category, count] of reviewCategories) {
    if (count < 3) continue;
    const id = `add-convention-${slugify(category)}`;
    const confidence = Math.min(1, count / 10);
    const taskSpec: TaskSpec = {
      id,
      title: `Add ${category} convention to CLAUDE.md`,
      description: `Review agent keeps flagging ${category} issues (${count} occurrences). Add a coding convention to CLAUDE.md to prevent this pattern.`,
      context: { files: ["CLAUDE.md"] },
      constraints: ["Only append new conventions, do not remove existing ones"],
      acceptance: [
        { run: "npm run typecheck", description: "Typecheck passes" },
        { description: `CLAUDE.md contains ${category} convention` },
      ],
      decomposition: { strategy: "forbidden" },
      effort: { max_turns: 10, max_review_rounds: 1, timeout: "10m" },
      metadata: { priority: "medium", source: "outcome-analyzer", confidence: String(Math.round(confidence * 100)) },
    };
    suggestions.push({ id, title: taskSpec.title, description: taskSpec.description!, confidence, category: "error-handling", taskSpec, taskSpecYaml: dumpTaskSpecYaml(taskSpec) });
  }

  // Pattern 3: Context suggestions with "boost" action -> add doc reference
  if (report.contextSuggestions) {
    for (const cs of report.contextSuggestions) {
      if (cs.action !== "boost") continue;
      const id = `add-context-${slugify(cs.module)}`;
      const confidence = cs.confidence;
      const taskSpec: TaskSpec = {
        id,
        title: `Add context references for ${cs.module}`,
        description: `Tasks touching ${cs.module} need more context upfront: ${cs.reason}. Add relevant documentation references to the module's context configuration.`,
        context: { files: [`${cs.module}/**/*.ts`], modules: [cs.module] },
        constraints: ["Only modify context configuration, not source code"],
        acceptance: [
          { run: "npm run typecheck", description: "Typecheck passes" },
          { description: `Context configuration updated for ${cs.module}` },
        ],
        decomposition: { strategy: "forbidden" },
        effort: { max_turns: 15, max_review_rounds: 1, timeout: "15m" },
        metadata: { priority: "medium", source: "outcome-analyzer", confidence: String(Math.round(confidence * 100)) },
      };
      suggestions.push({ id, title: taskSpec.title, description: taskSpec.description!, confidence, category: "context", taskSpec, taskSpecYaml: dumpTaskSpecYaml(taskSpec) });
    }
  }

  // Pattern 4: High turn estimation bias -> calibration task
  if (report.turnEstimationBias > 15) {
    const id = "calibrate-turn-estimation";
    const confidence = Math.min(1, (report.turnEstimationBias - 15) / 20);
    const taskSpec: TaskSpec = {
      id,
      title: "Calibrate turn estimation for complex modules",
      description: `Average turns per run is ${report.turnEstimationBias}, well above the expected baseline. Calibrate the token/turn estimation to better predict effort for complex tasks.`,
      context: { files: ["src/kg/merkle.ts", "src/context/builder.ts"] },
      constraints: ["Do not change estimation for simple modules", "Maintain backward compatibility"],
      acceptance: [
        { run: "npm test", description: "All tests pass" },
        { run: "npm run typecheck", description: "Typecheck passes" },
      ],
      decomposition: { strategy: "auto" },
      effort: { max_turns: 50, max_review_rounds: 3, timeout: "30m" },
      metadata: { priority: "low", source: "outcome-analyzer", confidence: String(Math.round(confidence * 100)) },
    };
    suggestions.push({ id, title: taskSpec.title, description: taskSpec.description!, confidence, category: "calibration", taskSpec, taskSpecYaml: dumpTaskSpecYaml(taskSpec) });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

function extractReviewCategories(report: AnalysisReport): Map<string, number> {
  const cats = new Map<string, number>();
  const recMatch = report.recommendations.find(r => r.includes("review comment categories"));
  if (!recMatch) return cats;
  const matches = recMatch.matchAll(/(\S+)\s+\((\d+)\)/g);
  for (const m of matches) {
    cats.set(m[1], parseInt(m[2], 10));
  }
  return cats;
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function dumpTaskSpecYaml(spec: TaskSpec): string {
  return yaml.dump(spec, { lineWidth: 100, quotingType: "\"", forceQuotes: false, noRefs: true, sortKeys: false });
}

// --- Review Quality (RAH-31) ---

export interface ReviewQualityReport {
  stats: ReviewQualityStats;
  topFindings: Array<{ category: string; count: number }>;
  recommendations: string[];
}

export function buildReviewQualityReport(
  stats: ReviewQualityStats,
  findings: ReviewFindingRow[],
): ReviewQualityReport {
  const categoryCounts = new Map<string, number>();
  for (const f of findings) {
    categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + f.occurrenceCount);
  }
  const topFindings = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recommendations: string[] = [];

  if (stats.totalPRs === 0) {
    recommendations.push("No review data yet. Review metrics will accumulate as the merge daemon processes PRs.");
    return { stats, topFindings, recommendations };
  }

  if (stats.firstPassApprovalRate >= 0.8) {
    recommendations.push(
      `First-pass approval rate is ${(stats.firstPassApprovalRate * 100).toFixed(0)}% — review daemon is largely approving on first pass.`,
    );
  } else if (stats.firstPassApprovalRate < 0.5) {
    recommendations.push(
      `First-pass approval rate is only ${(stats.firstPassApprovalRate * 100).toFixed(0)}% — agents may need better context or conventions.`,
    );
  }

  if (stats.averageReviewRounds > 2) {
    recommendations.push(
      `Average review rounds is ${stats.averageReviewRounds.toFixed(1)} — consider tuning review strictness or improving agent output.`,
    );
  }

  if (stats.estimatedFalsePositiveRate > 0.3) {
    recommendations.push(
      `Estimated false positive rate is ${(stats.estimatedFalsePositiveRate * 100).toFixed(0)}% — review daemon is too strict; tune review prompt or thresholds.`,
    );
  } else if (stats.estimatedFalsePositiveRate > 0 && stats.estimatedFalsePositiveRate <= 0.1) {
    recommendations.push(
      `Estimated false positive rate is ${(stats.estimatedFalsePositiveRate * 100).toFixed(0)}% — review calibration looks healthy.`,
    );
  }

  if (stats.escalatedCount > 0) {
    const pct = ((stats.escalatedCount / stats.totalPRs) * 100).toFixed(0);
    recommendations.push(
      `${stats.escalatedCount} PR(s) (${pct}%) were escalated — check if must_fix findings are justified.`,
    );
  }

  if (topFindings.length > 0) {
    const top3 = topFindings.slice(0, 3).map(f => `${f.category} (${f.count})`).join(", ");
    recommendations.push(`Most common findings: ${top3}.`);
  }

  return { stats, topFindings, recommendations };
}
