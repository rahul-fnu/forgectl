import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createCostRepository } from "../storage/repositories/costs.js";
import type { CostSummary } from "../storage/repositories/costs.js";

interface CostsOptions {
  runId?: string;
  since?: string;
  workflow?: string;
}

/**
 * Parse a duration string like "24h", "7d", "30m" into a Date.
 */
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

function formatSummary(label: string, summary: CostSummary): void {
  console.log(chalk.bold(`\n${label}`));
  console.log(`  Records:       ${summary.recordCount}`);
  console.log(`  Input tokens:  ${summary.totalInputTokens.toLocaleString("en-US")}`);
  console.log(`  Output tokens: ${summary.totalOutputTokens.toLocaleString("en-US")}`);
  console.log(`  Total cost:    $${summary.totalCostUsd.toFixed(4)}`);
}

/**
 * CLI handler: show cost summary.
 */
export async function costsCommand(opts: CostsOptions): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);
    const costRepo = createCostRepository(db);

    if (opts.runId) {
      const summary = costRepo.sumByRunId(opts.runId);
      formatSummary(`Cost summary for run ${opts.runId}:`, summary);

      // Also show individual records
      const records = costRepo.findByRunId(opts.runId);
      if (records.length > 0) {
        console.log(chalk.bold("\n  Breakdown:"));
        for (const r of records) {
          console.log(`    ${r.timestamp}  ${r.agentType}${r.model ? ` (${r.model})` : ""}  in=${r.inputTokens.toLocaleString("en-US")} out=${r.outputTokens.toLocaleString("en-US")}  $${r.costUsd.toFixed(4)}`);
        }
      }
    } else if (opts.workflow) {
      const summary = costRepo.sumByWorkflow(opts.workflow);
      formatSummary(`Cost summary for workflow "${opts.workflow}":`, summary);
    } else if (opts.since) {
      const sinceDate = parseSinceDuration(opts.since);
      const summary = costRepo.sumSince(sinceDate.toISOString());
      formatSummary(`Cost summary since ${sinceDate.toISOString()}:`, summary);
    } else {
      const summary = costRepo.sumAll();
      formatSummary("Total cost summary:", summary);
    }

    console.log("");
  } finally {
    closeDatabase(db);
  }
}
