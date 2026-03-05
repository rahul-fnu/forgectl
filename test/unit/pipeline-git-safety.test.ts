import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineDefinition } from "../../src/pipeline/types.js";
import { PipelineExecutor } from "../../src/pipeline/executor.js";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

function commit(cwd: string, message: string): void {
  run(`git -c user.name="Test" -c user.email="test@example.com" add -A`, cwd);
  run(`git -c user.name="Test" -c user.email="test@example.com" commit -m "${message}"`, cwd);
}

function makeResult(branch: string) {
  return {
    success: true,
    output: { mode: "git", branch, sha: "sha", filesChanged: 1, insertions: 1, deletions: 0 },
    validation: { passed: true, totalAttempts: 1, stepResults: [] },
    durationMs: 1,
  };
}

describe("pipeline git safety", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("serializes repo mutations with per-repo lock", async () => {
    const pipeline: PipelineDefinition = { name: "lock", nodes: [{ id: "a", task: "a" }] };
    const executor = new PipelineExecutor(pipeline);
    const withRepoLock = (executor as unknown as { withRepoLock: (repoPath: string, fn: () => Promise<void>) => Promise<void> }).withRepoLock.bind(executor);

    let active = 0;
    let maxActive = 0;

    await Promise.all([
      withRepoLock("/tmp/lock-repo", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 40));
        active -= 1;
      }),
      withRepoLock("/tmp/lock-repo", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 40));
        active -= 1;
      }),
    ]);

    expect(maxActive).toBe(1);
  });

  it("restores original ref and cleans temp fan-in branch", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgectl-fanin-safe-"));
    tempDirs.push(repo);

    run("git init", repo);
    run("git checkout -B main", repo);
    writeFileSync(join(repo, "base.txt"), "base\n", "utf-8");
    commit(repo, "init");

    run("git checkout -b up-a", repo);
    writeFileSync(join(repo, "a.txt"), "a\n", "utf-8");
    commit(repo, "a");

    run("git checkout main", repo);
    run("git checkout -b up-b", repo);
    writeFileSync(join(repo, "b.txt"), "b\n", "utf-8");
    commit(repo, "b");

    run("git checkout main", repo);

    const pipeline: PipelineDefinition = {
      name: "fanin",
      nodes: [
        { id: "a", task: "a" },
        { id: "b", task: "b" },
        { id: "c", task: "c", depends_on: ["a", "b"] },
      ],
    };
    const executor = new PipelineExecutor(pipeline);
    const states = (executor as unknown as { nodeStates: Map<string, unknown> }).nodeStates;
    states.set("a", { nodeId: "a", status: "completed", result: makeResult("up-a") });
    states.set("b", { nodeId: "b", status: "completed", result: makeResult("up-b") });

    const prepare = (executor as unknown as { prepareFanInBranch: (node: PipelineDefinition["nodes"][number], repoPath: string) => { tempBranch: string } | null }).prepareFanInBranch.bind(executor);
    const cleanup = (executor as unknown as { cleanupFanInBranch: (ctx: { repoPath: string; tempBranch: string; originalRef: string; originalSha: string }) => void }).cleanupFanInBranch.bind(executor);
    const context = prepare(pipeline.nodes[2], repo);
    expect(context).not.toBeNull();
    expect(run("git rev-parse --abbrev-ref HEAD", repo)).toBe(context!.tempBranch);
    expect(run(`git branch --list ${context!.tempBranch}`, repo)).toContain(context!.tempBranch);

    cleanup(context!);

    expect(run("git rev-parse --abbrev-ref HEAD", repo)).toBe("main");
    expect(run(`git branch --list ${context!.tempBranch}`, repo)).toBe("");
  });

  it("fails cleanly on fan-in merge conflict and restores host repo state", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgectl-fanin-conflict-"));
    tempDirs.push(repo);

    run("git init", repo);
    run("git checkout -B main", repo);
    writeFileSync(join(repo, "conflict.txt"), "base\n", "utf-8");
    commit(repo, "init");

    run("git checkout -b up-a", repo);
    writeFileSync(join(repo, "conflict.txt"), "from-a\n", "utf-8");
    commit(repo, "a");

    run("git checkout main", repo);
    run("git checkout -b up-b", repo);
    writeFileSync(join(repo, "conflict.txt"), "from-b\n", "utf-8");
    commit(repo, "b");
    run("git checkout main", repo);

    const pipeline: PipelineDefinition = {
      name: "fanin",
      nodes: [
        { id: "a", task: "a" },
        { id: "b", task: "b" },
        { id: "c", task: "c", depends_on: ["a", "b"] },
      ],
    };
    const executor = new PipelineExecutor(pipeline);
    const states = (executor as unknown as { nodeStates: Map<string, unknown> }).nodeStates;
    states.set("a", { nodeId: "a", status: "completed", result: makeResult("up-a") });
    states.set("b", { nodeId: "b", status: "completed", result: makeResult("up-b") });

    const prepare = (executor as unknown as { prepareFanInBranch: (node: PipelineDefinition["nodes"][number], repoPath: string) => { tempBranch: string } | null }).prepareFanInBranch.bind(executor);

    expect(() => prepare(pipeline.nodes[2], repo)).toThrow(/Fan-in merge conflict/);
    expect(run("git rev-parse --abbrev-ref HEAD", repo)).toBe("main");
    const branches = run("git branch --list 'forgectl-fanin-*'", repo);
    expect(branches).toBe("");
  });
});
