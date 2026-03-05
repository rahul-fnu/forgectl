import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { RunQueue } from "../../src/daemon/queue.js";

const pipelineExecutorCtor = vi.fn();
let runCounter = 0;

vi.mock("../../src/pipeline/executor.js", () => ({
  PipelineExecutor: class MockPipelineExecutor {
    runId: string;
    pipeline: unknown;
    options: Record<string, unknown>;

    constructor(pipeline: unknown, options: Record<string, unknown> = {}) {
      runCounter += 1;
      this.runId = `pipe-mock-${runCounter}`;
      this.pipeline = pipeline;
      this.options = options;
      pipelineExecutorCtor(options);
    }

    async execute() {
      return {
        id: this.runId,
        pipeline: this.pipeline,
        status: "completed",
        nodes: this.getNodeStates(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    getNodeStates() {
      const p = this.pipeline as { nodes?: Array<{ id: string }> };
      const states = new Map<string, { nodeId: string; status: "pending" }>();
      for (const node of p.nodes ?? []) {
        states.set(node.id, { nodeId: node.id, status: "pending" });
      }
      return states;
    }
  },
}));

describe("pipeline rerun route validation", () => {
  beforeEach(() => {
    pipelineExecutorCtor.mockClear();
    runCounter = 0;
  });

  it("returns 400 when fromNode is invalid", async () => {
    const { registerRoutes } = await import("../../src/daemon/routes.js");
    const app = Fastify();
    const queue = new RunQueue(async () => ({
      success: true,
      validation: { passed: true, totalAttempts: 0, stepResults: [] },
      durationMs: 1,
    }));
    registerRoutes(app, queue);

    const create = await app.inject({
      method: "POST",
      url: "/pipelines",
      payload: {
        pipeline: {
          name: "p",
          nodes: [{ id: "a", task: "do a" }],
        },
      },
    });
    expect(create.statusCode).toBe(202);
    const createdId = create.json().id as string;

    const rerun = await app.inject({
      method: "POST",
      url: `/pipelines/${createdId}/rerun`,
      payload: { fromNode: "missing" },
    });
    expect(rerun.statusCode).toBe(400);
    expect(rerun.json().error).toContain("Invalid fromNode");

    await app.close();
  });

  it("defaults checkpointRunId to base run id and supports override", async () => {
    const { registerRoutes } = await import("../../src/daemon/routes.js");
    const app = Fastify();
    const queue = new RunQueue(async () => ({
      success: true,
      validation: { passed: true, totalAttempts: 0, stepResults: [] },
      durationMs: 1,
    }));
    registerRoutes(app, queue);

    const create = await app.inject({
      method: "POST",
      url: "/pipelines",
      payload: {
        pipeline: {
          name: "p",
          nodes: [{ id: "a", task: "do a" }],
        },
      },
    });
    const createdId = create.json().id as string;

    const rerunDefault = await app.inject({
      method: "POST",
      url: `/pipelines/${createdId}/rerun`,
      payload: { fromNode: "a" },
    });
    expect(rerunDefault.statusCode).toBe(202);
    expect(pipelineExecutorCtor).toHaveBeenCalledTimes(2);
    expect(pipelineExecutorCtor.mock.calls[1][0]).toMatchObject({
      fromNode: "a",
      checkpointSourceRunId: createdId,
    });

    const rerunOverride = await app.inject({
      method: "POST",
      url: `/pipelines/${createdId}/rerun`,
      payload: { fromNode: "a", checkpointRunId: "custom-run" },
    });
    expect(rerunOverride.statusCode).toBe(202);
    expect(pipelineExecutorCtor).toHaveBeenCalledTimes(3);
    expect(pipelineExecutorCtor.mock.calls[2][0]).toMatchObject({
      fromNode: "a",
      checkpointSourceRunId: "custom-run",
    });

    await app.close();
  });
});
