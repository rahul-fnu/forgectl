import Fastify from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardEngine } from "../../src/board/engine.js";
import { BoardStore } from "../../src/board/store.js";
import { registerRoutes } from "../../src/daemon/routes.js";
import { RunQueue } from "../../src/daemon/queue.js";
import { createDatabase, closeDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository } from "../../src/storage/repositories/runs.js";
import type { PipelineDefinition, PipelineRun } from "../../src/pipeline/types.js";

class FakePipelineService {
  private counter = 0;
  private pending = new Map<string, { resolve: (run: PipelineRun) => void; promise: Promise<PipelineRun> }>();

  submitPipeline(_pipeline: PipelineDefinition): { id: string; status: "running"; nodes: Record<string, never> } {
    this.counter += 1;
    const id = `pipe-route-${this.counter}`;
    let resolve!: (run: PipelineRun) => void;
    const promise = new Promise<PipelineRun>((res) => {
      resolve = res;
    });
    this.pending.set(id, { resolve, promise });
    return { id, status: "running", nodes: {} };
  }

  waitFor(runId: string): Promise<PipelineRun> {
    const pending = this.pending.get(runId);
    if (!pending) throw new Error(`run not found: ${runId}`);
    return pending.promise;
  }

  resolve(runId: string, status: "completed" | "failed"): void {
    const pending = this.pending.get(runId);
    if (!pending) throw new Error(`run not found: ${runId}`);
    pending.resolve({
      id: runId,
      pipeline: { name: "x", nodes: [{ id: "a", task: "a" }] },
      status,
      nodes: new Map(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("board routes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers board, creates card, and triggers a run", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgectl-board-routes-"));
    tempDirs.push(root);

    mkdirSync(join(root, "pipelines"), { recursive: true });
    writeFileSync(join(root, "pipelines", "feature.yaml"), `
name: feature
nodes:
  - id: task
    task: "run {{ticket}}"
`, "utf-8");

    const boardFile = join(root, "board.yaml");
    writeFileSync(boardFile, `
id: board-routes
name: Board Routes
columns: [todo, in-progress, review, done]
templates:
  feature:
    source:
      format: yaml
      path: ./pipelines/feature.yaml
    params:
      required: [ticket]
`, "utf-8");

    const store = new BoardStore(join(root, "state"));
    const pipelineService = new FakePipelineService();
    const engine = new BoardEngine(store, pipelineService as never, { maxConcurrentCardRuns: 3 });

    const app = Fastify();
    const dbDir = mkdtempSync(join(tmpdir(), "forgectl-board-route-test-"));
    const db = createDatabase(join(dbDir, "test.db"));
    runMigrations(db);
    const runRepo = createRunRepository(db);
    const queue = new RunQueue(runRepo, async () => ({
      success: true,
      validation: { passed: true, totalAttempts: 0, stepResults: [] },
      durationMs: 1,
    }));

    registerRoutes(app, queue, {
      boardStore: store,
      boardEngine: engine,
      pipelineService: pipelineService as never,
    });

    const add = await app.inject({
      method: "POST",
      url: "/boards",
      payload: { file: boardFile },
    });
    expect(add.statusCode).toBe(201);

    const createCard = await app.inject({
      method: "POST",
      url: "/boards/board-routes/cards",
      payload: {
        title: "Add health endpoint",
        type: "feature",
        params: { ticket: "ENG-8" },
      },
    });
    expect(createCard.statusCode).toBe(201);
    const cardId = createCard.json().id as string;

    const trigger = await app.inject({
      method: "POST",
      url: `/boards/board-routes/cards/${cardId}/trigger`,
      payload: { mode: "manual" },
    });
    expect(trigger.statusCode).toBe(202);
    const runId = trigger.json().runId as string;

    pipelineService.resolve(runId, "completed");

    await waitFor(async () => {
      const runs = await app.inject({
        method: "GET",
        url: `/boards/board-routes/cards/${cardId}/runs`,
      });
      if (runs.statusCode !== 200) return false;
      const parsed = runs.json() as Array<{ status: string }>;
      return parsed.some((entry) => entry.status === "completed");
    });

    closeDatabase(db);
    rmSync(dbDir, { recursive: true, force: true });
    await app.close();
  });
});
