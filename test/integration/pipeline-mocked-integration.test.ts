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
    return [...shared.checkpoints.values()].filter(cp => cp.pipelineRunId === pipelineRunId);
  }),
  revertToCheckpoint: vi.fn(async () => {}),
}));

import { PipelineExecutor } from "../../src/pipeline/executor.js";

interface PlanSnapshot {
  contextFiles: string[];
  contextText: string[];
  manifestEntries: Array<Record<string, unknown>>;
  inputSources: string[];
  branchAtExecution?: string;
}

function git(repoPath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
}

function createRepo(tempPaths: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), "forgectl-pipe-int-repo-"));
  tempPaths.push(repoPath);

  git(repoPath, "init");
  git(repoPath, "checkout -B main");
  writeFileSync(join(repoPath, "README.md"), "# integration repo\n", "utf-8");
  git(repoPath, "add -A");
  git(repoPath, '-c user.name="Test" -c user.email="test@example.com" commit -m "init"');
  return repoPath;
}

function writeOutputFile(root: string, relPath: string, content: string | Buffer): void {
  const absPath = join(root, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

function createFilesOutput(
  tempPaths: string[],
  prefix: string,
  files: Array<{ path: string; content: string | Buffer }>,
): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `forgectl-pipe-int-${prefix}-`));
  tempPaths.push(dir);
  for (const file of files) {
    writeOutputFile(dir, file.path, file.content);
  }
  return {
    dir,
    files: files.map(f => f.path),
  };
}

function createGitOutput(
  repoPath: string,
  branch: string,
  commitMessage: string,
  files: Array<{ path: string; content: string | Buffer }>,
): { branch: string; sha: string } {
  git(repoPath, `checkout -B ${branch}`);
  for (const file of files) {
    writeOutputFile(repoPath, file.path, file.content);
  }
  git(repoPath, "add -A");
  git(repoPath, `-c user.name="Test" -c user.email="test@example.com" commit -m "${commitMessage}"`);
  const sha = git(repoPath, "rev-parse HEAD");
  git(repoPath, "checkout main");
  return { branch, sha };
}

function snapshotPlan(plan: RunPlan): PlanSnapshot {
  const contextFiles = [...plan.context.files];
  const contextText: string[] = [];
  const manifestEntries: Array<Record<string, unknown>> = [];

  for (const file of contextFiles) {
    if (file.endsWith("context-manifest.json")) {
      const manifest = JSON.parse(readFileSync(file, "utf-8")) as { entries?: Array<Record<string, unknown>> };
      manifestEntries.push(...(manifest.entries ?? []));
      continue;
    }
    try {
      contextText.push(readFileSync(file, "utf-8"));
    } catch {
      // Ignore binary files in snapshot text collection.
    }
  }

  return {
    contextFiles,
    contextText,
    manifestEntries,
    inputSources: [...plan.input.sources],
  };
}

