import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPlan } from "../../src/workflow/types.js";
import type { OutputResult } from "../../src/output/types.js";

interface CheckpointRecord {
  nodeId: string;
  pipelineRunId: string;
  timestamp: string;
  branch?: string;
  commitSha?: string;
  outputDir?: string;
  outputFiles?: string[];
}

interface PlanSnapshot {
  manifestEntries: Array<Record<string, unknown>>;
}

const shared = vi.hoisted(() => ({
  executeRunMock: vi.fn(),
  checkpoints: new Map<string, CheckpointRecord>(),
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: () => ({
    agent: { type: "codex", model: "", max_turns: 50, timeout: "30m", flags: [] },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", allow: [] },
      resources: { memory: "4g", cpus: 2 },
    },
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: [] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    board: {
      state_dir: "~/.forgectl/board",
      scheduler_tick_seconds: 30,
      max_concurrent_card_runs: 2,
    },
  }),
}));

vi.mock("../../src/orchestration/modes.js", () => ({
  executeRun: shared.executeRunMock,
}));

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

vi.mock("../../src/pipeline/checkpoint.js", () => ({
  saveCheckpoint: vi.fn(async (
    pipelineRunId: string,
    nodeId: string,
    result: { output?: OutputResult },
  ): Promise<CheckpointRecord> => {
    const checkpoint: CheckpointRecord = {
      nodeId,
      pipelineRunId,
      timestamp: new Date().toISOString(),
    };
    if (result.output?.mode === "git") {
      checkpoint.branch = result.output.branch;
      checkpoint.commitSha = result.output.sha;
    } else if (result.output?.mode === "files") {
      checkpoint.outputDir = result.output.dir;
      checkpoint.outputFiles = [...result.output.files];
    }
    shared.checkpoints.set(`${pipelineRunId}:${nodeId}`, checkpoint);
    return checkpoint;
  }),
  loadCheckpoint: vi.fn(async (pipelineRunId: string, nodeId: string): Promise<CheckpointRecord | null> => {
    return shared.checkpoints.get(`${pipelineRunId}:${nodeId}`) ?? null;
  }),
  listCheckpoints: vi.fn(async (pipelineRunId: string): Promise<CheckpointRecord[]> => {
    return [...shared.checkpoints.values()].filter((cp) => cp.pipelineRunId === pipelineRunId);
  }),
  revertToCheckpoint: vi.fn(async () => {}),
}));

import { BoardEngine } from "../../src/board/engine.js";
import { BoardStore } from "../../src/board/store.js";
import { PipelineRunService } from "../../src/daemon/pipeline-service.js";

function git(repoPath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
}

function writeOutputFile(root: string, relPath: string, content: string | Buffer): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function createRepo(tempPaths: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), "forgectl-board-e2e-repo-"));
  tempPaths.push(repoPath);

  git(repoPath, "init");
  git(repoPath, "checkout -B main");
  writeOutputFile(repoPath, "README.md", "# board e2e repo\n");
  git(repoPath, "add -A");
  git(repoPath, '-c user.name="Test" -c user.email="test@example.com" commit -m "init"');
  return repoPath;
}

function createFilesOutput(
  tempPaths: string[],
  prefix: string,
  files: Array<{ path: string; content: string | Buffer }>,
): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `forgectl-board-e2e-${prefix}-`));
  tempPaths.push(dir);
  for (const file of files) {
    writeOutputFile(dir, file.path, file.content);
  }
  return { dir, files: files.map((entry) => entry.path) };
}

