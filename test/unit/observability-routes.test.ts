import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { Orchestrator } from "../../src/orchestrator/index.js";
import type { OrchestratorState } from "../../src/orchestrator/state.js";
import type { MetricsCollector } from "../../src/orchestrator/metrics.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function createMockWorkerInfo(issueId: string, identifier: string) {
  return {
    issueId,
    identifier,
    issue: { id: issueId, identifier, title: "Test issue", description: "desc", status: "open", priority: 2, labels: [], url: "" },
    session: { close: vi.fn() },
    cleanup: {},
    startedAt: 1000000,
    lastActivityAt: 1000500,
    attempt: 1,
  };
}

function createMockOrchestrator(overrides: Partial<{
  running: boolean;
  state: OrchestratorState;
  metricsSnapshot: Record<string, unknown>;
  issueMetrics: Record<string, unknown>;
  triggerTickResult: boolean;
  slotUtilization: { active: number; max: number };
}> = {}): Orchestrator {
  const running = new Map();
  const worker = createMockWorkerInfo("issue-1", "GH-42");
  running.set("issue-1", worker);

  const state: OrchestratorState = overrides.state ?? {
    claimed: new Set(["issue-1"]),
    running,
    retryTimers: new Map(),
    retryAttempts: new Map(),
  };

  const metricsSnapshot = overrides.metricsSnapshot ?? {
    uptimeMs: 60000,
    active: [{ issueId: "issue-1", identifier: "GH-42", tokens: { input: 100, output: 200, total: 300 }, runtimeMs: 5000, attempts: 1, lastAttemptAt: 1000000, status: "running" }],
    completed: [],
    totals: { dispatched: 1, completed: 0, failed: 0, tokens: { input: 100, output: 200, total: 300 } },
  };

  const mockMetrics: MetricsCollector = {
    getSnapshot: vi.fn().mockReturnValue(metricsSnapshot),
    getIssueMetrics: vi.fn().mockImplementation((id: string) => {
      if (overrides.issueMetrics) return overrides.issueMetrics;
      if (id === "issue-1") return { issueId: "issue-1", identifier: "GH-42", tokens: { input: 100, output: 200, total: 300 }, runtimeMs: 5000, attempts: 1, lastAttemptAt: 1000000, status: "running" };
      return undefined;
    }),
    recordDispatch: vi.fn(),
    recordCompletion: vi.fn(),
    recordRetry: vi.fn(),
    getSlotUtilization: vi.fn(),
  } as unknown as MetricsCollector;

  return {
    isRunning: vi.fn().mockReturnValue(overrides.running ?? true),
    getState: vi.fn().mockReturnValue(state),
    getMetrics: vi.fn().mockReturnValue(mockMetrics),
    triggerTick: vi.fn().mockResolvedValue(overrides.triggerTickResult ?? true),
    getSlotUtilization: vi.fn().mockReturnValue(overrides.slotUtilization ?? { active: 1, max: 3 }),
  } as unknown as Orchestrator;
}

describe("Observability API Routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("GET /api/v1/state", () => {
    it("returns orchestrator snapshot when running", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator();
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "GET", url: "/api/v1/state" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe("running");
      expect(body.uptimeMs).toBe(60000);
      expect(body.running).toBeInstanceOf(Array);
      expect(body.running.length).toBe(1);
      expect(body.running[0].issueId).toBe("issue-1");
      expect(body.running[0].identifier).toBe("GH-42");
      expect(body.retryQueue).toBeInstanceOf(Array);
      expect(body.slots).toEqual({ active: 1, max: 3 });
      expect(body.totals).toBeDefined();
      expect(body.totals.dispatched).toBe(1);
    });

    it("returns 503 when orchestrator is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/state" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("NOT_CONFIGURED");
      expect(body.error.message).toBeDefined();
    });

    it("returns 503 when orchestrator is not running", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator({ running: false });
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "GET", url: "/api/v1/state" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });

    it("includes retry queue entries for issues in retryAttempts not running", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const state: OrchestratorState = {
        claimed: new Set(["issue-1", "issue-2"]),
        running: new Map([["issue-1", createMockWorkerInfo("issue-1", "GH-42")]]),
        retryTimers: new Map(),
        retryAttempts: new Map([["issue-2", 2]]),
      };
      const orchestrator = createMockOrchestrator({ state });
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "GET", url: "/api/v1/state" });
      const body = JSON.parse(res.body);
      expect(body.retryQueue.length).toBe(1);
      expect(body.retryQueue[0].issueId).toBe("issue-2");
      expect(body.retryQueue[0].attempt).toBe(2);
    });
  });

  describe("GET /api/v1/issues/:identifier", () => {
    it("returns issue data for a running issue", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator();
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "GET", url: "/api/v1/issues/GH-42" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.identifier).toBe("GH-42");
      expect(body.orchestratorState).toBe("running");
      expect(body.session).toBeDefined();
      expect(body.session.startedAt).toBeDefined();
      expect(body.metrics).toBeDefined();
    });

    it("returns 404 for unknown identifier", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator();
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "GET", url: "/api/v1/issues/UNKNOWN-99" });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 503 when orchestrator not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "GET", url: "/api/v1/issues/GH-42" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });
  });

  describe("POST /api/v1/refresh", () => {
    it("returns 202 with triggered: true when tick succeeds", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator({ triggerTickResult: true });
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "POST", url: "/api/v1/refresh" });
      expect(res.statusCode).toBe(202);

      const body = JSON.parse(res.body);
      expect(body.triggered).toBe(true);
    });

    it("returns 202 with triggered: false when tick in progress", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator({ triggerTickResult: false });
      registerRoutes(app, queue, { orchestrator });

      const res = await app.inject({ method: "POST", url: "/api/v1/refresh" });
      expect(res.statusCode).toBe(202);

      const body = JSON.parse(res.body);
      expect(body.triggered).toBe(false);
      expect(body.reason).toBe("tick_in_progress");
    });

    it("returns 503 when orchestrator not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "POST", url: "/api/v1/refresh" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });
  });

  describe("GET /api/v1/events", () => {
    it("registers SSE route without error", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const orchestrator = createMockOrchestrator();
      registerRoutes(app, queue, { orchestrator });

      // Verify the route is registered by checking Fastify's route table
      await app.ready();
      const routes = app.printRoutes();
      expect(routes).toContain("events");
    });
  });

  describe("Error envelope", () => {
    it("all error responses use { error: { code, message } } shape", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      // 503 from state endpoint
      const stateRes = await app.inject({ method: "GET", url: "/api/v1/state" });
      const stateBody = JSON.parse(stateRes.body);
      expect(stateBody.error).toHaveProperty("code");
      expect(stateBody.error).toHaveProperty("message");
      expect(typeof stateBody.error.code).toBe("string");
      expect(typeof stateBody.error.message).toBe("string");

      // 503 from issues endpoint
      const issueRes = await app.inject({ method: "GET", url: "/api/v1/issues/X" });
      const issueBody = JSON.parse(issueRes.body);
      expect(issueBody.error).toHaveProperty("code");
      expect(issueBody.error).toHaveProperty("message");
    });
  });
});
