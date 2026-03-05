import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  contextFiles: string[];
  contextText: string[];
  manifestEntries: Array<Record<string, unknown>>;
  inputSources: string[];
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

const skipDocker = process.env.FORGECTL_SKIP_DOCKER !== "false";

function git(repoPath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
}

function writeOutputFile(root: string, relPath: string, content: string | Buffer): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function createRepo(tempPaths: string[]): string {
  const repoPath = mkdtempSync(join(tmpdir(), "forgectl-pipe-e2e-repo-"));
  tempPaths.push(repoPath);

  git(repoPath, "init");
  git(repoPath, "checkout -B main");
  writeOutputFile(repoPath, "README.md", "# e2e repo\n");
  git(repoPath, "add -A");
  git(repoPath, '-c user.name="Test" -c user.email="test@example.com" commit -m "init"');
  return repoPath;
}

function createFilesOutput(
  tempPaths: string[],
  prefix: string,
  files: Array<{ path: string; content: string | Buffer }>,
): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `forgectl-pipe-e2e-${prefix}-`));
  tempPaths.push(dir);
  for (const file of files) {
    writeOutputFile(dir, file.path, file.content);
  }
  return { dir, files: files.map(f => f.path) };
}

function createGitCommitOutput(
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
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as { entries?: Array<Record<string, unknown>> };
      manifestEntries.push(...(parsed.entries ?? []));
      continue;
    }
    try {
      contextText.push(readFileSync(file, "utf-8"));
    } catch {
      // Ignore binary files in text snapshot.
    }
  }

  return {
    contextFiles,
    contextText,
    manifestEntries,
    inputSources: [...plan.input.sources],
  };
}

