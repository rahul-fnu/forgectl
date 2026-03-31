import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createOutcomeRepository } from "../storage/repositories/outcomes.js";
import { createEventRepository } from "../storage/repositories/events.js";
import { createReviewFindingsRepository } from "../storage/repositories/review-findings.js";
import { analyzeOutcomes, compareContextOutcomes, buildCalibrationReport, generateImprovementSuggestions, buildReviewQualityReport, analyzeToolUsage, analyzeFailurePatterns, analyzeTokenWaste, type AnalysisReport, type ContextComparisonReport, type CalibrationReport, type ImprovementSuggestion, type ReviewQualityReport, type ToolUsageReport, type FailurePatternsReport, type TokenWasteReport } from "../analysis/outcome-analyzer.js";
import { extractToolUsage, extractFailurePatterns, detectTokenWaste, getStuckPoints, type ToolUsageReport as EventToolUsageReport, type FailureSignature, type TokenWasteReport as EventTokenWasteReport, type StuckPoint } from "../analysis/behavior.js";
import { createCostRepository } from "../storage/repositories/costs.js";
import { createReviewMetricsRepository } from "../storage/repositories/review-metrics.js";
import type { TrackerAdapter } from "../tracker/types.js";

interface AnalyzeCommandOptions {
  since?: string;
  module?: string;
  compareContext?: boolean;
  reviewCalibration?: boolean;
  reviewQuality?: boolean;
  suggest?: boolean;
}

function formatReport(report: AnalysisReport): void {
  console.log(chalk.bold("\nOutcome Analysis Report"));
  console.log(`  Period: ${report.period.from || "(none)"} → ${report.period.to || "(none)"}`);
  console.log(`  Total runs: ${report.totalRuns}`);
  console.log(`  Rubber stamp rate: ${(report.rubberStampRate * 100).toFixed(1)}%`);
  console.log(`  Avg turns per run: ${report.turnEstimationBias}`);

  if (report.topFailureModes.length > 0) {
    console.log(chalk.bold("\n  Failure Modes:"));
    for (const fm of report.topFailureModes) {
      console.log(`    ${fm.mode.padEnd(25)} ${String(fm.count).padStart(4)} (${(fm.pct * 100).toFixed(1)}%)`);
    }
  }

  if (report.riskyModules.length > 0) {
    console.log(chalk.bold("\n  Risky Modules:"));
    for (const m of report.riskyModules.slice(0, 10)) {
      console.log(`    ${m.module.padEnd(35)} fail=${(m.failureRate * 100).toFixed(0)}%  retries=${m.avgRetries.toFixed(1)}`);
    }
  }

  if (report.recommendations.length > 0) {
    console.log(chalk.bold("\n  Recommendations:"));
    for (const rec of report.recommendations) {
      console.log(`    • ${rec}`);
    }
  }

  console.log("");
}

function formatContextComparison(report: ContextComparisonReport): void {
  console.log(chalk.bold("\nContext Comparison Report"));
  console.log(chalk.bold("\n  With KG Context:"));
  formatGroupStats(report.withContext);
  console.log(chalk.bold("\n  Without KG Context:"));
  formatGroupStats(report.withoutContext);
  console.log(chalk.bold("\n  Context Hit Rate:"));
  console.log(`    ${(report.contextHitRate * 100).toFixed(1)}% of pre-provided files were relevant`);
  console.log("");
}

function formatGroupStats(stats: ContextComparisonReport["withContext"]): void {
  console.log(`    Runs:                ${stats.runCount}`);
  console.log(`    Avg turns:           ${stats.avgTurns}`);
  console.log(`    Avg files explored:  ${stats.avgFilesExplored}`);
  console.log(`    Avg duration:        ${stats.avgDurationMs > 0 ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : "N/A"}`);
  console.log(`    Success rate:        ${(stats.successRate * 100).toFixed(1)}%`);
  console.log(`    First-pass validation: ${(stats.firstPassValidation * 100).toFixed(1)}%`);
}

