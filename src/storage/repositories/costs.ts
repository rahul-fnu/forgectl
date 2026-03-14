import { eq, sql, gte } from "drizzle-orm";
import { runCosts } from "../schema.js";
import { runs } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the run_costs table. */
export interface CostRow {
  id: number;
  runId: string;
  agentType: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface CostInsertParams {
  runId: string;
  agentType: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

/** Aggregated cost summary. */
export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  recordCount: number;
}

export interface CostRepository {
  insert(params: CostInsertParams): CostRow;
  findByRunId(runId: string): CostRow[];
  sumByRunId(runId: string): CostSummary;
  sumByWorkflow(workflow: string): CostSummary;
  sumSince(since: string): CostSummary;
  sumAll(): CostSummary;
}

function deserializeRow(raw: typeof runCosts.$inferSelect): CostRow {
  return {
    id: raw.id,
    runId: raw.runId,
    agentType: raw.agentType,
    model: raw.model,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUsd: parseFloat(raw.costUsd),
    timestamp: raw.timestamp,
  };
}

function emptySummary(): CostSummary {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, recordCount: 0 };
}

export function createCostRepository(db: AppDatabase): CostRepository {
  return {
    insert(params: CostInsertParams): CostRow {
      const values = {
        runId: params.runId,
        agentType: params.agentType,
        model: params.model ?? null,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costUsd: String(params.costUsd),
        timestamp: params.timestamp,
      };
      const result = db.insert(runCosts).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        runId: params.runId,
        agentType: params.agentType,
        model: params.model ?? null,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costUsd: params.costUsd,
        timestamp: params.timestamp,
      };
    },

    findByRunId(runId: string): CostRow[] {
      return db
        .select()
        .from(runCosts)
        .where(eq(runCosts.runId, runId))
        .all()
        .map(deserializeRow);
    },

    sumByRunId(runId: string): CostSummary {
      const row = db
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(${runCosts.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${runCosts.outputTokens}), 0)`,
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
          recordCount: sql<number>`COUNT(*)`,
        })
        .from(runCosts)
        .where(eq(runCosts.runId, runId))
        .get();
      return row ?? emptySummary();
    },

    sumByWorkflow(workflow: string): CostSummary {
      const row = db
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(${runCosts.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${runCosts.outputTokens}), 0)`,
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
          recordCount: sql<number>`COUNT(*)`,
        })
        .from(runCosts)
        .innerJoin(runs, eq(runCosts.runId, runs.id))
        .where(eq(runs.workflow, workflow))
        .get();
      return row ?? emptySummary();
    },

    sumSince(since: string): CostSummary {
      const row = db
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(${runCosts.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${runCosts.outputTokens}), 0)`,
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
          recordCount: sql<number>`COUNT(*)`,
        })
        .from(runCosts)
        .where(gte(runCosts.timestamp, since))
        .get();
      return row ?? emptySummary();
    },

    sumAll(): CostSummary {
      const row = db
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(${runCosts.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${runCosts.outputTokens}), 0)`,
          totalCostUsd: sql<number>`COALESCE(SUM(CAST(${runCosts.costUsd} AS REAL)), 0)`,
          recordCount: sql<number>`COUNT(*)`,
        })
        .from(runCosts)
        .get();
      return row ?? emptySummary();
    },
  };
}
