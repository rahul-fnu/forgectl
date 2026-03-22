import { eq, desc } from "drizzle-orm";
import { runRetries } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the run_retries table. */
export interface RetryRow {
  runId: string;
  attempt: number;
  nextRetryAt: string | null;
  backoffMs: number | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface RetryInsertParams {
  runId: string;
  attempt: number;
  nextRetryAt?: string;
  backoffMs?: number;
  failureReason?: string;
}

export interface RetryRepository {
  insert(params: RetryInsertParams): RetryRow;
  findByRunId(runId: string): RetryRow[];
  latestAttempt(runId: string): number;
  deleteByRunId(runId: string): void;
}

function deserializeRow(raw: typeof runRetries.$inferSelect): RetryRow {
  return {
    runId: raw.runId,
    attempt: raw.attempt,
    nextRetryAt: raw.nextRetryAt,
    backoffMs: raw.backoffMs,
    failureReason: raw.failureReason,
    createdAt: raw.createdAt,
  };
}

export function createRetryRepository(db: AppDatabase): RetryRepository {
  return {
    insert(params: RetryInsertParams): RetryRow {
      const values = {
        runId: params.runId,
        attempt: params.attempt,
        nextRetryAt: params.nextRetryAt ?? null,
        backoffMs: params.backoffMs ?? null,
        failureReason: params.failureReason ?? null,
      };
      db.insert(runRetries).values(values).run();
      return {
        runId: params.runId,
        attempt: params.attempt,
        nextRetryAt: params.nextRetryAt ?? null,
        backoffMs: params.backoffMs ?? null,
        failureReason: params.failureReason ?? null,
        createdAt: null, // SQLite default fills this
      };
    },

    findByRunId(runId: string): RetryRow[] {
      return db
        .select()
        .from(runRetries)
        .where(eq(runRetries.runId, runId))
        .all()
        .map(deserializeRow);
    },

    latestAttempt(runId: string): number {
      const row = db
        .select({ attempt: runRetries.attempt })
        .from(runRetries)
        .where(eq(runRetries.runId, runId))
        .orderBy(desc(runRetries.attempt))
        .limit(1)
        .get();
      return row?.attempt ?? 0;
    },

    deleteByRunId(runId: string): void {
      db.delete(runRetries).where(eq(runRetries.runId, runId)).run();
    },
  };
}
