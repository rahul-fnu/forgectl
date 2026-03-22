import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createOutcomeRepository } from "../storage/repositories/outcomes.js";
import { createReviewFindingsRepository } from "../storage/repositories/review-findings.js";
import { analyzeOutcomes, compareContextOutcomes, buildCalibrationReport, type AnalysisReport, type ContextComparisonReport, type CalibrationReport } from "../analysis/outcome-analyzer.js";

interface AnalyzeCommandOptions {
  since?: string;
  module?: string;
  compareContext?: boolean;
  reviewCalibration?: boolean;
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
  } finally {
    closeDatabase(db);
  }
}
