import { eq } from "drizzle-orm";
import { spans } from "../schema.js";
import type { AppDatabase } from "../database.js";
import type { Span } from "../../tracing/context.js";

export interface SpanRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number | null;
  status: string;
  attributes: Record<string, unknown>;
}

export interface TraceRepository {
  insertSpan(span: Span): SpanRow;
  findByTraceId(traceId: string): SpanRow[];
}

function toRow(raw: typeof spans.$inferSelect): SpanRow {
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
    insertSpan(span: Span): SpanRow {
      const result = db
        .insert(spans)
        .values({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          startMs: span.startMs,
          endMs: span.endMs,
          status: span.status,
          attributes: JSON.stringify(span.attributes),
        })
        .returning()
        .get();
      return toRow(result);
    },

    findByTraceId(traceId: string): SpanRow[] {
      return db
        .select()
        .from(spans)
        .where(eq(spans.traceId, traceId))
        .all()
        .map(toRow);
    },
  };
}
