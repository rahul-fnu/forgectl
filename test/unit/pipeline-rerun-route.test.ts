import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunQueue } from "../../src/daemon/queue.js";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";

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
  let db: AppDatabase;
  let repo: RunRepository;
  let tmpDir: string;

  beforeEach(() => {
    pipelineExecutorCtor.mockClear();
    runCounter = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-pipe-rerun-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 when fromNode is invalid", async () => {
    const { registerRoutes } = await import("../../src/daemon/routes.js");
    const app = Fastify();
    const queue = new RunQueue(repo, async () => ({
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
    const queue = new RunQueue(repo, async () => ({
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
