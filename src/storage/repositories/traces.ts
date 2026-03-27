import { eq } from "drizzle-orm";
import { traces } from "../schema.js";
import type { AppDatabase } from "../database.js";
import type { Span } from "../../tracing/context.js";

export interface TraceRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number | null;
  status: string;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceRepository {
  insertSpan(span: Span): TraceRow;
  findByTraceId(traceId: string): TraceRow[];
}

function deserializeRow(raw: typeof traces.$inferSelect): TraceRow {
  return {
    id: raw.id,
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId ?? null,
    name: raw.name,
    startMs: raw.startMs,
    endMs: raw.endMs ?? null,
    status: raw.status,
    attributes: raw.attributes ? JSON.parse(raw.attributes) : {},
  };
}

export function createTraceRepository(db: AppDatabase): TraceRepository {
  return {
    insertSpan(span: Span): TraceRow {
      const values = {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startMs: span.startMs,
        endMs: span.endMs,
        status: span.status,
        attributes: Object.keys(span.attributes).length > 0
          ? JSON.stringify(span.attributes)
          : null,
      };
      const result = db.insert(traces).values(values).run();
      const id = Number(result.lastInsertRowid);
      return {
        id,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startMs: span.startMs,
        endMs: span.endMs,
        status: span.status,
        attributes: span.attributes,
      };
    },

    findByTraceId(traceId: string): TraceRow[] {
      return db
        .select()
        .from(traces)
        .where(eq(traces.traceId, traceId))
        .all()
        .map(deserializeRow);
    },
  };
}
