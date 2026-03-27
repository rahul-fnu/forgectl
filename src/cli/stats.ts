import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createAnalyticsRepository } from "../storage/repositories/analytics.js";
import type {
  AnalyticsSummary,
  CostTrendPoint,
  RetryPatterns,
  FailureHotspot,
  WorkflowPerformance,
} from "../storage/repositories/analytics.js";

interface StatsOptions {
  since?: string;
  json?: boolean;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

function formatSummary(summary: AnalyticsSummary, sinceLabel: string): void {
  console.log(chalk.bold(`\nRun Statistics (${sinceLabel})`));
  console.log(`  Run count:     ${summary.runCount}`);
  console.log(`  Success rate:  ${(summary.successRate * 100).toFixed(1)}%`);
  console.log(`  Total cost:    $${summary.totalCostUsd.toFixed(4)}`);
  console.log(`  Avg cost:      $${summary.avgCostUsd.toFixed(4)}`);
  console.log(`  Avg duration:  ${formatDuration(summary.avgDurationMs)}`);

  if (summary.topFailures.length > 0) {
    console.log(chalk.bold("\n  Top Failures:"));
    for (const f of summary.topFailures) {
      console.log(`    ${f.mode.padEnd(30)} ${String(f.count).padStart(4)}`);
    }
  }
}

function formatCostTrend(trend: CostTrendPoint[]): void {
  if (trend.length === 0) return;
  console.log(chalk.bold("\nCost Trend (daily):"));
  for (const point of trend) {
    console.log(`  ${point.date}  $${point.totalCostUsd.toFixed(4).padStart(10)}  ${String(point.runCount).padStart(3)} runs`);
  }
}

function formatRetryPatterns(patterns: RetryPatterns): void {
  if (patterns.totalOutcomes === 0) return;
  console.log(chalk.bold("\nRetry Patterns:"));
  console.log(`  Total outcomes:      ${patterns.totalOutcomes}`);
  console.log(`  Runs with retries:   ${patterns.runsWithRetries} (${(patterns.retryRate * 100).toFixed(1)}%)`);
  console.log(`  Avg total turns:     ${patterns.avgTotalTurns.toFixed(1)}`);
  console.log(`  Avg lint iterations: ${patterns.avgLintIterations.toFixed(1)}`);
  console.log(`  Avg review rounds:   ${patterns.avgReviewRounds.toFixed(1)}`);
  console.log(`  Max total turns:     ${patterns.maxTotalTurns}`);
}

function formatFailureHotspots(hotspots: FailureHotspot[]): void {
  if (hotspots.length === 0) return;
  console.log(chalk.bold("\nValidation Failure Hotspots:"));
  for (const h of hotspots) {
    console.log(`  ${h.module.padEnd(30)} ${String(h.failureCount).padStart(3)} failures / ${String(h.totalRuns).padStart(3)} runs  (${(h.failureRate * 100).toFixed(1)}%)`);
  }
}

function formatWorkflowPerformance(workflows: WorkflowPerformance[]): void {
  if (workflows.length === 0) return;
  console.log(chalk.bold("\nPerformance by Workflow:"));
  for (const w of workflows) {
    console.log(`  ${w.workflow.padEnd(20)} ${String(w.runCount).padStart(4)} runs  ${(w.successRate * 100).toFixed(1)}% success  ${formatDuration(w.avgDurationMs).padStart(8)} avg  $${w.avgCostUsd.toFixed(4)}/run`);
  }
}

export async function statsCommand(opts: StatsOptions): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);
    const analyticsRepo = createAnalyticsRepository(db);

    const sinceDuration = opts.since ?? "7d";
    const sinceDate = parseSinceDuration(sinceDuration);
    const sinceISO = sinceDate.toISOString();

    const summary = analyticsRepo.getSummary(sinceISO);
    const costTrend = analyticsRepo.getCostTrend(sinceISO);
    const retryPatterns = analyticsRepo.getRetryPatterns(sinceISO);
    const failureHotspots = analyticsRepo.getFailureHotspots(sinceISO);
    const workflowPerf = analyticsRepo.getPerformanceByWorkflow(sinceISO);

    if (opts.json) {
      console.log(JSON.stringify({
        summary,
        costTrend,
        retryPatterns,
        failureHotspots,
        workflowPerformance: workflowPerf,
      }, null, 2));
    } else {
      formatSummary(summary, `last ${sinceDuration}`);
      formatCostTrend(costTrend);
      formatRetryPatterns(retryPatterns);
      formatFailureHotspots(failureHotspots);
      formatWorkflowPerformance(workflowPerf);
      console.log("");
    }
  } finally {
    closeDatabase(db);
  }
}
