import { and, count, eq } from "drizzle-orm";
import { delegations } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the delegations table with JSON fields deserialized. */
export interface DelegationRow {
  id: number;
  parentRunId: string;
  childRunId: string | null;
  taskSpec: unknown;
  status: string;
  result: unknown;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DelegationInsertParams {
  parentRunId: string;
  childRunId?: string;
  taskSpec: unknown;
  status?: string;
  createdAt: string;
}

export interface DelegationRepository {
  insert(params: DelegationInsertParams): DelegationRow;
  findById(id: number): DelegationRow | undefined;
  findByParentRunId(parentRunId: string): DelegationRow[];
  findByChildRunId(childRunId: string): DelegationRow | undefined;
  updateStatus(id: number, status: string, result?: unknown): void;
  countByParentAndStatus(parentRunId: string, status: string): number;
  list(): DelegationRow[];
}

function deserializeRow(raw: typeof delegations.$inferSelect): DelegationRow {
  return {
    id: raw.id,
    parentRunId: raw.parentRunId,
    childRunId: raw.childRunId ?? null,
    taskSpec: raw.taskSpec ? JSON.parse(raw.taskSpec) : null,
    status: raw.status,
    result: raw.result ? JSON.parse(raw.result) : null,
    retryCount: raw.retryCount,
    lastError: raw.lastError ?? null,
    createdAt: raw.createdAt,
    completedAt: raw.completedAt ?? null,
  };
}

export function createDelegationRepository(db: AppDatabase): DelegationRepository {
  return {
    insert(params: DelegationInsertParams): DelegationRow {
      const result = db
        .insert(delegations)
        .values({
          parentRunId: params.parentRunId,
          childRunId: params.childRunId ?? null,
          taskSpec: JSON.stringify(params.taskSpec),
          status: params.status ?? "pending",
          createdAt: params.createdAt,
        })
        .run();
      const id = Number(result.lastInsertRowid);
      return this.findById(id)!;
    },

    findById(id: number): DelegationRow | undefined {
      const row = db.select().from(delegations).where(eq(delegations.id, id)).get();
      return row ? deserializeRow(row) : undefined;
    },

    findByParentRunId(parentRunId: string): DelegationRow[] {
      return db
        .select()
        .from(delegations)
        .where(eq(delegations.parentRunId, parentRunId))
        .all()
        .map(deserializeRow);
    },

    findByChildRunId(childRunId: string): DelegationRow | undefined {
      const row = db
        .select()
        .from(delegations)
        .where(eq(delegations.childRunId, childRunId))
        .get();
      return row ? deserializeRow(row) : undefined;
    },

    updateStatus(id: number, status: string, result?: unknown): void {
      const updates: Record<string, unknown> = { status };
      if (result !== undefined) {
        updates.result = JSON.stringify(result);
      }
      if (status === "completed" || status === "failed") {
        updates.completedAt = new Date().toISOString();
      }
      db.update(delegations).set(updates).where(eq(delegations.id, id)).run();
    },

    countByParentAndStatus(parentRunId: string, status: string): number {
      const result = db
        .select({ count: count() })
        .from(delegations)
        .where(and(eq(delegations.parentRunId, parentRunId), eq(delegations.status, status)))
        .get();
      return result?.count ?? 0;
    },

    list(): DelegationRow[] {
      return db.select().from(delegations).all().map(deserializeRow);
    },
  };
}
