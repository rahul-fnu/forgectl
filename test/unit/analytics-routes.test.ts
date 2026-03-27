import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { OutcomeRepository, OutcomeRow } from "../../src/storage/repositories/outcomes.js";
import type { CostRepository, CostSummary } from "../../src/storage/repositories/costs.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function makeRow(overrides: Partial<OutcomeRow> & { id: string }): OutcomeRow {
  return {
    taskId: null,
    startedAt: null,
    completedAt: null,
    status: null,
    totalTurns: null,
    lintIterations: null,
    reviewRounds: null,
    reviewCommentsJson: null,
    failureMode: null,
    failureDetail: null,
    humanReviewResult: null,
    humanReviewComments: null,
    modulesTouched: null,
    filesChanged: null,
    testsAdded: null,
    rawEventsJson: null,
    contextEnabled: null,
    contextFilesJson: null,
    contextHitRate: null,
    recovered: null,
    ...overrides,
  };
}

function createMockOutcomeRepo(rows: OutcomeRow[]): OutcomeRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn(),
    findByStatus: vi.fn(),
    findAll: vi.fn().mockReturnValue(rows),
    update: vi.fn(),
  };
}

function createMockCostRepo(summaries: Map<string, CostSummary>): CostRepository {
  return {
    insert: vi.fn(),
    findByRunId: vi.fn().mockReturnValue([]),
    sumByRunId: vi.fn().mockImplementation((runId: string) => {
      return summaries.get(runId) ?? { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, recordCount: 0 };
    }),
    sumByWorkflow: vi.fn(),
    sumSince: vi.fn(),
    sumAll: vi.fn(),
  } as unknown as CostRepository;
}

describe("Analytics API Routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("GET /api/v1/analytics/tool-usage", () => {
    it("returns tool usage report shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const rows = [
        makeRow({ id: "r1", totalTurns: 5, lintIterations: 2, filesChanged: 3, testsAdded: 1 }),
        makeRow({ id: "r2", totalTurns: 10, lintIterations: 1, filesChanged: 5, testsAdded: 2 }),
      ];
      registerRoutes(app, queue, { outcomeRepo: createMockOutcomeRepo(rows) });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/tool-usage" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.totalRuns).toBe(2);
      expect(body.totalTurns).toBe(15);
      expect(body.totalLintIterations).toBe(3);
      expect(body.totalFilesChanged).toBe(8);
      expect(body.totalTestsAdded).toBe(3);
      expect(body.toolBreakdown).toBeInstanceOf(Array);
    });

    it("returns 503 when outcomeRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/tool-usage" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });

    it("includes tool breakdown from rawEventsJson", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const events = JSON.stringify([
        { type: "tool_use", data: { tool: "Read" } },
        { type: "tool_use", data: { tool: "Read" } },
        { type: "tool_use", data: { tool: "Edit" } },
      ]);
      const rows = [makeRow({ id: "r1", rawEventsJson: events })];
      registerRoutes(app, queue, { outcomeRepo: createMockOutcomeRepo(rows) });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/tool-usage" });
      const body = JSON.parse(res.body);
      expect(body.toolBreakdown.length).toBe(2);
      expect(body.toolBreakdown[0].tool).toBe("Read");
      expect(body.toolBreakdown[0].count).toBe(2);
      expect(body.toolBreakdown[1].tool).toBe("Edit");
      expect(body.toolBreakdown[1].count).toBe(1);
    });
  });

  describe("GET /api/v1/analytics/failure-patterns", () => {
    it("returns failure patterns report shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const rows = [
        makeRow({ id: "r1", status: "failure", failureMode: "LOOP", totalTurns: 15, lintIterations: 5 }),
        makeRow({ id: "r2", status: "success" }),
      ];
      registerRoutes(app, queue, { outcomeRepo: createMockOutcomeRepo(rows) });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/failure-patterns" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.totalRuns).toBe(2);
      expect(body.failedRuns).toBe(1);
      expect(body.topFailureModes).toBeInstanceOf(Array);
      expect(body.topFailureModes[0].mode).toBe("LOOP");
      expect(body.riskyModules).toBeInstanceOf(Array);
      expect(body.stuckPoints).toBeInstanceOf(Array);
      expect(body.stuckPoints.length).toBe(1);
      expect(body.stuckPoints[0].runId).toBe("r1");
      expect(body.recommendations).toBeInstanceOf(Array);
    });

    it("returns 503 when outcomeRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/failure-patterns" });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("GET /api/v1/analytics/token-waste", () => {
    it("returns token waste report shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const rows = [
        makeRow({ id: "r1", status: "failure", lintIterations: 4, totalTurns: 12 }),
        makeRow({ id: "r2", status: "success", lintIterations: 1, totalTurns: 5 }),
      ];
      const costSummaries = new Map<string, CostSummary>([
        ["r1", { totalInputTokens: 1000, totalOutputTokens: 500, totalCostUsd: 0.05, recordCount: 1 }],
        ["r2", { totalInputTokens: 800, totalOutputTokens: 400, totalCostUsd: 0.03, recordCount: 1 }],
      ]);
      registerRoutes(app, queue, {
        outcomeRepo: createMockOutcomeRepo(rows),
        costRepo: createMockCostRepo(costSummaries),
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/token-waste" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.totalRuns).toBe(2);
      expect(body.failedRuns).toBe(1);
      expect(body.totalTokens).toEqual({ input: 1800, output: 900 });
      expect(body.wastedTokens).toEqual({ input: 1000, output: 500 });
      expect(body.totalCostUsd).toBe(0.08);
      expect(body.wastedCostUsd).toBe(0.05);
      expect(body.highRetryRuns).toBeInstanceOf(Array);
      expect(body.highRetryRuns.length).toBe(1);
      expect(body.highRetryRuns[0].runId).toBe("r1");
    });

    it("returns 503 when outcomeRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/token-waste" });
      expect(res.statusCode).toBe(503);
    });

    it("returns 503 when costRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, { outcomeRepo: createMockOutcomeRepo([]) });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/token-waste" });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("Error envelope consistency", () => {
    it("all analytics 503 errors use { error: { code, message } } shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      for (const path of ["/api/v1/analytics/tool-usage", "/api/v1/analytics/failure-patterns", "/api/v1/analytics/token-waste"]) {
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode).toBe(503);

        const body = JSON.parse(res.body);
        expect(body.error).toHaveProperty("code");
        expect(body.error).toHaveProperty("message");
        expect(typeof body.error.code).toBe("string");
        expect(typeof body.error.message).toBe("string");
      }
    });
  });
});
