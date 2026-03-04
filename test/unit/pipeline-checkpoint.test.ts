import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionResult } from "../../src/orchestration/single.js";

const testDir = join(tmpdir(), `forgectl-checkpoint-test-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Import after mock setup
const { saveCheckpoint, loadCheckpoint, listCheckpoints } = await import("../../src/pipeline/checkpoint.js");

function makeGitResult(): ExecutionResult {
  return {
    success: true,
    output: {
      mode: "git",
      branch: "forge/test/12345",
      sha: "abc123def",
      filesChanged: 3,
      insertions: 50,
      deletions: 10,
    },
    validation: { passed: true, totalAttempts: 1, stepResults: [] },
    durationMs: 5000,
  };
}

function makeFileResult(): ExecutionResult {
  const outDir = join(testDir, "test-output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.md"), "# Report\nContent here.");
  writeFileSync(join(outDir, "data.json"), '{"key":"value"}');

  return {
    success: true,
    output: {
      mode: "files",
      dir: outDir,
      files: ["report.md", "data.json"],
      totalSize: 100,
    },
    validation: { passed: true, totalAttempts: 1, stepResults: [] },
    durationMs: 3000,
  };
}

describe("pipeline checkpoints", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and loads a git-mode checkpoint", async () => {
    const result = makeGitResult();
    const ref = await saveCheckpoint("run-1", "node-a", result);

    expect(ref.nodeId).toBe("node-a");
    expect(ref.pipelineRunId).toBe("run-1");
    expect(ref.branch).toBe("forge/test/12345");
    expect(ref.timestamp).toBeTruthy();

    const loaded = await loadCheckpoint("run-1", "node-a");
    expect(loaded).not.toBeNull();
    expect(loaded!.nodeId).toBe("node-a");
    expect(loaded!.branch).toBe("forge/test/12345");
  });

  it("saves and loads a files-mode checkpoint", async () => {
    const result = makeFileResult();
    const ref = await saveCheckpoint("run-2", "node-b", result);

    expect(ref.nodeId).toBe("node-b");
    expect(ref.outputDir).toBeTruthy();

    const loaded = await loadCheckpoint("run-2", "node-b");
    expect(loaded).not.toBeNull();
    expect(loaded!.outputDir).toBeTruthy();

    // Check output files were copied
    expect(existsSync(join(loaded!.outputDir!, "report.md"))).toBe(true);
    expect(existsSync(join(loaded!.outputDir!, "data.json"))).toBe(true);
  });

  it("returns null for missing checkpoint", async () => {
    const loaded = await loadCheckpoint("nonexistent", "node-x");
    expect(loaded).toBeNull();
  });

  it("lists checkpoints for a pipeline run", async () => {
    await saveCheckpoint("run-3", "node-a", makeGitResult());
    await saveCheckpoint("run-3", "node-b", makeGitResult());

    const checkpoints = await listCheckpoints("run-3");
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map(c => c.nodeId).sort()).toEqual(["node-a", "node-b"]);
  });

  it("returns empty list for nonexistent pipeline run", async () => {
    const checkpoints = await listCheckpoints("nonexistent");
    expect(checkpoints).toHaveLength(0);
  });
});