function formatCalibrationReport(report: CalibrationReport): void {
  console.log(chalk.bold("\nReview Agent Calibration Report"));

  if (report.modules.length === 0) {
    console.log("  No calibration data available.");
    console.log("");
    return;
  }

  console.log(chalk.bold("\n  Per-Module False Positive Rates:"));
  for (const m of report.modules) {
    const rateStr = (m.rate * 100).toFixed(1) + "%";
    const flag = m.rate > 0.3 && m.totalComments > 0 ? chalk.red(" ⚠") : "";
    console.log(
      `    ${m.module.padEnd(35)} ${rateStr.padStart(6)}  (${m.falsePositives}/${m.totalComments})${flag}`,
    );
  }

  console.log(chalk.bold("\n  Overall:"));
  console.log(
    `    False positive rate: ${(report.overall.rate * 100).toFixed(1)}% (${report.overall.falsePositives}/${report.overall.totalComments})`,
  );

  if (report.warnings.length > 0) {
    console.log(chalk.bold.yellow("\n  Warnings:"));
    for (const w of report.warnings) {
      console.log(`    ⚠ ${w}`);
    }
  }

  console.log("");
}

export async function publishSuggestionsToTracker(
  suggestions: ImprovementSuggestion[],
  tracker: TrackerAdapter,
  autoConfidenceThreshold = 0.7,
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const s of suggestions) {
    if (!tracker.createIssue) {
      skipped.push(s.id);
      continue;
    }
    const labels = s.confidence >= autoConfidenceThreshold
      ? ["forgectl-suggestion"]
      : ["forgectl-suggestion", "needs-review"];
    const body = `${s.description}\n\n**Category:** ${s.category}\n**Confidence:** ${Math.round(s.confidence * 100)}%\n**Source:** outcome-analyzer\n\n\`\`\`yaml\n${s.taskSpecYaml}\`\`\``;
    const identifier = await tracker.createIssue(s.title, body, labels);
    created.push(identifier);
  }

  return { created, skipped };
}

function formatReviewQualityReport(report: ReviewQualityReport): void {
  console.log(chalk.bold("\nReview Quality Report"));

  const s = report.stats;
  if (s.totalPRs === 0) {
    console.log("  No review metrics data available.");
    console.log("");
    return;
  }

  console.log(`  Total PRs reviewed:         ${s.totalPRs}`);
  console.log(`  First-pass approval rate:   ${(s.firstPassApprovalRate * 100).toFixed(1)}%`);
  console.log(`  Average review rounds:      ${s.averageReviewRounds.toFixed(1)}`);
  console.log(`  Total comments:             ${s.totalComments}`);
  console.log(`    must_fix: ${s.totalMustFix}  should_fix: ${s.totalShouldFix}  nit: ${s.totalNit}`);
  console.log(`  Escalated PRs:              ${s.escalatedCount}`);
  console.log(`  Human overrides:            ${s.humanOverrideCount}`);
  console.log(`  Est. false positive rate:   ${(s.estimatedFalsePositiveRate * 100).toFixed(1)}%`);
  const parseTotal = s.parseFailureCount + s.parseSuccessCount;
  if (parseTotal > 0) {
    console.log(`  Parse success rate:         ${(s.parseSuccessRate * 100).toFixed(1)}% (${s.parseSuccessCount}/${parseTotal})`);
  }

  if (report.topFindings.length > 0) {
    console.log(chalk.bold("\n  Most Common Findings:"));
    for (const f of report.topFindings.slice(0, 10)) {
      console.log(`    ${f.category.padEnd(25)} ${String(f.count).padStart(4)}`);
    }
  }

  if (report.recommendations.length > 0) {
    console.log(chalk.bold("\n  Recommendations:"));
    for (const rec of report.recommendations) {
      console.log(`    • ${rec}`);
    }
  }

  console.log("");
}

