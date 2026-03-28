import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../../src/daemon/routes.js";
import type { RunQueue } from "../../src/daemon/queue.js";
import type { Orchestrator } from "../../src/orchestrator/index.js";

function createMockQueue(): RunQueue {
  return {
    submit: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    processNext: vi.fn(),
  } as unknown as RunQueue;
}

function createMockOrchestrator(running = true): Orchestrator {
  return {
    isRunning: vi.fn().mockReturnValue(running),
    dispatchIssue: vi.fn(),
    getState: vi.fn(),
    getMetrics: vi.fn(),
    getSlotUtilization: vi.fn(),
    triggerTick: vi.fn(),
  } as unknown as Orchestrator;
}

describe("POST /api/v1/dispatch", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("dispatches a synthetic issue with title and description", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { title: "Alert: high CPU", description: "CPU > 90% for 5m" },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("dispatched");
    expect(body.id).toMatch(/^dispatch-/);

    expect(orchestrator.dispatchIssue).toHaveBeenCalledTimes(1);
    const issue = (orchestrator.dispatchIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(issue.title).toBe("Alert: high CPU");
    expect(issue.description).toBe("CPU > 90% for 5m");
    expect(issue.state).toBe("open");
    expect(issue.metadata.source).toBe("dispatch");
  });

  it("passes optional fields (repo, priority, labels)", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: {
        title: "Deploy failure",
        repo: "owner/repo",
        priority: "urgent",
        labels: ["infra", "p0"],
      },
    });

    expect(res.statusCode).toBe(202);

    const issue = (orchestrator.dispatchIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(issue.priority).toBe("urgent");
    expect(issue.labels).toEqual(["infra", "p0"]);
    expect(issue.metadata.repo).toBe("owner/repo");
  });

  it("returns 400 when title is missing", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { description: "no title" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when body is empty", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when orchestrator is not configured", async () => {
    app = Fastify();
    const queue = createMockQueue();
    registerRoutes(app, queue, {});

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { title: "test" },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns 503 when orchestrator is not running", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator(false);
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { title: "test" },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("decomposes a complex prompt with multiple sub-tasks", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: {
        title: "Implement user dashboard features",
        description:
          "1. Add user profile page with avatar upload\n2. Create activity feed showing recent actions\n3. Build notification settings panel\n4. Add dark mode toggle to settings",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("decomposed");
    expect(body.parentIssue).toMatch(/^dispatch-/);
    expect(Array.isArray(body.childIssues)).toBe(true);
    expect(body.childIssues.length).toBe(4);
    for (const childId of body.childIssues) {
      expect(childId).toContain("-sub-");
    }

    // Each child issue should be dispatched
    expect(orchestrator.dispatchIssue).toHaveBeenCalledTimes(4);
  });

  it("dispatches short simple prompts directly without decomposing", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { title: "Fix typo in README" },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("dispatched");
    expect(body.id).toMatch(/^dispatch-/);
    expect(body.childIssues).toBeUndefined();

    expect(orchestrator.dispatchIssue).toHaveBeenCalledTimes(1);
  });

  it("defaults description to empty string when omitted", async () => {
    app = Fastify();
    const queue = createMockQueue();
    const orchestrator = createMockOrchestrator();
    registerRoutes(app, queue, { orchestrator });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch",
      payload: { title: "minimal" },
    });

    expect(res.statusCode).toBe(202);
    const issue = (orchestrator.dispatchIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(issue.description).toBe("");
    expect(issue.labels).toEqual([]);
    expect(issue.priority).toBeNull();
  });
});
