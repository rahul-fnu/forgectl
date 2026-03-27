import { eq } from "drizzle-orm";
import { spans } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface SpanRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  startMs: number;
  durationMs: number;
  status: string;
  attributes: unknown;
}

export interface SpanInsertParams {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  operationName: string;
  startMs: number;
  durationMs: number;
  status?: string;
  attributes?: unknown;
}

export interface TraceRepository {
  insert(params: SpanInsertParams): SpanRow;
  findByTraceId(traceId: string): SpanRow[];
}

function deserializeRow(raw: typeof spans.$inferSelect): SpanRow {
  return {
    id: raw.id,
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    operationName: raw.operationName,
    startMs: raw.startMs,
    durationMs: raw.durationMs,
    status: raw.status,
    attributes: raw.attributes ? JSON.parse(raw.attributes) : null,
  };
}

export function createTraceRepository(db: AppDatabase): TraceRepository {
  return {
    insert(params: SpanInsertParams): SpanRow {
      const values = {
        traceId: params.traceId,
        spanId: params.spanId,
        parentSpanId: params.parentSpanId ?? null,
        operationName: params.operationName,
        startMs: params.startMs,
        durationMs: params.durationMs,
        status: params.status ?? "ok",
        attributes: params.attributes != null ? JSON.stringify(params.attributes) : null,
      };
      const result = db.insert(spans).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        traceId: params.traceId,
        spanId: params.spanId,
        parentSpanId: params.parentSpanId ?? null,
        operationName: params.operationName,
        startMs: params.startMs,
        durationMs: params.durationMs,
        status: params.status ?? "ok",
        attributes: params.attributes ?? null,
      };
    },

    findByTraceId(traceId: string): SpanRow[] {
      return db
        .select()
        .from(spans)
        .where(eq(spans.traceId, traceId))
        .all()
        .map(deserializeRow)
        .sort((a, b) => a.startMs - b.startMs);
    },
  };
}
