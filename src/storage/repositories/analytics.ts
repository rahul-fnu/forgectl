import { sql, gte } from "drizzle-orm";
import { runs, runCosts, runOutcomes } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface AnalyticsSummary {
  runCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgDurationMs: number;
  topFailures: { mode: string; count: number }[];
}

export interface CostTrendPoint {
  date: string;
  totalCostUsd: number;
  runCount: number;
}

export interface FailureHotspot {
  module: string;
  failureCount: number;
  totalRuns: number;
  failureRate: number;
}

export interface AnalyticsRepository {
  getSummary(since: string): AnalyticsSummary;
  getCostTrend(since: string): CostTrendPoint[];
  getFailureHotspots(since: string): FailureHotspot[];
}

export function createAnalyticsRepository(db: AppDatabase): AnalyticsRepository {
  return {
    getSummary(since: string): AnalyticsSummary {
      const countRow = db
        .select({
          total: sql<number>`COUNT(*)`,
          success: sql<number>`SUM(CASE WHEN ${runs.status} = 'completed' THEN 1 ELSE 0 END)`,
          failure: sql<number>`SUM(CASE WHEN ${runs.status} = 'failed' THEN 1 ELSE 0 END)`,
          avgDurationMs: sql<number>`AVG(CASE WHEN ${runs.startedAt} IS NOT NULL AND ${runs.completedAt} IS NOT NULL THEN (julianday(${runs.completedAt}) - julianday(${runs.startedAt})) * 86400000 ELSE NULL END)`,
        })
        .from(runs)
        .where(gte(runs.submittedAt, since))
        .get();

      const runCount = countRow?.total ?? 0;
      const successCount = countRow?.success ?? 0;
      const failureCount = countRow?.failure ?? 0;
      const avgDurationMs = countRow?.avgDurationMs ?? 0;

      const costRow = db
        .select({
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
        })
        .from(runCosts)
        .where(gte(runCosts.timestamp, since))
        .get();

      const totalCostUsd = costRow?.totalCostUsd ?? 0;

      const failureRows = db
        .select({
          mode: runOutcomes.failureMode,
          count: sql<number>`COUNT(*)`,
        })
        .from(runOutcomes)
        .where(sql`${runOutcomes.failureMode} IS NOT NULL AND ${runOutcomes.startedAt} >= ${since}`)
        .groupBy(runOutcomes.failureMode)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(5)
        .all();

      const topFailures = failureRows.map((r) => ({
        mode: r.mode!,
        count: r.count,
      }));

      return {
        runCount,
        successCount,
        failureCount,
        successRate: runCount > 0 ? successCount / runCount : 0,
        totalCostUsd,
        avgCostUsd: runCount > 0 ? totalCostUsd / runCount : 0,
        avgDurationMs,
        topFailures,
      };
    },

    getCostTrend(since: string): CostTrendPoint[] {
      const rows = db
        .select({
          date: sql<string>`DATE(${runCosts.timestamp})`,
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
          runCount: sql<number>`COUNT(DISTINCT ${runCosts.runId})`,
        })
        .from(runCosts)
        .where(gte(runCosts.timestamp, since))
        .groupBy(sql`DATE(${runCosts.timestamp})`)
        .orderBy(sql`DATE(${runCosts.timestamp})`)
        .all();

      return rows.map((r) => ({
        date: r.date,
        totalCostUsd: r.totalCostUsd,
        runCount: r.runCount,
      }));
    },

    getFailureHotspots(since: string): FailureHotspot[] {
      const rows = db
        .select({
          module: runOutcomes.modulesTouched,
          failureCount: sql<number>`SUM(CASE WHEN ${runOutcomes.status} = 'failed' THEN 1 ELSE 0 END)`,
          totalRuns: sql<number>`COUNT(*)`,
        })
        .from(runOutcomes)
        .where(sql`${runOutcomes.modulesTouched} IS NOT NULL AND ${runOutcomes.startedAt} >= ${since}`)
        .groupBy(runOutcomes.modulesTouched)
        .orderBy(sql`SUM(CASE WHEN ${runOutcomes.status} = 'failed' THEN 1 ELSE 0 END) DESC`)
        .limit(10)
        .all();

      const hotspots: FailureHotspot[] = [];
      for (const row of rows) {
        if (!row.module) continue;
        try {
          const modules: string[] = JSON.parse(row.module);
          for (const mod of modules) {
            hotspots.push({
              module: mod,
              failureCount: row.failureCount,
              totalRuns: row.totalRuns,
              failureRate: row.totalRuns > 0 ? row.failureCount / row.totalRuns : 0,
            });
          }
        } catch {
          hotspots.push({
            module: row.module,
            failureCount: row.failureCount,
            totalRuns: row.totalRuns,
            failureRate: row.totalRuns > 0 ? row.failureCount / row.totalRuns : 0,
          });
        }
      }

      hotspots.sort((a, b) => b.failureCount - a.failureCount);
      return hotspots.slice(0, 10);
    },
  };
}
