import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createOutcomeRepository } from "../storage/repositories/outcomes.js";
import { analyzeOutcomes, compareContextOutcomes, type AnalysisReport, type ContextComparisonReport } from "../analysis/outcome-analyzer.js";

interface AnalyzeCommandOptions {
  since?: string;
  module?: string;
  compareContext?: boolean;
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

    const report = analyzeOutcomes(allRows, {
      since: opts.since,
      module: opts.module,
    });

    formatReport(report);
  } finally {
    closeDatabase(db);
  }
}
