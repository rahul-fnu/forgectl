import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineDefinition } from "../../src/pipeline/types.js";

// Mock the heavy dependencies
vi.mock("../../src/config/loader.js", () => ({
  loadConfig: () => ({
    agent: { type: "codex", model: "", max_turns: 50, timeout: "30m", flags: [] },
    container: { network: {}, resources: { memory: "4g", cpus: 2 } },
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: [] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: { message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true }, author: { name: "forgectl", email: "forge@localhost" }, sign: false },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
  }),
}));

vi.mock("../../src/orchestration/modes.js", () => ({
  executeRun: vi.fn().mockResolvedValue({
    success: true,
    output: { mode: "git", branch: "forge/test/123", sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
    validation: { passed: true, totalAttempts: 1, stepResults: [] },
    durationMs: 1000,
  }),
}));

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

vi.mock("../../src/pipeline/checkpoint.js", () => ({
  saveCheckpoint: vi.fn().mockResolvedValue({ nodeId: "test", pipelineRunId: "p1", timestamp: "2024-01-01" }),
}));

import { PipelineExecutor } from "../../src/pipeline/executor.js";
import { executeRun } from "../../src/orchestration/modes.js";

function makePipeline(nodes: PipelineDefinition["nodes"], defaults?: PipelineDefinition["defaults"]): PipelineDefinition {
  return { name: "test", nodes, defaults };
}

describe("PipelineExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a linear pipeline in order", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(3);

    // Verify order: a was called first
    const calls = vi.mocked(executeRun).mock.calls;
    expect(calls[0][0].task).toBe("do a");
    expect(calls[1][0].task).toBe("do b");
    expect(calls[2][0].task).toBe("do c");
  });

  it("runs parallel nodes concurrently", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(3);
  });

  it("skips downstream nodes when upstream fails", async () => {
    vi.mocked(executeRun)
      .mockResolvedValueOnce({
        success: false,
        output: undefined,
        validation: { passed: false, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
        error: "Agent failed",
      })
      .mockResolvedValue({
        success: true,
        output: { mode: "git", branch: "forge/test/123", sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
      });

    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    expect(executeRun).toHaveBeenCalledTimes(1); // Only a was executed
    expect(result.nodes.get("b")!.status).toBe("skipped");
  });

  it("fan-in waits for all upstream nodes", async () => {
    const callOrder: string[] = [];
    vi.mocked(executeRun).mockImplementation(async (plan) => {
      callOrder.push(plan.task);
      return {
        success: true,
        output: { mode: "git", branch: "forge/test/123", sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
      };
    });

    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b" },
      { id: "c", task: "do c", depends_on: ["a", "b"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    // c should be last
    expect(callOrder[callOrder.length - 1]).toBe("do c");
  });

  it("dry-run shows plan without executing", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline, { dryRun: true });
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("resume from node skips upstream", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline, { fromNode: "b" });
    const result = await executor.execute();

    // a should be skipped, b and c should run
    expect(result.nodes.get("a")!.status).toBe("skipped");
    expect(executeRun).toHaveBeenCalledTimes(2);
  });

  it("throws on invalid DAG", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a", depends_on: ["b"] },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    await expect(executor.execute()).rejects.toThrow(/[Ii]nvalid pipeline DAG/);
  });

  it("uses pipeline defaults", async () => {
    const pipeline = makePipeline(
      [{ id: "a", task: "do a" }],
      { workflow: "research", agent: "codex" },
    );

    const executor = new PipelineExecutor(pipeline);
    await executor.execute();

    const call = vi.mocked(executeRun).mock.calls[0][0];
    expect(call.workflow.name).toBe("research");
  });
});
