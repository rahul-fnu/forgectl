import { eq, ne } from "drizzle-orm";
import { executionLocks } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the execution_locks table. */
export interface LockRow {
  id: number;
  lockType: string;
  lockKey: string;
  ownerId: string;
  daemonPid: number;
  acquiredAt: string;
}

export interface LockInsertParams {
  lockType: string;
  lockKey: string;
  ownerId: string;
  daemonPid: number;
}

export interface LockRepository {
  insert(params: LockInsertParams): LockRow;
  findByDaemonPid(pid: number): LockRow[];
  deleteByOwner(ownerId: string): void;
  deleteByStale(currentPid: number): number;
  deleteAll(): void;
}

function deserializeRow(raw: typeof executionLocks.$inferSelect): LockRow {
  return {
    id: raw.id,
    lockType: raw.lockType,
    lockKey: raw.lockKey,
    ownerId: raw.ownerId,
    daemonPid: raw.daemonPid,
    acquiredAt: raw.acquiredAt,
  };
}

export function createLockRepository(db: AppDatabase): LockRepository {
  return {
    insert(params: LockInsertParams): LockRow {
      const acquiredAt = new Date().toISOString();
      const values = {
        lockType: params.lockType,
        lockKey: params.lockKey,
        ownerId: params.ownerId,
        daemonPid: params.daemonPid,
        acquiredAt,
      };
      const result = db.insert(executionLocks).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        lockType: params.lockType,
        lockKey: params.lockKey,
        ownerId: params.ownerId,
        daemonPid: params.daemonPid,
        acquiredAt,
      };
    },

    findByDaemonPid(pid: number): LockRow[] {
      return db
        .select()
        .from(executionLocks)
        .where(eq(executionLocks.daemonPid, pid))
        .all()
        .map(deserializeRow);
    },

    deleteByOwner(ownerId: string): void {
      db.delete(executionLocks)
        .where(eq(executionLocks.ownerId, ownerId))
        .run();
    },

    deleteByStale(currentPid: number): number {
      const result = db
        .delete(executionLocks)
        .where(ne(executionLocks.daemonPid, currentPid))
        .run();
      return result.changes;
    },

    deleteAll(): void {
      db.delete(executionLocks).run();
    },
  };
}
