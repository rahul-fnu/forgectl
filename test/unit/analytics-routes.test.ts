import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { AnalyticsRepository, AnalyticsSummary, CostTrendPoint, FailureHotspot, RetryPattern, WorkflowBreakdown, FullMetrics } from "../../src/storage/repositories/analytics.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function createMockAnalyticsRepo(overrides: Partial<{
  summary: AnalyticsSummary;
  costTrend: CostTrendPoint[];
  failureHotspots: FailureHotspot[];
  retryPatterns: RetryPattern[];
  workflowBreakdown: WorkflowBreakdown[];
  fullMetrics: FullMetrics;
}> = {}): AnalyticsRepository {
  const defaultSummary: AnalyticsSummary = {
    runCount: 10,
    successCount: 8,
    failureCount: 2,
    successRate: 0.8,
    totalCostUsd: 1.5,
    avgCostUsd: 0.15,
    avgDurationMs: 30000,
    topFailures: [{ mode: "lint_failure", count: 2 }],
  };

  const defaultRetryPatterns: RetryPattern[] = [
    { failureReason: "lint_failure", count: 3, avgAttempts: 2.1 },
  ];

  const defaultWorkflowBreakdown: WorkflowBreakdown[] = [
    { workflow: "code", runCount: 7, successCount: 6, failureCount: 1, successRate: 0.857, totalCostUsd: 1.2, avgDurationMs: 25000 },
    { workflow: "research", runCount: 3, successCount: 2, failureCount: 1, successRate: 0.667, totalCostUsd: 0.3, avgDurationMs: 40000 },
  ];

  const defaultCostTrend = overrides.costTrend ?? [
    { date: "2026-03-20", totalCostUsd: 0.5, runCount: 3 },
    { date: "2026-03-21", totalCostUsd: 1.0, runCount: 7 },
  ];

  const defaultHotspots = overrides.failureHotspots ?? [
    { module: "src/auth", failureCount: 3, totalRuns: 5, failureRate: 0.6 },
  ];

  const defaultFullMetrics: FullMetrics = overrides.fullMetrics ?? {
    summary: overrides.summary ?? defaultSummary,
    costTrend: defaultCostTrend,
    failureHotspots: defaultHotspots,
    retryPatterns: overrides.retryPatterns ?? defaultRetryPatterns,
    workflowBreakdown: overrides.workflowBreakdown ?? defaultWorkflowBreakdown,
  };

  return {
    getSummary: vi.fn().mockReturnValue(overrides.summary ?? defaultSummary),
    getCostTrend: vi.fn().mockReturnValue(defaultCostTrend),
    getFailureHotspots: vi.fn().mockReturnValue(defaultHotspots),
    getRetryPatterns: vi.fn().mockReturnValue(overrides.retryPatterns ?? defaultRetryPatterns),
    getWorkflowBreakdown: vi.fn().mockReturnValue(overrides.workflowBreakdown ?? defaultWorkflowBreakdown),
    getFullMetrics: vi.fn().mockReturnValue(defaultFullMetrics),
  };
}

describe("Analytics API Routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("GET /api/v1/analytics/summary", () => {
    it("returns analytics summary with expected shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/summary" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.runCount).toBe(10);
      expect(body.successCount).toBe(8);
      expect(body.failureCount).toBe(2);
      expect(body.successRate).toBe(0.8);
      expect(body.totalCostUsd).toBe(1.5);
      expect(body.avgCostUsd).toBe(0.15);
      expect(body.avgDurationMs).toBe(30000);
      expect(body.topFailures).toBeInstanceOf(Array);
      expect(body.topFailures[0].mode).toBe("lint_failure");
    });

    it("passes since query param to repository", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      await app.inject({ method: "GET", url: "/api/v1/analytics/summary?since=2026-03-20T00:00:00Z" });
      expect(analyticsRepo.getSummary).toHaveBeenCalledWith("2026-03-20T00:00:00Z");
    });

    it("defaults to 7-day window when no since provided", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      await app.inject({ method: "GET", url: "/api/v1/analytics/summary" });
      const calledWith = (analyticsRepo.getSummary as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const sinceDate = new Date(calledWith);
      const diff = Date.now() - sinceDate.getTime();
      expect(diff).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    });

    it("returns 503 when analytics repo not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/summary" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });
  });

  describe("GET /api/v1/analytics/cost-trend", () => {
    it("returns cost trend array", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/cost-trend" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body).toBeInstanceOf(Array);
      expect(body.length).toBe(2);
      expect(body[0]).toHaveProperty("date");
      expect(body[0]).toHaveProperty("totalCostUsd");
      expect(body[0]).toHaveProperty("runCount");
    });

    it("returns 503 when analytics repo not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/cost-trend" });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("GET /api/v1/analytics/failure-hotspots", () => {
    it("returns failure hotspots array", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/failure-hotspots" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body).toBeInstanceOf(Array);
      expect(body[0]).toHaveProperty("module");
      expect(body[0]).toHaveProperty("failureCount");
      expect(body[0]).toHaveProperty("totalRuns");
      expect(body[0]).toHaveProperty("failureRate");
    });

    it("returns 503 when analytics repo not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/analytics/failure-hotspots" });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("GET /api/v1/metrics", () => {
    it("returns full metrics with all sections", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      const res = await app.inject({ method: "GET", url: "/api/v1/metrics" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("costTrend");
      expect(body).toHaveProperty("failureHotspots");
      expect(body).toHaveProperty("retryPatterns");
      expect(body).toHaveProperty("workflowBreakdown");
      expect(body.summary.runCount).toBe(10);
      expect(body.retryPatterns[0].failureReason).toBe("lint_failure");
      expect(body.workflowBreakdown.length).toBe(2);
    });

    it("passes since query param to repository", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const analyticsRepo = createMockAnalyticsRepo();
      registerRoutes(app, queue, { analyticsRepo });

      await app.inject({ method: "GET", url: "/api/v1/metrics?since=2026-03-20T00:00:00Z" });
      expect(analyticsRepo.getFullMetrics).toHaveBeenCalledWith("2026-03-20T00:00:00Z");
    });

    it("returns 503 when analytics repo not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/metrics" });
      expect(res.statusCode).toBe(503);
    });
  });
});
