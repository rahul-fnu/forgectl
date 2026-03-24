import { eq } from "drizzle-orm";
import { runOutcomes } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface OutcomeInsertParams {
  id: string;
  taskId?: string;
  startedAt?: string;
  completedAt?: string;
  status: string;
  totalTurns?: number;
  lintIterations?: number;
  reviewRounds?: number;
  reviewCommentsJson?: string;
  failureMode?: string;
  failureDetail?: string;
  humanReviewResult?: string;
  humanReviewComments?: number;
  modulesTouched?: string; // JSON array string
  filesChanged?: number;
  testsAdded?: number;
  rawEventsJson?: string; // JSON string
  contextEnabled?: number; // 1 = enabled, 0 = disabled
  contextFilesJson?: string; // JSON array of pre-provided context file paths
  contextHitRate?: number; // ratio of pre-provided files agent actually used
  recovered?: number; // 1 = recovered from crash, 0 = normal
}

export interface OutcomeRow {
  id: string;
  taskId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  status: string | null;
  totalTurns: number | null;
  lintIterations: number | null;
  reviewRounds: number | null;
  reviewCommentsJson: string | null;
  failureMode: string | null;
  failureDetail: string | null;
  humanReviewResult: string | null;
  humanReviewComments: number | null;
  modulesTouched: string | null;
  filesChanged: number | null;
  testsAdded: number | null;
  rawEventsJson: string | null;
  contextEnabled: number | null;
  contextFilesJson: string | null;
  contextHitRate: number | null;
  recovered: number | null;
}

export interface OutcomeRepository {
  insert(params: OutcomeInsertParams): void;
  findById(id: string): OutcomeRow | undefined;
  findByStatus(status: string): OutcomeRow[];
  findAll(): OutcomeRow[];
  update(id: string, params: Partial<OutcomeInsertParams>): void;
}

function deserializeRow(raw: typeof runOutcomes.$inferSelect): OutcomeRow {
  return {
    id: raw.id,
    taskId: raw.taskId,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    status: raw.status,
    totalTurns: raw.totalTurns,
    lintIterations: raw.lintIterations,
    reviewRounds: raw.reviewRounds,
    reviewCommentsJson: raw.reviewCommentsJson,
    failureMode: raw.failureMode,
    failureDetail: raw.failureDetail,
    humanReviewResult: raw.humanReviewResult,
    humanReviewComments: raw.humanReviewComments,
    modulesTouched: raw.modulesTouched,
    filesChanged: raw.filesChanged,
    testsAdded: raw.testsAdded,
    rawEventsJson: raw.rawEventsJson,
    contextEnabled: raw.contextEnabled,
    contextFilesJson: raw.contextFilesJson,
    contextHitRate: raw.contextHitRate,
    recovered: raw.recovered,
  };
}

export function createOutcomeRepository(db: AppDatabase): OutcomeRepository {
  return {
    insert(params: OutcomeInsertParams): void {
      const values = {
        id: params.id,
        taskId: params.taskId ?? null,
        startedAt: params.startedAt ?? null,
        completedAt: params.completedAt ?? null,
        status: params.status,
        totalTurns: params.totalTurns ?? null,
        lintIterations: params.lintIterations ?? null,
        reviewRounds: params.reviewRounds ?? null,
        reviewCommentsJson: params.reviewCommentsJson ?? null,
        failureMode: params.failureMode ?? null,
        failureDetail: params.failureDetail ?? null,
        humanReviewResult: params.humanReviewResult ?? null,
        humanReviewComments: params.humanReviewComments ?? null,
        modulesTouched: params.modulesTouched ?? null,
        filesChanged: params.filesChanged ?? null,
        testsAdded: params.testsAdded ?? null,
        rawEventsJson: params.rawEventsJson ?? null,
        contextEnabled: params.contextEnabled ?? null,
        contextFilesJson: params.contextFilesJson ?? null,
        contextHitRate: params.contextHitRate ?? null,
        recovered: params.recovered ?? null,
      };
      db.insert(runOutcomes).values(values).run();
    },

    findById(id: string): OutcomeRow | undefined {
      const row = db
        .select()
        .from(runOutcomes)
        .where(eq(runOutcomes.id, id))
        .get();
      return row ? deserializeRow(row) : undefined;
    },

    findByStatus(status: string): OutcomeRow[] {
      return db
        .select()
        .from(runOutcomes)
        .where(eq(runOutcomes.status, status))
        .all()
        .map(deserializeRow);
    },

    findAll(): OutcomeRow[] {
      return db.select().from(runOutcomes).all().map(deserializeRow);
    },

    update(id: string, params: Partial<OutcomeInsertParams>): void {
      const values: Record<string, unknown> = {};
      if (params.taskId !== undefined) values.taskId = params.taskId;
      if (params.startedAt !== undefined) values.startedAt = params.startedAt;
      if (params.completedAt !== undefined) values.completedAt = params.completedAt;
      if (params.status !== undefined) values.status = params.status;
      if (params.totalTurns !== undefined) values.totalTurns = params.totalTurns;
      if (params.lintIterations !== undefined) values.lintIterations = params.lintIterations;
      if (params.reviewRounds !== undefined) values.reviewRounds = params.reviewRounds;
      if (params.reviewCommentsJson !== undefined) values.reviewCommentsJson = params.reviewCommentsJson;
      if (params.failureMode !== undefined) values.failureMode = params.failureMode;
      if (params.failureDetail !== undefined) values.failureDetail = params.failureDetail;
      if (params.humanReviewResult !== undefined) values.humanReviewResult = params.humanReviewResult;
      if (params.humanReviewComments !== undefined) values.humanReviewComments = params.humanReviewComments;
      if (params.modulesTouched !== undefined) values.modulesTouched = params.modulesTouched;
      if (params.filesChanged !== undefined) values.filesChanged = params.filesChanged;
      if (params.testsAdded !== undefined) values.testsAdded = params.testsAdded;
      if (params.rawEventsJson !== undefined) values.rawEventsJson = params.rawEventsJson;
      if (params.contextEnabled !== undefined) values.contextEnabled = params.contextEnabled;
      if (params.contextFilesJson !== undefined) values.contextFilesJson = params.contextFilesJson;
      if (params.contextHitRate !== undefined) values.contextHitRate = params.contextHitRate;
      if (params.recovered !== undefined) values.recovered = params.recovered;

      if (Object.keys(values).length > 0) {
        db.update(runOutcomes).set(values).where(eq(runOutcomes.id, id)).run();
      }
    },
  };
}
