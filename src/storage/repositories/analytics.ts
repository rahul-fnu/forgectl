import type { AppDatabase } from "../database.js";

export interface AnalyticsFilters {
  workflow?: string;
  status?: string;
  since?: string;
  until?: string;
}

export interface AnalyticsSummary {
  totalRuns: number;
  successRate: number;
  avgDuration: number;
  avgCost: number;
  totalCost: number;
  runsByStatus: Record<string, number>;
  costByDay: { day: string; cost: number }[];
  topFailingSteps: { step: string; count: number }[];
}

export interface SuccessRateByComplexity {
  complexityScore: number;
  totalRuns: number;
  successCount: number;
  successRate: number;
}

export interface ValidationFailureHotspot {
  step: string;
  failureCount: number;
  affectedRuns: number;
}

export interface CostTrendPoint {
  day: string;
  totalCost: number;
  runCount: number;
}

export interface SlowRun {
  id: string;
  task: string;
  workflow: string | null;
  durationSeconds: number;
  status: string;
}

export interface AnalyticsRepository {
  getSummary(filters?: AnalyticsFilters): AnalyticsSummary;
  getSuccessRateByComplexity(): SuccessRateByComplexity[];
  getValidationFailureHotspots(): ValidationFailureHotspot[];
  getCostTrend(days: number): CostTrendPoint[];
  getSlowRuns(limit: number): SlowRun[];
}

export function createAnalyticsRepository(db: AppDatabase): AnalyticsRepository {
  return {
    getSummary(filters?: AnalyticsFilters): AnalyticsSummary {
      const whereClauses: string[] = [];
      if (filters?.workflow) whereClauses.push(`r.workflow = '${filters.workflow}'`);
      if (filters?.status) whereClauses.push(`r.status = '${filters.status}'`);
      if (filters?.since) whereClauses.push(`r.submitted_at >= '${filters.since}'`);
      if (filters?.until) whereClauses.push(`r.submitted_at <= '${filters.until}'`);
      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

      const summaryRow = db.$client.prepare(`
        SELECT
          COUNT(*) AS total_runs,
          COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS success_rate,
          COALESCE(AVG(
            CASE WHEN r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
              THEN (julianday(r.completed_at) - julianday(r.started_at)) * 86400
              ELSE NULL END
          ), 0) AS avg_duration,
          COALESCE(AVG(c.run_cost), 0) AS avg_cost,
          COALESCE(SUM(c.run_cost), 0) AS total_cost
        FROM runs r
        LEFT JOIN (
          SELECT run_id, SUM(CAST(cost_usd AS REAL)) AS run_cost
          FROM run_costs GROUP BY run_id
        ) c ON c.run_id = r.id
        ${whereClause}
      `).get() as { total_runs: number; success_rate: number; avg_duration: number; avg_cost: number; total_cost: number };

      const statusRows = db.$client.prepare(`
        SELECT r.status, COUNT(*) AS cnt
        FROM runs r
        ${whereClause}
        GROUP BY r.status
      `).all() as { status: string; cnt: number }[];

      const runsByStatus: Record<string, number> = {};
      for (const row of statusRows) {
        runsByStatus[row.status] = row.cnt;
      }

      const costByDayRows = db.$client.prepare(`
        SELECT DATE(c.timestamp) AS day, SUM(CAST(c.cost_usd AS REAL)) AS cost
        FROM run_costs c
        INNER JOIN runs r ON r.id = c.run_id
        ${whereClause}
        GROUP BY DATE(c.timestamp)
        ORDER BY day
      `).all() as { day: string; cost: number }[];

      const costByDay = costByDayRows.map((r) => ({ day: r.day, cost: r.cost }));

      const failingStepsRows = db.$client.prepare(`
        SELECT e.type AS step, COUNT(*) AS cnt
        FROM run_events e
        INNER JOIN runs r ON r.id = e.run_id
        ${whereClause}
        AND e.type LIKE '%fail%'
        GROUP BY e.type
        ORDER BY cnt DESC
        LIMIT 10
      `).all() as { step: string; cnt: number }[];

      const topFailingSteps = failingStepsRows.map((r) => ({ step: r.step, count: r.cnt }));

      return {
        totalRuns: summaryRow.total_runs,
        successRate: summaryRow.success_rate,
        avgDuration: summaryRow.avg_duration,
        avgCost: summaryRow.avg_cost,
        totalCost: summaryRow.total_cost,
        runsByStatus,
        costByDay,
        topFailingSteps,
      };
    },

    getSuccessRateByComplexity(): SuccessRateByComplexity[] {
      const rows = db.$client.prepare(`
        SELECT
          r.complexity_score,
          COUNT(*) AS total_runs,
          SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS success_count,
          COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS success_rate
        FROM runs r
        WHERE r.complexity_score IS NOT NULL
        GROUP BY r.complexity_score
        ORDER BY r.complexity_score
      `).all() as { complexity_score: number; total_runs: number; success_count: number; success_rate: number }[];

      return rows.map((r) => ({
        complexityScore: r.complexity_score,
        totalRuns: r.total_runs,
        successCount: r.success_count,
        successRate: r.success_rate,
      }));
    },

    getValidationFailureHotspots(): ValidationFailureHotspot[] {
      const rows = db.$client.prepare(`
        SELECT
          e.type AS step,
          COUNT(*) AS failure_count,
          COUNT(DISTINCT e.run_id) AS affected_runs
        FROM run_events e
        WHERE e.type LIKE '%validation_fail%'
        GROUP BY e.type
        ORDER BY failure_count DESC
      `).all() as { step: string; failure_count: number; affected_runs: number }[];

      return rows.map((r) => ({
        step: r.step,
        failureCount: r.failure_count,
        affectedRuns: r.affected_runs,
      }));
    },

    getCostTrend(days: number): CostTrendPoint[] {
      const rows = db.$client.prepare(`
        SELECT
          DATE(c.timestamp) AS day,
          SUM(CAST(c.cost_usd AS REAL)) AS total_cost,
          COUNT(DISTINCT c.run_id) AS run_count
        FROM run_costs c
        WHERE c.timestamp >= DATE('now', '-' || ? || ' days')
        GROUP BY DATE(c.timestamp)
        ORDER BY day
      `).all(days) as { day: string; total_cost: number; run_count: number }[];

      return rows.map((r) => ({
        day: r.day,
        totalCost: r.total_cost,
        runCount: r.run_count,
      }));
    },

    getSlowRuns(limit: number): SlowRun[] {
      const rows = db.$client.prepare(`
        SELECT
          r.id,
          r.task,
          r.workflow,
          (julianday(r.completed_at) - julianday(r.started_at)) * 86400 AS duration_seconds,
          r.status
        FROM runs r
        WHERE r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
        ORDER BY duration_seconds DESC
        LIMIT ?
      `).all(limit) as { id: string; task: string; workflow: string | null; duration_seconds: number; status: string }[];

      return rows.map((r) => ({
        id: r.id,
        task: r.task,
        workflow: r.workflow,
        durationSeconds: r.duration_seconds,
        status: r.status,
      }));
    },
  };
}