describe("pipeline integration (mocked engine)", () => {
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

  it("covers content(files) -> code(git) -> content(files) with mixed artifact context", async () => {
    const repoPath = createRepo(tempPaths);
    const plans: Record<string, PlanSnapshot> = {};

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      plans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-content-a") {
        const output = createFilesOutput(tempPaths, "content-a", [
          { path: "spec.md", content: "# API Spec\nImplement GET /health\n" },
          { path: "schema.json", content: JSON.stringify({ endpoint: "/health", response: "ok" }, null, 2) },
          { path: "diagram.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 128 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-code-b") {
        const gitOut = createGitOutput(repoPath, "forge/int/code-b", "implement endpoint", [
          { path: "src/health.ts", content: "export const health = () => ({ status: 'ok' });\n" },
          { path: "docs/health.md", content: "Health endpoint docs\n" },
          { path: "assets/render.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]) },
        ]);
        return {
          success: true,
          output: {
            mode: "git",
            branch: gitOut.branch,
            sha: gitOut.sha,
            filesChanged: 3,
            insertions: 12,
            deletions: 0,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-content-c") {
        const output = createFilesOutput(tempPaths, "content-c", [
          { path: "report.md", content: "Generated from code context.\n" },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 64 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      throw new Error(`Unexpected task: ${plan.task}`);
    });

    const pipeline = {
      name: "mixed-int-1",
      defaults: { repo: repoPath },
      nodes: [
        { id: "content-a", task: "node-content-a", workflow: "content" },
        { id: "code-b", task: "node-code-b", workflow: "code", depends_on: ["content-a"] },
        { id: "content-c", task: "node-content-c", workflow: "content", depends_on: ["code-b"] },
      ],
    };

    const result = await new PipelineExecutor(pipeline).execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("content-a")!.status).toBe("completed");
    expect(result.nodes.get("code-b")!.status).toBe("completed");
    expect(result.nodes.get("content-c")!.status).toBe("completed");

    expect(plans["node-code-b"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "spec.md", type: "text" }),
        expect.objectContaining({ path: "schema.json", type: "text" }),
        expect.objectContaining({ path: "diagram.png", type: "binary" }),
      ]),
    );
    expect(plans["node-code-b"].contextText.join("\n")).toContain("API Spec");

    expect(plans["node-content-c"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/health.ts", type: "text" }),
        expect.objectContaining({ path: "docs/health.md", type: "text" }),
        expect.objectContaining({ path: "assets/render.png", type: "binary" }),
      ]),
    );
  });

  it("handles fan-in with mixed upstream output modes and preserves repo state", async () => {
    const repoPath = createRepo(tempPaths);
    const plans: Record<string, PlanSnapshot> = {};

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      plans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-code-upstream") {
        const gitOut = createGitOutput(repoPath, "forge/int/code-upstream", "upstream code", [
          { path: "src/core.ts", content: "export const core = true;\n" },
        ]);
        return {
          success: true,
          output: {
            mode: "git",
            branch: gitOut.branch,
            sha: gitOut.sha,
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-content-upstream") {
        const output = createFilesOutput(tempPaths, "content-upstream", [
          { path: "notes.md", content: "fan-in notes\n" },
          { path: "diagram.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 4, 3, 2]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 80 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-fanin") {
        plans[plan.task].branchAtExecution = git(repoPath, "rev-parse --abbrev-ref HEAD");
        const gitOut = createGitOutput(repoPath, "forge/int/fanin", "fan-in output", [
          { path: "src/fanin.ts", content: "export const merged = true;\n" },
        ]);
        return {
          success: true,
          output: {
            mode: "git",
            branch: gitOut.branch,
            sha: gitOut.sha,
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

    const pipeline = {
      name: "mixed-int-2",
      defaults: { repo: repoPath },
      nodes: [
        { id: "code-up", task: "node-code-upstream", workflow: "code" },
        { id: "content-up", task: "node-content-upstream", workflow: "content" },
        { id: "fanin", task: "node-fanin", workflow: "code", depends_on: ["code-up", "content-up"] },
      ],
    };

    const result = await new PipelineExecutor(pipeline).execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("fanin")!.status).toBe("completed");
    expect(plans["node-fanin"].branchAtExecution).toMatch(/^forgectl-fanin-/);
    expect(plans["node-fanin"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceNodeId: "content-up", path: "notes.md", type: "text" }),
        expect.objectContaining({ sourceNodeId: "content-up", path: "diagram.png", type: "binary" }),
      ]),
    );
    expect(git(repoPath, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repoPath, 'branch --list "forgectl-fanin-*"')).toBe("");
  });

  it("reruns from node with checkpoint hydration and skips unrelated branches", async () => {
    const repoPath = createRepo(tempPaths);
    const run2Plans: Record<string, PlanSnapshot> = {};

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      if (plan.task === "node-a") {
        const output = createFilesOutput(tempPaths, "rerun-a", [
          { path: "spec.md", content: "Spec A\n" },
          { path: "schema.json", content: JSON.stringify({ schema: 1 }) },
          { path: "diagram.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 48 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }
      if (plan.task === "node-b") {
        const gitOut = createGitOutput(repoPath, "forge/int/rerun-b-base", "base b", [
          { path: "src/b.ts", content: "export const b = 1;\n" },
        ]);
        return {
          success: true,
          output: {
            mode: "git",
            branch: gitOut.branch,
            sha: gitOut.sha,
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }
      if (plan.task === "node-c" || plan.task === "node-d") {
        const output = createFilesOutput(tempPaths, `rerun-${plan.task}`, [
          { path: `${plan.task}.md`, content: `${plan.task} output\n` },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 24 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }
      throw new Error(`Unexpected task in base run: ${plan.task}`);
    });

    const pipeline = {
      name: "mixed-int-3",
      defaults: { repo: repoPath },
      nodes: [
        { id: "a", task: "node-a", workflow: "content" },
        { id: "b", task: "node-b", workflow: "code", depends_on: ["a"] },
        { id: "c", task: "node-c", workflow: "content", depends_on: ["b"] },
        { id: "d", task: "node-d", workflow: "content" },
      ],
    };

    const baseRun = await new PipelineExecutor(pipeline).execute();
    expect(baseRun.status).toBe("completed");

    shared.executeRunMock.mockReset();
    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      run2Plans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-a" || plan.task === "node-d") {
        throw new Error(`Unexpected execution during rerun: ${plan.task}`);
      }

      if (plan.task === "node-b") {
        const gitOut = createGitOutput(repoPath, "forge/int/rerun-b-second", "rerun b", [
          { path: "src/b.ts", content: "export const b = 2;\n" },
        ]);
        return {
          success: true,
          output: {
            mode: "git",
            branch: gitOut.branch,
            sha: gitOut.sha,
            filesChanged: 1,
            insertions: 1,
            deletions: 1,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-c") {
        const output = createFilesOutput(tempPaths, "rerun-c-second", [
          { path: "node-c.md", content: "rerun content\n" },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 20 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      throw new Error(`Unexpected task in rerun: ${plan.task}`);
    });

    const rerun = await new PipelineExecutor(pipeline, {
      fromNode: "b",
      checkpointSourceRunId: baseRun.id,
      repo: repoPath,
    }).execute();

    expect(rerun.status).toBe("completed");
    expect(rerun.nodes.get("a")!.status).toBe("skipped");
    expect(rerun.nodes.get("a")!.hydratedFromCheckpoint).toEqual({
      pipelineRunId: baseRun.id,
      nodeId: "a",
    });
    expect(rerun.nodes.get("d")!.status).toBe("skipped");
    expect(rerun.nodes.get("d")!.skipReason).toContain("not required");
    expect(Object.keys(run2Plans).sort()).toEqual(["node-b", "node-c"]);
    expect(run2Plans["node-b"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "spec.md", type: "text" }),
        expect.objectContaining({ path: "schema.json", type: "text" }),
        expect.objectContaining({ path: "diagram.png", type: "binary" }),
      ]),
    );
  });
});
