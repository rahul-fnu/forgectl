import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createOutcomeRepository } from "../storage/repositories/outcomes.js";
import { analyzeOutcomes, type AnalysisReport } from "../analysis/outcome-analyzer.js";

interface AnalyzeCommandOptions {
  since?: string;
  module?: string;
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

export async function analyzeCommand(opts: AnalyzeCommandOptions): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);
    const outcomeRepo = createOutcomeRepository(db);
    const allRows = outcomeRepo.findAll();

    const report = analyzeOutcomes(allRows, {
      since: opts.since,
      module: opts.module,
    });

    formatReport(report);
  } finally {
    closeDatabase(db);
  }
}
