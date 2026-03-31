import { eq, desc } from "drizzle-orm";
import { runSnapshots } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the run_snapshots table with JSON fields deserialized. */
export interface SnapshotRow {
  id: number;
  runId: string;
  stepName: string;
  timestamp: string;
  state: unknown;
}

export interface SnapshotInsertParams {
  runId: string;
  stepName: string;
  timestamp: string;
  state: unknown;
}

export interface SnapshotRepository {
  insert(params: SnapshotInsertParams): SnapshotRow;
  findByRunId(runId: string): SnapshotRow[];
  latest(runId: string): SnapshotRow | undefined;
}

function deserializeRow(raw: typeof runSnapshots.$inferSelect): SnapshotRow {
  return {
    id: raw.id,
    runId: raw.runId,
    stepName: raw.stepName,
    timestamp: raw.timestamp,
    state: JSON.parse(raw.state),
  };
}

export function createSnapshotRepository(db: AppDatabase): SnapshotRepository {
  return {
    insert(params: SnapshotInsertParams): SnapshotRow {
      const values = {
        runId: params.runId,
        stepName: params.stepName,
        timestamp: params.timestamp,
        state: JSON.stringify(params.state),
      };
      const result = db.insert(runSnapshots).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        runId: params.runId,
        stepName: params.stepName,
        timestamp: params.timestamp,
        state: params.state,
      };
    },

    findByRunId(runId: string): SnapshotRow[] {
      return db
        .select()
        .from(runSnapshots)
        .where(eq(runSnapshots.runId, runId))
        .all()
        .map(deserializeRow);
    },

    latest(runId: string): SnapshotRow | undefined {
      const row = db
        .select()
        .from(runSnapshots)
        .where(eq(runSnapshots.runId, runId))
        .orderBy(desc(runSnapshots.id))
        .limit(1)
        .get();
      return row ? deserializeRow(row) : undefined;
    },
  };
}
