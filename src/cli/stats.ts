import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createAnalyticsRepository } from "../storage/repositories/analytics.js";
import type { AnalyticsSummary, RetryPattern, FailureHotspot, WorkflowBreakdown } from "../storage/repositories/analytics.js";

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

function formatRetryPatterns(patterns: RetryPattern[]): void {
  if (patterns.length === 0) return;
  console.log(chalk.bold("\nRetry Patterns:"));
  for (const p of patterns) {
    console.log(`  ${p.failureReason.padEnd(30)} ${String(p.count).padStart(4)} runs  avg ${p.avgAttempts.toFixed(1)} attempts`);
  }
}

function formatFailureHotspots(hotspots: FailureHotspot[]): void {
  if (hotspots.length === 0) return;
  console.log(chalk.bold("\nFailure Hotspots:"));
  for (const h of hotspots) {
    console.log(`  ${h.module.padEnd(30)} ${String(h.failureCount).padStart(4)}/${h.totalRuns} failures  (${(h.failureRate * 100).toFixed(0)}%)`);
  }
}

function formatWorkflowBreakdown(workflows: WorkflowBreakdown[]): void {
  if (workflows.length === 0) return;
  console.log(chalk.bold("\nPer-Workflow Breakdown:"));
  for (const w of workflows) {
    console.log(`  ${w.workflow.padEnd(20)} ${String(w.runCount).padStart(4)} runs  ${(w.successRate * 100).toFixed(0)}% success  $${w.totalCostUsd.toFixed(4)}  avg ${formatDuration(w.avgDurationMs)}`);
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

    if (opts.json) {
      const metrics = analyticsRepo.getFullMetrics(sinceISO);
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      const summary = analyticsRepo.getSummary(sinceISO);
      formatSummary(summary, `last ${sinceDuration}`);

      const retryPatterns = analyticsRepo.getRetryPatterns(sinceISO);
      formatRetryPatterns(retryPatterns);

      const hotspots = analyticsRepo.getFailureHotspots(sinceISO);
      formatFailureHotspots(hotspots);

      const workflows = analyticsRepo.getWorkflowBreakdown(sinceISO);
      formatWorkflowBreakdown(workflows);

      console.log("");
    }
  } finally {
    closeDatabase(db);
  }
}