describe.skipIf(skipDocker)("pipeline mixed workflow e2e", () => {
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

  it("runs files->git with .md/.json/.png and supports rerun hydration from checkpoints", async () => {
    const repoPath = createRepo(tempPaths);
    const firstRunPlans: Record<string, PlanSnapshot> = {};
    const rerunPlans: Record<string, PlanSnapshot> = {};

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      firstRunPlans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-a-content") {
        const output = createFilesOutput(tempPaths, "node-a", [
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

      if (plan.task === "node-b-code") {
        const gitOut = createGitCommitOutput(repoPath, "forge/e2e/files-git", "implement endpoint", [
          { path: "src/health.ts", content: "export const health = () => ({ status: 'ok' });\n" },
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

      throw new Error(`Unexpected task in first run: ${plan.task}`);
    });

    const pipeline = {
      name: "e2e-files-git",
      defaults: { repo: repoPath },
      nodes: [
        { id: "a", task: "node-a-content", workflow: "content" },
        { id: "b", task: "node-b-code", workflow: "code", depends_on: ["a"] },
      ],
    };

    const baseRun = await new PipelineExecutor(pipeline).execute();
    expect(baseRun.status).toBe("completed");
    expect(baseRun.nodes.get("a")!.status).toBe("completed");
    expect(baseRun.nodes.get("b")!.status).toBe("completed");
    expect(firstRunPlans["node-b-code"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "spec.md", type: "text" }),
        expect.objectContaining({ path: "schema.json", type: "text" }),
        expect.objectContaining({ path: "diagram.png", type: "binary" }),
      ]),
    );

    shared.executeRunMock.mockReset();
    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      rerunPlans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-a-content") {
        throw new Error("node-a-content must be hydrated from checkpoint during rerun");
      }

      if (plan.task === "node-b-code") {
        const gitOut = createGitCommitOutput(repoPath, "forge/e2e/files-git-rerun", "rerun endpoint", [
          { path: "src/health.ts", content: "export const health = () => ({ status: 'ok', rerun: true });\n" },
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
    expect(rerun.nodes.get("b")!.status).toBe("completed");
    expect(rerunPlans["node-b-code"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "spec.md", type: "text" }),
        expect.objectContaining({ path: "schema.json", type: "text" }),
        expect.objectContaining({ path: "diagram.png", type: "binary" }),
      ]),
    );
    expect(git(repoPath, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repoPath, 'branch --list "forgectl-fanin-*"')).toBe("");
  });

  it("runs git->files and preserves add/modify/delete/rename + binary metadata", async () => {
    const repoPath = createRepo(tempPaths);
    const plans: Record<string, PlanSnapshot> = {};

    writeOutputFile(repoPath, "src/app.ts", "export const version = 1;\n");
    writeOutputFile(repoPath, "docs/old-name.md", "legacy docs\n");
    writeOutputFile(repoPath, "remove-me.md", "delete this\n");
    git(repoPath, "add -A");
    git(repoPath, '-c user.name="Test" -c user.email="test@example.com" commit -m "seed files"');

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      plans[plan.task] = snapshotPlan(plan);

      if (plan.task === "node-a-code") {
        git(repoPath, "checkout -B forge/e2e/git-files");
        writeOutputFile(repoPath, "src/app.ts", "export const version = 2;\n");
        writeOutputFile(repoPath, "docs/guide.md", "new guide\n");
        writeOutputFile(repoPath, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 7, 5, 3]));
        renameSync(join(repoPath, "docs/old-name.md"), join(repoPath, "docs/new-name.md"));
        rmSync(join(repoPath, "remove-me.md"));
        git(repoPath, "add -A");
        git(repoPath, '-c user.name="Test" -c user.email="test@example.com" commit -m "mixed changes"');
        const sha = git(repoPath, "rev-parse HEAD");
        git(repoPath, "checkout main");
        return {
          success: true,
          output: {
            mode: "git",
            branch: "forge/e2e/git-files",
            sha,
            filesChanged: 5,
            insertions: 4,
            deletions: 2,
          },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-b-content") {
        const output = createFilesOutput(tempPaths, "git-files-docs", [
          { path: "docs.md", content: "generated docs\n" },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 32 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      throw new Error(`Unexpected task: ${plan.task}`);
    });

    const pipeline = {
      name: "e2e-git-files",
      defaults: { repo: repoPath },
      nodes: [
        { id: "code-a", task: "node-a-code", workflow: "code" },
        { id: "content-b", task: "node-b-content", workflow: "content", depends_on: ["code-a"] },
      ],
    };

    const result = await new PipelineExecutor(pipeline).execute();
    expect(result.status).toBe("completed");
    expect(result.nodes.get("code-a")!.status).toBe("completed");
    expect(result.nodes.get("content-b")!.status).toBe("completed");

    expect(plans["node-b-content"].manifestEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/app.ts", changeKind: "modified", type: "text" }),
        expect.objectContaining({ path: "docs/guide.md", changeKind: "added", type: "text" }),
        expect.objectContaining({ path: "assets/logo.png", changeKind: "added", type: "binary" }),
        expect.objectContaining({ path: "remove-me.md", changeKind: "deleted", type: "deleted" }),
        expect.objectContaining({
          path: "docs/new-name.md",
          previousPath: "docs/old-name.md",
          changeKind: "renamed",
        }),
      ]),
    );
    expect(plans["node-b-content"].contextText.join("\n")).toContain("version = 2");
    expect(git(repoPath, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repoPath, 'branch --list "forgectl-fanin-*"')).toBe("");
  });

  it("runs files->files fan-in with overlapping namespaced artifacts and binary preservation", async () => {
    const stagedSnapshot: { files: string[]; notesA?: string; notesB?: string; bytesA?: number[]; bytesB?: number[] } = {
      files: [],
    };

    shared.executeRunMock.mockImplementation(async (plan: RunPlan) => {
      if (plan.task === "node-research-a") {
        const output = createFilesOutput(tempPaths, "research-a", [
          { path: "notes.md", content: "source A notes\n" },
          { path: "shared/config.json", content: JSON.stringify({ source: "a" }) },
          { path: "images/chart.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 120 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-research-b") {
        const output = createFilesOutput(tempPaths, "research-b", [
          { path: "notes.md", content: "source B notes\n" },
          { path: "shared/config.json", content: JSON.stringify({ source: "b" }) },
          { path: "images/chart.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]) },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 120 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      if (plan.task === "node-synthesis") {
        const stagedRoot = plan.input.sources.find(s => s.includes("forgectl-pipe-synthesis-input-"));
        if (!stagedRoot) {
          throw new Error("Expected staged input root for synthesis node");
        }

        const files = [
          "upstream/research-a/notes.md",
          "upstream/research-a/shared/config.json",
          "upstream/research-a/images/chart.png",
          "upstream/research-b/notes.md",
          "upstream/research-b/shared/config.json",
          "upstream/research-b/images/chart.png",
        ];
        for (const file of files) {
          readFileSync(join(stagedRoot, file));
        }

        stagedSnapshot.files = files;
        stagedSnapshot.notesA = readFileSync(join(stagedRoot, "upstream/research-a/notes.md"), "utf-8");
        stagedSnapshot.notesB = readFileSync(join(stagedRoot, "upstream/research-b/notes.md"), "utf-8");
        stagedSnapshot.bytesA = [...readFileSync(join(stagedRoot, "upstream/research-a/images/chart.png"))];
        stagedSnapshot.bytesB = [...readFileSync(join(stagedRoot, "upstream/research-b/images/chart.png"))];

        const output = createFilesOutput(tempPaths, "synthesis", [
          { path: "summary.md", content: "synthesized\n" },
        ]);
        return {
          success: true,
          output: { mode: "files", dir: output.dir, files: output.files, totalSize: 20 },
          validation: { passed: true, totalAttempts: 1, stepResults: [] },
          durationMs: 10,
        };
      }

      throw new Error(`Unexpected task: ${plan.task}`);
    });

    const pipeline = {
      name: "e2e-files-files-fanin",
      nodes: [
        { id: "research-a", task: "node-research-a", workflow: "research" },
        { id: "research-b", task: "node-research-b", workflow: "content" },
        { id: "synthesis", task: "node-synthesis", workflow: "content", depends_on: ["research-a", "research-b"] },
      ],
    };

    const result = await new PipelineExecutor(pipeline).execute();
    expect(result.status).toBe("completed");
    expect(result.nodes.get("research-a")!.status).toBe("completed");
    expect(result.nodes.get("research-b")!.status).toBe("completed");
    expect(result.nodes.get("synthesis")!.status).toBe("completed");

    expect(stagedSnapshot.files).toEqual([
      "upstream/research-a/notes.md",
      "upstream/research-a/shared/config.json",
      "upstream/research-a/images/chart.png",
      "upstream/research-b/notes.md",
      "upstream/research-b/shared/config.json",
      "upstream/research-b/images/chart.png",
    ]);
    expect(stagedSnapshot.notesA).toContain("source A");
    expect(stagedSnapshot.notesB).toContain("source B");
    expect(stagedSnapshot.bytesA).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(stagedSnapshot.bytesB).toEqual([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]);
  });
});
