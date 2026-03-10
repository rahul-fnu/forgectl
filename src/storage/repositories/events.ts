import { eq, and } from "drizzle-orm";
import { runEvents } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the run_events table with JSON fields deserialized. */
export interface EventRow {
  id: number;
  runId: string;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface EventInsertParams {
  runId: string;
  type: string;
  timestamp: string;
  data?: unknown;
}

export interface EventRepository {
  insert(params: EventInsertParams): EventRow;
  findByRunId(runId: string): EventRow[];
  findByRunIdAndType(runId: string, type: string): EventRow[];
}

function deserializeRow(raw: typeof runEvents.$inferSelect): EventRow {
  return {
    id: raw.id,
    runId: raw.runId,
    type: raw.type,
    timestamp: raw.timestamp,
    data: raw.data ? JSON.parse(raw.data) : null,
  };
}

export function createEventRepository(db: AppDatabase): EventRepository {
  return {
    insert(params: EventInsertParams): EventRow {
      const values = {
        runId: params.runId,
        type: params.type,
        timestamp: params.timestamp,
        data:
          params.data !== undefined && params.data !== null
            ? JSON.stringify(params.data)
            : null,
      };
      const result = db.insert(runEvents).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        runId: params.runId,
        type: params.type,
        timestamp: params.timestamp,
        data:
          params.data !== undefined && params.data !== null
            ? params.data
            : null,
      };
    },

    findByRunId(runId: string): EventRow[] {
      return db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .all()
        .map(deserializeRow);
    },

    findByRunIdAndType(runId: string, type: string): EventRow[] {
      return db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
        .all()
        .map(deserializeRow);
    },
  };
}
