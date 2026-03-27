import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import { emitRunEvent, runEvents } from "../../src/logging/events.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { EventRepository } from "../../src/storage/repositories/events.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function createMockEventRepo(events: unknown[] = []): EventRepository {
  return {
    insert: vi.fn(),
    findByRunId: vi.fn().mockReturnValue(events),
    findByRunIdAndType: vi.fn().mockReturnValue(events),
  };
}

describe("GET /api/v1/runs/:id/stream", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    runEvents.removeAllListeners();
  });

  it("streams events and cleans up listener on disconnect", async () => {
    app = Fastify();
    const queue = createMockQueue();
    registerRoutes(app, queue, {});

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = new URL(address);
    const runId = "test-run-sse";

    const listenersBefore = runEvents.listenerCount(`run:${runId}`);

    const { data, cleanup } = await new Promise<{ data: string; cleanup: () => void }>((resolve) => {
      const req = http.get(`${address}/api/v1/runs/${runId}/stream`, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");

        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          // After receiving data, resolve
          if (body.includes("hello world")) {
            resolve({ data: body, cleanup: () => req.destroy() });
          }
        });
      });

      // Emit event after listener attaches
      setTimeout(() => {
        expect(runEvents.listenerCount(`run:${runId}`)).toBe(listenersBefore + 1);
        emitRunEvent({
          runId,
          type: "agent_output",
          timestamp: "2026-01-01T00:00:00Z",
          data: { stream: "stdout", chunk: "hello world" },
        });
      }, 50);
    });

    expect(data).toContain("hello world");
    cleanup();

    // Give time for disconnect cleanup
    await new Promise((r) => setTimeout(r, 50));
    expect(runEvents.listenerCount(`run:${runId}`)).toBe(listenersBefore);
  });

  it("rejects when auth token is required but missing", async () => {
    app = Fastify();
    const queue = createMockQueue();
    registerRoutes(app, queue, { authToken: "secret123" });

    const resNoToken = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/stream",
    });
    expect(resNoToken.statusCode).toBe(401);

    const resBadToken = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/stream?token=wrong",
    });
    expect(resBadToken.statusCode).toBe(401);
  });
});

describe("GET /api/v1/runs/:id/events", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns historical events from eventRepo", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const events = [
      { id: 1, runId: "run-1", type: "agent_started", timestamp: "2026-01-01T00:00:00Z", data: {} },
      { id: 2, runId: "run-1", type: "agent_output", timestamp: "2026-01-01T00:00:01Z", data: { stream: "stdout", chunk: "hi" } },
    ];
    const eventRepo = createMockEventRepo(events);
    registerRoutes(app, queue, { eventRepo });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("agent_started");
    expect(eventRepo.findByRunId).toHaveBeenCalledWith("run-1");
  });

  it("filters by type when query param provided", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const filtered = [
      { id: 2, runId: "run-1", type: "agent_output", timestamp: "2026-01-01T00:00:01Z", data: {} },
    ];
    const eventRepo = createMockEventRepo(filtered);
    registerRoutes(app, queue, { eventRepo });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events?type=agent_output",
    });

    expect(res.statusCode).toBe(200);
    expect(eventRepo.findByRunIdAndType).toHaveBeenCalledWith("run-1", "agent_output");
  });

  it("returns 503 when eventRepo not configured", async () => {
    app = Fastify();
    const queue = createMockQueue();
    registerRoutes(app, queue, {});

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events",
    });

    expect(res.statusCode).toBe(503);
  });

  it("respects auth token", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const eventRepo = createMockEventRepo([]);
    registerRoutes(app, queue, { eventRepo, authToken: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events",
    });
    expect(res.statusCode).toBe(401);

    const resOk = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1/events?token=secret",
    });
    expect(resOk.statusCode).toBe(200);
  });
});

describe("emitRunEvent integration", () => {
  it("emits agent_output event and delivers to run-specific listener", () => {
    const events: unknown[] = [];
    const runId = "test-emit";

    runEvents.on(`run:${runId}`, (event) => events.push(event));

    emitRunEvent({
      runId,
      type: "agent_output",
      timestamp: "2026-01-01T00:00:00Z",
      data: { stream: "stdout", chunk: "test chunk" },
    });

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe("agent_output");
    expect((events[0] as any).data.chunk).toBe("test chunk");

    runEvents.removeAllListeners();
  });

  it("emits agent_started event", () => {
    const events: unknown[] = [];
    runEvents.on("run", (event) => events.push(event));

    emitRunEvent({
      runId: "r1",
      type: "agent_started",
      timestamp: "2026-01-01T00:00:00Z",
      data: { issueId: "i1", identifier: "issue-1", attempt: 1 },
    });

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe("agent_started");
    runEvents.removeAllListeners();
  });
});
