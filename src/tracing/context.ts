export function generateTraceId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export function createSpan(traceId: string, name: string, parentSpanId?: string) {
  return { traceId, spanId: generateTraceId(), parentSpanId, name, startMs: Date.now(), endMs: 0, status: "ok", attributes: {} };
}

export function endSpan(span: ReturnType<typeof createSpan>, status = "ok"): void {
  span.endMs = Date.now();
  span.status = status;
}