function snapshotPlan(plan: RunPlan): PlanSnapshot {
  const manifestEntries: Array<Record<string, unknown>> = [];
  for (const file of plan.context.files) {
    if (!file.endsWith("context-manifest.json")) continue;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { entries?: Array<Record<string, unknown>> };
    manifestEntries.push(...(parsed.entries ?? []));
  }
  return { manifestEntries };
}

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for board run completion");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("board mixed workflow e2e", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    shared.executeRunMock.mockReset();
    shared.checkpoints.clear();
  });

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("runs manual + auto + scheduled triggers with mixed .md/.json/.png propagation", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgectl-board-e2e-"));
    tempPaths.push(root);

    const repoPath = createRepo(tempPaths);
    mkdirSync(join(root, "pipelines"), { recursive: true });

    writeFileSync(join(root, "pipelines", "mixed.yaml"), `
name: mixed-template-{{ticket}}
defaults:
  repo: ${repoPath}
nodes:
  - id: content-a
    task: "node-a-content"
    workflow: content
  - id: code-b
    task: "node-b-code {{ticket}}"
    workflow: code
    depends_on: [content-a]
`, "utf-8");

    writeFileSync(join(root, "board.yaml"), `
id: board-e2e
name: Board E2E
columns: [todo, in-progress, review, done]
transitions:
  todo: [todo, in-progress]
  in-progress: [in-progress, review]
  review: [review, in-progress, done]
  done: [done]
templates:
  feature:
    source:
      format: yaml
      path: ./pipelines/mixed.yaml
    params:
      required: [ticket]
    triggers:
      manual: true
      auto_on_enter: [in-progress]
      schedule:
        enabled: true
        interval_minutes: 1
    post_run:
      on_success: review
      on_failure: in-progress
`, "utf-8");

    const nodeBPlans: PlanSnapshot[] = [];
    let runCounter = 0;

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      if (plan.task === "node-a-content") {
        const output = createFilesOutput(tempPaths, `content-${runCounter}`, [
          { path: "spec.md", content: "# Spec\nHealth endpoint\n" },
          { path: "schema.json", content: JSON.stringify({ endpoint: "/health", ok: true }, null, 2) },
          { path: "diagram.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 2, 3]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 200 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task.startsWith("node-b-code")) {
        nodeBPlans.push(snapshotPlan(plan));
        runCounter += 1;
        const branch = `forge/board-e2e/${runCounter}`;
        git(repoPath, `checkout -B ${branch}`);
        writeOutputFile(repoPath, "src/health.ts", `export const health = () => ({ status: 'ok', run: ${runCounter} });\n`);
        git(repoPath, "add -A");
        git(repoPath, `-c user.name="Test" -c user.email="test@example.com" commit -m "run ${runCounter}"`);
        const sha = git(repoPath, "rev-parse HEAD");
        git(repoPath, "checkout main");
        return {
          success: true,
          output: {
            mode: "git",
            branch,
            sha,
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      throw new Error(`Unexpected task: ${plan.task}`);
    });

    const store = new BoardStore(join(root, "state"));
    const pipelineService = new PipelineRunService();
    const engine = new BoardEngine(store, pipelineService, { maxConcurrentCardRuns: 3 });

    await engine.registerBoardFile(join(root, "board.yaml"));

    const card = await engine.createCard("board-e2e", {
      title: "Implement health endpoint",
      type: "feature",
      params: { ticket: "ENG-900" },
    });

    await engine.triggerCardRun("board-e2e", card.id, "manual");

    await waitForCondition(async () => {
      const board = await store.getBoard("board-e2e");
      const run = board?.cards[0].runHistory[0];
      return run?.status === "completed";
    });

    await engine.updateCard("board-e2e", card.id, { column: "in-progress" });

    await waitForCondition(async () => {
      const board = await store.getBoard("board-e2e");
      return (board?.cards[0].runHistory.length ?? 0) >= 2
        && board?.cards[0].runHistory[1].status === "completed";
    });

    await store.setNextScheduledAt("board-e2e", card.id, new Date(Date.now() - 60_000).toISOString());
    const tick = await engine.schedulerTick(new Date());
    expect(tick.triggered.length).toBe(1);

    await waitForCondition(async () => {
      const board = await store.getBoard("board-e2e");
      return (board?.cards[0].runHistory.length ?? 0) >= 3
        && board?.cards[0].runHistory[2].status === "completed";
    });

    const board = await store.getBoard("board-e2e");
    expect(board?.cards[0].runHistory.map((run) => run.triggerMode)).toEqual(["manual", "auto", "scheduled"]);

    expect(nodeBPlans).toHaveLength(3);
    for (const snapshot of nodeBPlans) {
      expect(snapshot.manifestEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "spec.md", type: "text" }),
          expect.objectContaining({ path: "schema.json", type: "text" }),
          expect.objectContaining({ path: "diagram.png", type: "binary" }),
        ]),
      );
    }
  });
});
