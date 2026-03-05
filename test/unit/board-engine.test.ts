import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardEngine } from "../../src/board/engine.js";
import { BoardStore } from "../../src/board/store.js";
import type { PipelineDefinition, PipelineRun } from "../../src/pipeline/types.js";

class FakePipelineService {
  private counter = 0;
  submitted: Array<{ id: string; pipeline: PipelineDefinition }> = [];
  private pending = new Map<string, { promise: Promise<PipelineRun>; resolve: (run: PipelineRun) => void }>();

  submitPipeline(pipeline: PipelineDefinition): { id: string; status: "running"; nodes: Record<string, never> } {
    this.counter += 1;
    const id = `pipe-${this.counter}`;
    let resolve!: (run: PipelineRun) => void;
    const promise = new Promise<PipelineRun>((res) => {
      resolve = res;
    });
    this.pending.set(id, { promise, resolve });
    this.submitted.push({ id, pipeline });
    return { id, status: "running", nodes: {} };
  }

  waitFor(runId: string): Promise<PipelineRun> {
    const pending = this.pending.get(runId);
    if (!pending) {
      throw new Error(`run not found: ${runId}`);
    }
    return pending.promise;
  }

  resolve(runId: string, status: "completed" | "failed"): void {
    const pending = this.pending.get(runId);
    if (!pending) {
      throw new Error(`run not found: ${runId}`);
    }

    pending.resolve({
      id: runId,
      pipeline: this.submitted.find((entry) => entry.id === runId)!.pipeline,
      status,
      nodes: new Map(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
  }
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("BoardEngine", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createSetup(): { engine: BoardEngine; store: BoardStore; service: FakePipelineService; boardPath: string } {
    const root = mkdtempSync(join(tmpdir(), "forgectl-board-engine-"));
    tempDirs.push(root);

    const boardPath = join(root, "board.yaml");
    mkdirSync(join(root, "pipelines"), { recursive: true });
    writeFileSync(join(root, "pipelines", "feature.yaml"), `
name: task-{{ticket}}
defaults:
  workflow: code
nodes:
  - id: implement
    task: "Implement {{ticket}}"
`, "utf-8");

    writeFileSync(boardPath, `
id: eng-board
name: Engineering
columns: [todo, in-progress, review, done]
transitions:
  todo: [todo, in-progress, review]
  in-progress: [in-progress, review, done]
  review: [review, done]
  done: [done]
templates:
  feature:
    source:
      format: yaml
      path: ./pipelines/feature.yaml
    params:
      required: [ticket]
    triggers:
      manual: true
      auto_on_enter: [in-progress]
      schedule:
        enabled: true
        interval_minutes: 1
`, "utf-8");

    const store = new BoardStore(join(root, "state"));
    const service = new FakePipelineService();
    const engine = new BoardEngine(store, service as never, { maxConcurrentCardRuns: 5 });

    return { engine, store, service, boardPath };
  }

  it("triggers manual runs and reconciles success state", async () => {
    const { engine, store, service, boardPath } = createSetup();
    await engine.registerBoardFile(boardPath);

    const card = await engine.createCard("eng-board", {
      title: "Build auth",
      type: "feature",
      params: { ticket: "AUTH-100" },
    });

    const triggered = await engine.triggerCardRun("eng-board", card.id, "manual");
    expect(triggered.runId).toBe("pipe-1");

    let board = await store.getBoard("eng-board");
    expect(board?.cards[0].runHistory[0].status).toBe("running");

    service.resolve("pipe-1", "completed");

    await waitForCondition(async () => {
      const next = await store.getBoard("eng-board");
      return next?.cards[0].runHistory[0].status === "completed";
    });

    board = await store.getBoard("eng-board");
    expect(board?.cards[0].column).toBe("review");
  });

  it("auto-triggers on configured column move and supports scheduled trigger", async () => {
    const { engine, store, service, boardPath } = createSetup();
    await engine.registerBoardFile(boardPath);

    const card = await engine.createCard("eng-board", {
      title: "Build billing",
      type: "feature",
      params: { ticket: "BILL-42" },
    });

    await engine.updateCard("eng-board", card.id, { column: "in-progress" });
    expect(service.submitted).toHaveLength(1);

    service.resolve("pipe-1", "completed");
    await waitForCondition(async () => {
      const next = await store.getBoard("eng-board");
      return next?.cards[0].runHistory[0].status === "completed";
    });

    await store.setNextScheduledAt("eng-board", card.id, new Date(Date.now() - 60_000).toISOString());

    const tick = await engine.schedulerTick(new Date());
    expect(tick.triggered.length).toBe(1);
    expect(service.submitted).toHaveLength(2);

    service.resolve("pipe-2", "failed");
    await waitForCondition(async () => {
      const next = await store.getBoard("eng-board");
      return next?.cards[0].runHistory.some((run) => run.runId === "pipe-2" && run.status === "failed") ?? false;
    });
  });
});
