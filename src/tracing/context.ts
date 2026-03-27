import crypto from "node:crypto";

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number | null;
  status: "running" | "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createSpan(
  traceId: string,
  name: string,
  parentSpanId?: string,
): Span {
  return {
    traceId,
    spanId: crypto.randomBytes(8).toString("hex"),
    parentSpanId: parentSpanId ?? null,
    name,
    startMs: Date.now(),
    endMs: null,
    status: "running",
    attributes: {},
  };
}

export function endSpan(span: Span, status: "ok" | "error" = "ok"): Span {
  return { ...span, endMs: Date.now(), status };
}