function formatToolUsage(report: ToolUsageReport): void {
  console.log(chalk.bold("  Tool Usage:"));
  console.log(`    Total turns:           ${report.totalTurns}`);
  console.log(`    Lint iterations:       ${report.totalLintIterations}`);
  console.log(`    Files changed:         ${report.totalFilesChanged}`);
  console.log(`    Tests added:           ${report.totalTestsAdded}`);
  if (report.toolBreakdown.length > 0) {
    console.log(chalk.bold("\n    Tool Counts:"));
    for (const t of report.toolBreakdown.slice(0, 10)) {
      console.log(`      ${t.tool.padEnd(25)} ${String(t.count).padStart(6)}`);
    }
  }
  console.log("");
}

function formatStuckPoints(report: FailurePatternsReport): void {
  if (report.stuckPoints.length === 0) return;

  console.log(chalk.bold("  Stuck Points:"));
  for (const sp of report.stuckPoints.slice(0, 10)) {
    console.log(`    ${sp.runId.padEnd(30)} ${sp.failureMode.padEnd(20)} turns=${sp.turns}`);
    if (sp.detail) {
      console.log(`      ${sp.detail.slice(0, 100)}`);
    }
  }
  console.log("");
}

function formatTokenWaste(report: TokenWasteReport): void {
  console.log(chalk.bold("  Token Waste:"));
  console.log(`    Total cost:    $${report.totalCostUsd.toFixed(4)}`);
  console.log(`    Wasted cost:   $${report.wastedCostUsd.toFixed(4)} (${report.failedRuns} failed runs)`);
  const totalTokens = report.totalTokens.input + report.totalTokens.output;
  const wastedTokens = report.wastedTokens.input + report.wastedTokens.output;
  console.log(`    Total tokens:  ${totalTokens}`);
  console.log(`    Wasted tokens: ${wastedTokens}`);
  if (report.highRetryRuns.length > 0) {
    console.log(chalk.bold("\n    High-Retry Runs:"));
    for (const r of report.highRetryRuns.slice(0, 5)) {
      console.log(`      ${r.runId.padEnd(30)} retries=${r.lintIterations}  turns=${r.turns}`);
    }
  }
  console.log("");
}

function formatEventToolUsage(report: EventToolUsageReport): void {
  if (report.totalCalls === 0) return;

  console.log(chalk.bold("  Event-Level Tool Distribution:"));
  for (const t of report.byTool) {
    const pctStr = `${(t.pct * 100).toFixed(1)}%`;
    console.log(`    ${t.tool.padEnd(25)} ${String(t.count).padStart(6)}  (${pctStr})`);
  }
  console.log("");
}

function formatFailureSignatures(signatures: FailureSignature[]): void {
  if (signatures.length === 0) return;

  console.log(chalk.bold("  Failure Signatures (from events):"));
  for (const s of signatures.slice(0, 10)) {
    const runsStr = s.runIds.length <= 3
      ? s.runIds.join(", ")
      : `${s.runIds.slice(0, 3).join(", ")} +${s.runIds.length - 3} more`;
    console.log(`    ${s.signature.padEnd(40)} ${String(s.count).padStart(4)}  runs: ${runsStr}`);
  }
  console.log("");
}

function formatEventStuckPoints(stuckPoints: StuckPoint[]): void {
  if (stuckPoints.length === 0) return;

  console.log(chalk.bold("  Timing-Based Stuck Points:"));
  for (const sp of stuckPoints.slice(0, 10)) {
    const durStr = sp.durationMs >= 60000
      ? `${(sp.durationMs / 60000).toFixed(1)}m`
      : `${(sp.durationMs / 1000).toFixed(1)}s`;
    console.log(`    ${sp.runId.padEnd(30)} event=${sp.type.padEnd(15)} gap=${durStr}`);
  }
  console.log("");
}

function formatEventTokenWaste(report: EventTokenWasteReport): void {
  if (report.totalTokens === 0) return;

  console.log(chalk.bold("  Event-Level Token Waste:"));
  console.log(`    Total tokens:      ${report.totalTokens}`);
  console.log(`    Wasted tokens:     ${report.wastedTokens} (${(report.wasteRatio * 100).toFixed(1)}%)`);
  if (report.revertedSegments > 0) {
    console.log(`    Reverted segments: ${report.revertedSegments}`);
  }
  console.log("");
}

