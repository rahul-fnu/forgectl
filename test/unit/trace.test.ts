import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerRoutes } from "../../src/daemon/routes.js";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createTraceRepository, type TraceRepository } from "../../src/storage/repositories/traces.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { SpanRow } from "../../src/storage/repositories/traces.js";
import { buildWaterfallLines, formatWaterfall } from "../../src/cli/trace.js";

function createMockQueue(): RunQueue {
  return {
    submit: () => {},
    get: () => undefined,
    list: () => [],
    processNext: () => {},
  } as unknown as RunQueue;
}

// --- API tests ---

describe("GET /api/v1/traces/:traceId", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let traceRepo: TraceRepository;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-trace-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    traceRepo = createTraceRepository(db);

    app = Fastify();
    registerRoutes(app, createMockQueue(), { traceRepo });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 503 when traceRepo is not configured", async () => {
    const app2 = Fastify();
    registerRoutes(app2, createMockQueue(), {});
    await app2.ready();

    const res = await app2.inject({ method: "GET", url: "/api/v1/traces/run-123" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");

    await app2.close();
  });

  it("returns 404 when trace has no spans", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/traces/nonexistent" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns spans sorted by startMs", async () => {
    traceRepo.insert({ traceId: "run-1", spanId: "s2", operationName: "validate", startMs: 200, durationMs: 50 });
    traceRepo.insert({ traceId: "run-1", spanId: "s1", operationName: "build", startMs: 100, durationMs: 80 });
    traceRepo.insert({ traceId: "run-1", spanId: "s3", parentSpanId: "s1", operationName: "compile", startMs: 110, durationMs: 40 });

    const res = await app.inject({ method: "GET", url: "/api/v1/traces/run-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SpanRow[];
    expect(body).toHaveLength(3);
    expect(body[0].spanId).toBe("s1");
    expect(body[1].spanId).toBe("s3");
    expect(body[2].spanId).toBe("s2");
  });

  it("returns correct span shape", async () => {
    traceRepo.insert({
      traceId: "run-2",
      spanId: "s1",
      parentSpanId: null,
      operationName: "agent-invoke",
      startMs: 0,
      durationMs: 1000,
      status: "ok",
      attributes: { model: "claude" },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/traces/run-2" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SpanRow[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      traceId: "run-2",
      spanId: "s1",
      parentSpanId: null,
      operationName: "agent-invoke",
      startMs: 0,
      durationMs: 1000,
      status: "ok",
      attributes: { model: "claude" },
    });
  });
});

// --- CLI waterfall formatting tests ---

describe("buildWaterfallLines", () => {
  it("returns empty array for no spans", () => {
    expect(buildWaterfallLines([])).toEqual([]);
  });

  it("builds hierarchy from parent-child spans", () => {
    const spans: SpanRow[] = [
      { id: 1, traceId: "t1", spanId: "root", parentSpanId: null, operationName: "run", startMs: 0, durationMs: 100, status: "ok", attributes: null },
      { id: 2, traceId: "t1", spanId: "child", parentSpanId: "root", operationName: "build", startMs: 10, durationMs: 50, status: "ok", attributes: null },
    ];

    const lines = buildWaterfallLines(spans);
    expect(lines).toHaveLength(2);
    expect(lines[0].indent).toBe(0);
    expect(lines[0].operationName).toBe("run");
    expect(lines[1].indent).toBe(1);
    expect(lines[1].operationName).toBe("build");
  });

  it("includes duration and offset", () => {
    const spans: SpanRow[] = [
      { id: 1, traceId: "t1", spanId: "s1", parentSpanId: null, operationName: "op", startMs: 100, durationMs: 200, status: "ok", attributes: null },
    ];

    const lines = buildWaterfallLines(spans);
    expect(lines[0].durationMs).toBe(200);
    expect(lines[0].offsetMs).toBe(0);
  });

  it("produces bar characters", () => {
    const spans: SpanRow[] = [
      { id: 1, traceId: "t1", spanId: "s1", parentSpanId: null, operationName: "op", startMs: 0, durationMs: 100, status: "ok", attributes: null },
    ];

    const lines = buildWaterfallLines(spans);
    expect(lines[0].bar).toContain("█");
  });
});

describe("formatWaterfall", () => {
  it("returns no spans message for empty input", () => {
    expect(formatWaterfall([])).toBe("No spans found");
  });

  it("formats lines with name, duration, and bar", () => {
    const lines = [
      { indent: 0, operationName: "run", durationMs: 100, bar: "████", offsetMs: 0 },
      { indent: 1, operationName: "build", durationMs: 50, bar: "  ██", offsetMs: 10 },
    ];

    const output = formatWaterfall(lines);
    expect(output).toContain("run");
    expect(output).toContain("100ms");
    expect(output).toContain("build");
    expect(output).toContain("50ms");
    expect(output).toContain("|");
  });

  it("indents child spans", () => {
    const lines = [
      { indent: 0, operationName: "parent", durationMs: 100, bar: "████", offsetMs: 0 },
      { indent: 1, operationName: "child", durationMs: 50, bar: "██", offsetMs: 10 },
    ];

    const output = formatWaterfall(lines);
    const outputLines = output.split("\n");
    expect(outputLines[1]).toMatch(/^\s{2}child/);
  });
});
