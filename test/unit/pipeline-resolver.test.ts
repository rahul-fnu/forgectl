import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeExecution, PipelineDefinition } from "../../src/pipeline/types.js";
import type { OutputResult } from "../../src/output/types.js";
import { getWorkflowOutputMode, resolveNodeInput } from "../../src/pipeline/resolver.js";

function completedNode(nodeId: string, output: OutputResult): NodeExecution {
  return {
    nodeId,
    status: "completed",
    result: {
      success: true,
      output,
      validation: { passed: true, totalAttempts: 1, stepResults: [] },
      durationMs: 10,
    },
  };
}

function makePipeline(nodes: PipelineDefinition["nodes"], defaults?: PipelineDefinition["defaults"]): PipelineDefinition {
  return { name: "resolver-test", nodes, defaults };
}

describe("pipeline resolver", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const path of tempPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    tempPaths.length = 0;
  });

  it("maps workflow names to output mode", () => {
    expect(getWorkflowOutputMode("code")).toBe("git");
    expect(getWorkflowOutputMode("ops")).toBe("git");
    expect(getWorkflowOutputMode("research")).toBe("files");
    expect(getWorkflowOutputMode("content")).toBe("files");
  });

  it("pipes files output into git-mode downstream context", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "forgectl-resolver-files-"));
    tempPaths.push(outputDir);
    writeFileSync(join(outputDir, "spec.md"), "# Health endpoint\nReturn status + uptime.\n", "utf-8");

    const pipeline = makePipeline([
      { id: "research", task: "write spec", workflow: "content" },
      { id: "implement", task: "implement endpoint", workflow: "code", repo: "/tmp/repo", depends_on: ["research"] },
    ]);

    const nodeStates = new Map<string, NodeExecution>([
      ["research", completedNode("research", { mode: "files", dir: outputDir, files: ["spec.md"], totalSize: 10 })],
    ]);

    const resolved = await resolveNodeInput(pipeline.nodes[1], pipeline, nodeStates, { repo: "/tmp/repo" });

    expect(resolved.files).toEqual([]);
    expect(resolved.contextContent).toHaveLength(1);
    expect(resolved.contextContent[0].name).toContain("spec.md");
    expect(resolved.contextContent[0].content).toContain("Health endpoint");
  });

  it("pipes files output into files-mode downstream input", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "forgectl-resolver-files-"));
    tempPaths.push(outputDir);
    writeFileSync(join(outputDir, "notes.md"), "upstream notes", "utf-8");

    const pipeline = makePipeline([
      { id: "research", task: "notes", workflow: "research" },
      { id: "docs", task: "write docs", workflow: "content", input: ["/tmp/manual.md"], depends_on: ["research"] },
    ]);

    const nodeStates = new Map<string, NodeExecution>([
      ["research", completedNode("research", { mode: "files", dir: outputDir, files: ["notes.md"], totalSize: 5 })],
    ]);

    const resolved = await resolveNodeInput(pipeline.nodes[1], pipeline, nodeStates);

    expect(resolved.files).toEqual(["/tmp/manual.md", join(outputDir, "notes.md")]);
    expect(resolved.contextContent).toEqual([]);
  });

  it("pipes git output into files-mode downstream context", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "forgectl-resolver-git-"));
    tempPaths.push(repoDir);

    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git checkout -B main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "index.js"), "module.exports = {}\n", "utf-8");
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync('git -c user.name="Test" -c user.email="test@example.com" commit -m "init"', {
      cwd: repoDir,
      stdio: "pipe",
    });

    execSync("git checkout -b forge/test/health", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "health.js"), "module.exports = () => ({ status: \"ok\" });\n", "utf-8");
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync('git -c user.name="Test" -c user.email="test@example.com" commit -m "add health"', {
      cwd: repoDir,
      stdio: "pipe",
    });
    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });

    const pipeline = makePipeline([
      { id: "implement", task: "implement", workflow: "code", repo: repoDir },
      { id: "docs", task: "document", workflow: "content", depends_on: ["implement"] },
    ], { repo: repoDir });

    const nodeStates = new Map<string, NodeExecution>([
      ["implement", completedNode("implement", {
        mode: "git",
        branch: "forge/test/health",
        sha,
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
      })],
    ]);

    const resolved = await resolveNodeInput(pipeline.nodes[1], pipeline, nodeStates, { repo: repoDir });

    expect(resolved.contextContent.some(c => c.name.includes("health.js"))).toBe(true);
    expect(resolved.contextContent.map(c => c.content).join("\n")).toContain("status");
  });

  it("keeps git branches for downstream git-mode nodes", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "a", workflow: "code" },
      { id: "b", task: "b", workflow: "code", depends_on: ["a"] },
    ], { repo: "/tmp/repo" });

    const nodeStates = new Map<string, NodeExecution>([
      ["a", completedNode("a", {
        mode: "git",
        branch: "forge/test/123",
        sha: "abc123",
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
      })],
    ]);

    const resolved = await resolveNodeInput(pipeline.nodes[1], pipeline, nodeStates, { repo: "/tmp/repo" });

    expect(resolved.branch).toBe("forge/test/123");
    expect(resolved.upstreamBranches).toEqual(["forge/test/123"]);
    expect(resolved.contextContent).toEqual([]);
  });
});
