import { eq } from "drizzle-orm";
import { pipelineRuns } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the pipeline_runs table with JSON fields deserialized. */
export interface PipelineRunRow {
  id: string;
  pipelineDefinition: unknown;
  status: string;
  nodeStates: unknown;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineInsertParams {
  id: string;
  pipelineDefinition: unknown;
  status?: string;
  nodeStates?: unknown;
  startedAt: string;
}

export interface PipelineStatusUpdateParams {
  status: string;
  completedAt?: string;
}

export interface PipelineRepository {
  insert(params: PipelineInsertParams): PipelineRunRow;
  findById(id: string): PipelineRunRow | undefined;
  updateStatus(id: string, params: PipelineStatusUpdateParams): void;
  updateNodeStates(id: string, nodeStates: unknown): void;
  list(): PipelineRunRow[];
}

function deserializeRow(raw: typeof pipelineRuns.$inferSelect): PipelineRunRow {
  return {
    id: raw.id,
    pipelineDefinition: raw.pipelineDefinition ? JSON.parse(raw.pipelineDefinition) : null,
    status: raw.status,
    nodeStates: raw.nodeStates ? JSON.parse(raw.nodeStates) : null,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
  };
}

export function createPipelineRepository(db: AppDatabase): PipelineRepository {
  return {
    insert(params: PipelineInsertParams): PipelineRunRow {
      const values = {
        id: params.id,
        pipelineDefinition: JSON.stringify(params.pipelineDefinition),
        status: params.status ?? "running",
        nodeStates: params.nodeStates ? JSON.stringify(params.nodeStates) : null,
        startedAt: params.startedAt,
      };
      db.insert(pipelineRuns).values(values).run();
      return this.findById(params.id)!;
    },

    findById(id: string): PipelineRunRow | undefined {
      const row = db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get();
      return row ? deserializeRow(row) : undefined;
    },

    updateStatus(id: string, params: PipelineStatusUpdateParams): void {
      const updates: Record<string, unknown> = { status: params.status };
      if (params.completedAt !== undefined) updates.completedAt = params.completedAt;
      db.update(pipelineRuns).set(updates).where(eq(pipelineRuns.id, id)).run();
    },

    updateNodeStates(id: string, nodeStates: unknown): void {
      db.update(pipelineRuns)
        .set({ nodeStates: JSON.stringify(nodeStates) })
        .where(eq(pipelineRuns.id, id))
        .run();
    },

    list(): PipelineRunRow[] {
      return db.select().from(pipelineRuns).all().map(deserializeRow);
    },
  };
}
