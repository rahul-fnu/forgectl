import { eq } from "drizzle-orm";
import { runs } from "../schema.js";
import type { AppDatabase } from "../database.js";

/** A row from the runs table with JSON fields deserialized. */
export interface RunRow {
  id: string;
  task: string;
  workflow: string | null;
  status: string;
  options: unknown;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  pauseReason: string | null;
  pauseContext: unknown;
  approvalContext: unknown;
  approvalAction: string | null;
  githubCommentId: number | null;
  parentRunId: string | null;
  role: string | null;
  depth: number;
  maxChildren: number | null;
  childrenDispatched: number;
}

export interface RunInsertParams {
  id: string;
  task: string;
  workflow?: string;
  options?: unknown;
  status?: string;
  submittedAt: string;
  parentRunId?: string;
  role?: string;
  depth?: number;
  maxChildren?: number;
  childrenDispatched?: number;
}

export interface RunUpdateParams {
  status: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
  pauseReason?: string;
  pauseContext?: unknown;
  approvalContext?: unknown;
  approvalAction?: string;
  githubCommentId?: number;
  parentRunId?: string;
  role?: string;
  depth?: number;
  maxChildren?: number;
  childrenDispatched?: number;
}

export interface RunRepository {
  insert(params: RunInsertParams): RunRow;
  findById(id: string): RunRow | undefined;
  updateStatus(id: string, params: RunUpdateParams): void;
  findByStatus(status: string): RunRow[];
  list(): RunRow[];
  clearPauseContext(id: string): void;
  findByGithubCommentId(commentId: number): RunRow | undefined;
  setGithubCommentId(runId: string, commentId: number): void;
}

function deserializeRow(raw: typeof runs.$inferSelect): RunRow {
  return {
    id: raw.id,
    task: raw.task,
    workflow: raw.workflow,
    status: raw.status,
    options: raw.options ? JSON.parse(raw.options) : null,
    submittedAt: raw.submittedAt,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    result: raw.result ? JSON.parse(raw.result) : null,
    error: raw.error,
    pauseReason: raw.pauseReason ?? null,
    pauseContext: raw.pauseContext ? JSON.parse(raw.pauseContext) : null,
    approvalContext: raw.approvalContext ? JSON.parse(raw.approvalContext) : null,
    approvalAction: raw.approvalAction ?? null,
    githubCommentId: raw.githubCommentId ?? null,
    parentRunId: raw.parentRunId ?? null,
    role: raw.role ?? null,
    depth: raw.depth ?? 0,
    maxChildren: raw.maxChildren ?? null,
    childrenDispatched: raw.childrenDispatched ?? 0,
  };
}

export function createRunRepository(db: AppDatabase): RunRepository {
  return {
    insert(params: RunInsertParams): RunRow {
      const values = {
        id: params.id,
        task: params.task,
        workflow: params.workflow ?? null,
        status: params.status ?? "queued",
        options: params.options ? JSON.stringify(params.options) : null,
        submittedAt: params.submittedAt,
        parentRunId: params.parentRunId ?? null,
        role: params.role ?? null,
        depth: params.depth ?? 0,
        maxChildren: params.maxChildren ?? null,
        childrenDispatched: params.childrenDispatched ?? 0,
      };
      db.insert(runs).values(values).run();
      return this.findById(params.id)!;
    },

    findById(id: string): RunRow | undefined {
      const row = db.select().from(runs).where(eq(runs.id, id)).get();
      return row ? deserializeRow(row) : undefined;
    },

    updateStatus(id: string, params: RunUpdateParams): void {
      const updates: Record<string, unknown> = { status: params.status };
      if (params.startedAt !== undefined) updates.startedAt = params.startedAt;
      if (params.completedAt !== undefined) updates.completedAt = params.completedAt;
      if (params.result !== undefined) updates.result = JSON.stringify(params.result);
      if (params.error !== undefined) updates.error = params.error;
      if (params.pauseReason !== undefined)
        updates.pauseReason = params.pauseReason;
      if (params.pauseContext !== undefined)
        updates.pauseContext = JSON.stringify(params.pauseContext);
      if (params.approvalContext !== undefined)
        updates.approvalContext = JSON.stringify(params.approvalContext);
      if (params.approvalAction !== undefined)
        updates.approvalAction = params.approvalAction;
      if (params.githubCommentId !== undefined)
        updates.githubCommentId = params.githubCommentId;
      if (params.parentRunId !== undefined) updates.parentRunId = params.parentRunId;
      if (params.role !== undefined) updates.role = params.role;
      if (params.depth !== undefined) updates.depth = params.depth;
      if (params.maxChildren !== undefined) updates.maxChildren = params.maxChildren;
      if (params.childrenDispatched !== undefined)
        updates.childrenDispatched = params.childrenDispatched;
      db.update(runs).set(updates).where(eq(runs.id, id)).run();
    },

    findByStatus(status: string): RunRow[] {
      return db.select().from(runs).where(eq(runs.status, status)).all().map(deserializeRow);
    },

    list(): RunRow[] {
      return db.select().from(runs).all().map(deserializeRow);
    },

    clearPauseContext(id: string): void {
      db.update(runs)
        .set({ pauseReason: null, pauseContext: null })
        .where(eq(runs.id, id))
        .run();
    },

    findByGithubCommentId(commentId: number): RunRow | undefined {
      const row = db
        .select()
        .from(runs)
        .where(eq(runs.githubCommentId, commentId))
        .get();
      return row ? deserializeRow(row) : undefined;
    },

    setGithubCommentId(runId: string, commentId: number): void {
      db.update(runs)
        .set({ githubCommentId: commentId })
        .where(eq(runs.id, runId))
        .run();
    },
  };
}
