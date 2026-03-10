import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { RunRepository, RunRow } from "../../src/storage/repositories/runs.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    task: "test task",
    workflow: "test-workflow",
    status: "queued",
    options: null,
    submittedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    pauseReason: null,
    pauseContext: null,
    approvalContext: null,
    approvalAction: null,
    ...overrides,
  };
}

function mockRunRepo(run?: RunRow): RunRepository {
  const store = run ? { ...run } : undefined;
  return {
    insert: vi.fn(),
    findById: vi.fn(() => (store ? { ...store } : undefined)),
    updateStatus: vi.fn((_id, params) => {
      if (store) {
        store.status = params.status;
        if (params.completedAt) store.completedAt = params.completedAt;
        if (params.error !== undefined) store.error = params.error;
        if (params.approvalAction) store.approvalAction = params.approvalAction;
        if (params.approvalContext) store.approvalContext = params.approvalContext;
      }
    }),
    listAll: vi.fn().mockReturnValue([]),
    listByStatus: vi.fn().mockReturnValue([]),
  } as unknown as RunRepository;
}

describe("Governance Routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("POST /api/v1/runs/:id/approve", () => {
    it("approves a run in pending_approval status", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "pending_approval" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/approve" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe("approved");
      expect(body.runId).toBe("run-1");
      expect(body.previousStatus).toBe("pending_approval");
    });

    it("approves a run in pending_output_approval status", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "pending_output_approval" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/approve" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe("approved");
      expect(body.runId).toBe("run-1");
      expect(body.previousStatus).toBe("pending_output_approval");
    });

    it("returns 404 for unknown run", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(); // no run
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({ method: "POST", url: "/api/v1/runs/unknown/approve" });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 409 for run in non-pending status", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "running" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/approve" });
      expect(res.statusCode).toBe(409);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("CONFLICT");
    });

    it("returns 503 when runRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/approve" });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });
  });

  describe("POST /api/v1/runs/:id/reject", () => {
    it("rejects a run with reason", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "pending_approval" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/runs/run-1/reject",
        payload: { reason: "too risky" },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe("rejected");
      expect(body.runId).toBe("run-1");
    });

    it("handles revision_requested action with feedback", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "pending_approval" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/runs/run-1/reject",
        payload: { action: "revision_requested", feedback: "fix X" },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe("revision_requested");
      expect(body.runId).toBe("run-1");
    });

    it("returns 404 for unknown run", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(); // no run
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/runs/unknown/reject",
        payload: { reason: "nope" },
      });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 409 for run in non-pending status", async () => {
      app = Fastify();
      const queue = createMockQueue();
      const runRepo = mockRunRepo(makeRunRow({ id: "run-1", status: "running" }));
      registerRoutes(app, queue, { runRepo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/runs/run-1/reject",
        payload: { reason: "nope" },
      });
      expect(res.statusCode).toBe(409);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("CONFLICT");
    });

    it("returns 503 when runRepo is not configured", async () => {
      app = Fastify();
      const queue = createMockQueue();
      registerRoutes(app, queue, {});

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/runs/run-1/reject",
        payload: { reason: "nope" },
      });
      expect(res.statusCode).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("NOT_CONFIGURED");
    });
  });
});