function formatSuggestions(suggestions: ImprovementSuggestion[]): void {
  if (suggestions.length === 0) {
    console.log(chalk.yellow("\n  No improvement suggestions generated (need more outcome data)."));
    console.log("");
    return;
  }

  console.log(chalk.bold("\n  Improvement Suggestions:"));
  for (const s of suggestions) {
    const conf = `${Math.round(s.confidence * 100)}%`;
    const badge = s.confidence >= 0.7 ? chalk.green(`[${conf}]`) : chalk.yellow(`[${conf}]`);
    console.log(`\n    ${badge} ${chalk.bold(s.title)}`);
    console.log(`    Category: ${s.category}`);
    console.log(`    ${s.description}`);
    console.log(chalk.dim(`    ---`));
    for (const line of s.taskSpecYaml.split("\n").slice(0, 8)) {
      console.log(chalk.dim(`    ${line}`));
    }
    if (s.taskSpecYaml.split("\n").length > 8) {
      console.log(chalk.dim(`    ...`));
    }
  }
  console.log("");
}

export async function analyzeCommand(opts: AnalyzeCommandOptions): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);
    const outcomeRepo = createOutcomeRepository(db);
    const allRows = outcomeRepo.findAll();

    if (opts.compareContext) {
      const comparison = compareContextOutcomes(allRows, {
        since: opts.since,
        module: opts.module,
      });
      formatContextComparison(comparison);
      return;
    }

    if (opts.reviewQuality) {
      const metricsRepo = createReviewMetricsRepository(db);
      const findingsRepo = createReviewFindingsRepository(db);
      const stats = metricsRepo.computeStats();
      const findings = findingsRepo.findAll();
      const report = buildReviewQualityReport(stats, findings);
      formatReviewQualityReport(report);
      return;
    }

    if (opts.reviewCalibration) {
      const findingsRepo = createReviewFindingsRepository(db);
      const calibrationRows = findingsRepo.getAllCalibration();
      const calibrationReport = buildCalibrationReport(calibrationRows, allRows);
      formatCalibrationReport(calibrationReport);
      return;
    }

    const report = analyzeOutcomes(allRows, {
      since: opts.since,
      module: opts.module,
    });

    formatReport(report);

    const toolUsage = analyzeToolUsage(allRows);
    formatToolUsage(toolUsage);

    const failurePatterns = analyzeFailurePatterns(allRows);
    formatStuckPoints(failurePatterns);

    const costRepo = createCostRepository(db);
    const costsByRunId = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>();
    for (const row of allRows) {
      const summary = costRepo.sumByRunId(row.id);
      if (summary.recordCount > 0) {
        costsByRunId.set(row.id, {
          inputTokens: summary.totalInputTokens,
          outputTokens: summary.totalOutputTokens,
          costUsd: summary.totalCostUsd,
        });
      }
    }
    const tokenWaste = analyzeTokenWaste(allRows, costsByRunId);
    formatTokenWaste(tokenWaste);

    // Event-level behavior analysis (from run_events table)
    const eventRepo = createEventRepository(db);
    const allEventRows = allRows.flatMap(row => eventRepo.findByRunId(row.id));
    if (allEventRows.length > 0) {
      console.log(chalk.bold("\nEvent-Level Behavior Analysis"));

      const eventToolUsage = extractToolUsage(allEventRows);
      formatEventToolUsage(eventToolUsage);

      const failureSignatures = extractFailurePatterns(allEventRows);
      formatFailureSignatures(failureSignatures);

      const eventStuckPoints = getStuckPoints(allEventRows);
      formatEventStuckPoints(eventStuckPoints);

      const totalCosts = costRepo.sumAll();
      if (totalCosts.recordCount > 0) {
        const eventWaste = detectTokenWaste(allEventRows, totalCosts);
        formatEventTokenWaste(eventWaste);
      }
    }

    if (opts.suggest) {
      const suggestions = generateImprovementSuggestions(report);
      formatSuggestions(suggestions);
    }
  } finally {
    closeDatabase(db);
  }
}
