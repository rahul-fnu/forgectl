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
  loadCheckpoint: vi.fn().mockResolvedValue(null),
  saveLoopCheckpoint: vi.fn(),
  loadLoopCheckpoint: vi.fn().mockReturnValue(null),
  GLOBAL_MAX_ITERATIONS: 50,
}));

import { PipelineExecutor } from "../../src/pipeline/executor.js";
import { executeRun } from "../../src/orchestration/modes.js";
import { loadCheckpoint, loadLoopCheckpoint } from "../../src/pipeline/checkpoint.js";

function makePipeline(nodes: PipelineDefinition["nodes"], defaults?: PipelineDefinition["defaults"]): PipelineDefinition {
  return { name: "test", nodes, defaults };
}

describe("PipelineExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadCheckpoint).mockResolvedValue(null);
    vi.mocked(loadLoopCheckpoint).mockReturnValue(null);
    // Reset executeRun to the default success response after clearAllMocks
    vi.mocked(executeRun).mockResolvedValue({
      success: true,
      output: { mode: "git", branch: "forge/test/123", sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
      validation: { passed: true, totalAttempts: 1, stepResults: [] },
      durationMs: 1000,
    });
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

  it("propagates skip when a dependency is skipped without hydrated output", async () => {
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
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    expect(executeRun).toHaveBeenCalledTimes(1); // Only a was executed
    expect(result.nodes.get("b")!.status).toBe("skipped");
    expect(result.nodes.get("c")!.status).toBe("skipped");
    // Ready-queue: b is skipped because dep a failed; c is cascade-skipped because b was skipped
    expect(result.nodes.get("b")!.skipReason).toContain("dependency a was skipped");
    expect(result.nodes.get("c")!.skipReason).toContain("dependency b was skipped");
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

  it("rerun without checkpoint source re-executes required ancestors", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline, { fromNode: "b" });
    const result = await executor.execute();

    expect(result.nodes.get("a")!.status).toBe("completed");
    expect(result.nodes.get("b")!.status).toBe("completed");
    expect(result.nodes.get("c")!.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(3);
  });

  it("rerun with checkpoint source hydrates only fromNode ancestors", async () => {
    vi.mocked(loadCheckpoint).mockImplementation(async (runId, nodeId) => {
      if (runId === "base-run" && nodeId === "a") {
        return {
          nodeId: "a",
          pipelineRunId: "base-run",
          timestamp: "2024-01-01T00:00:00.000Z",
          branch: "forge/a/123",
          commitSha: "abc123",
        };
      }
      return null;
    });

    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b" },
      { id: "c", task: "do c", depends_on: ["a"] },
      { id: "d", task: "do d", depends_on: ["c", "b"] },
      { id: "e", task: "do e", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline, {
      fromNode: "c",
      checkpointSourceRunId: "base-run",
    });
    const result = await executor.execute();

    expect(result.nodes.get("a")!.status).toBe("skipped");
    expect(result.nodes.get("a")!.hydratedFromCheckpoint?.pipelineRunId).toBe("base-run");
    expect(result.nodes.get("a")!.result?.success).toBe(true);
    expect(result.nodes.get("b")!.status).toBe("completed");
    expect(result.nodes.get("c")!.status).toBe("completed");
    expect(result.nodes.get("d")!.status).toBe("completed");
    expect(result.nodes.get("e")!.status).toBe("skipped");
    expect(result.nodes.get("e")!.skipReason).toContain("not required");
    expect(executeRun).toHaveBeenCalledTimes(3); // b, c, d
  });

  it("fails rerun when required checkpoint is missing", async () => {
    vi.mocked(loadCheckpoint).mockResolvedValue(null);

    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline, {
      fromNode: "b",
      checkpointSourceRunId: "missing-run",
    });

    await expect(executor.execute()).rejects.toThrow(/Missing checkpoint/);
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

  // ── Conditional execution tests ────────────────────────────────────────────

  it("condition true: node executes normally", async () => {
    // a completes, then b has condition `a == "completed"` → true → b runs
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: 'a == "completed"' },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("a")!.status).toBe("completed");
    expect(result.nodes.get("b")!.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(2);
  });

  it("condition false: node is skipped with correct skipReason", async () => {
    // a completes, but b requires a to have failed — condition is false
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: 'a == "failed"' },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.nodes.get("a")!.status).toBe("completed");
    expect(result.nodes.get("b")!.status).toBe("skipped");
    expect(result.nodes.get("b")!.skipReason).toContain('a == "failed"');
    expect(executeRun).toHaveBeenCalledTimes(1); // only a
  });

  it("condition false + else_node: conditional node skipped, else_node executes", async () => {
    // a completes; b has condition `a == "failed"` (false) and else_node "c"; c should run
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: 'a == "failed"', else_node: "c" },
      { id: "c", task: "do c" },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.nodes.get("a")!.status).toBe("completed");
    expect(result.nodes.get("b")!.status).toBe("skipped");
    expect(result.nodes.get("b")!.skipReason).toContain("condition false");
    expect(result.nodes.get("c")!.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(2); // a and c
  });

  it("cascade skip: false condition propagates to all downstream dependents", async () => {
    // a completes; b has false condition and no else_node; c depends on b → both b and c skipped
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: 'a == "failed"' },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.nodes.get("a")!.status).toBe("completed");
    expect(result.nodes.get("b")!.status).toBe("skipped");
    expect(result.nodes.get("c")!.status).toBe("skipped");
    expect(result.nodes.get("c")!.skipReason).toContain("dependency b was skipped");
    expect(executeRun).toHaveBeenCalledTimes(1); // only a
  });

  it("unknown variable in condition: pipeline fails immediately (COND-06)", async () => {
    // b references 'unknown_node' which is not in context → ConditionVariableError → pipeline fails
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: 'unknown_node == "completed"' },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    expect(result.nodes.get("b")!.status).toBe("failed");
    expect(result.nodes.get("b")!.error).toMatch(/unknown|unknown_node/i);
    expect(executeRun).toHaveBeenCalledTimes(1); // only a ran
  });

  // ── Dry-run condition annotation tests ────────────────────────────────────

  it("dry-run: conditional node with condition true on happy path is annotated RUN", async () => {
    const pipeline = makePipeline([
      { id: "build", task: "build it" },
      { id: "deploy", task: "deploy it", depends_on: ["build"], condition: 'build == "completed"' },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const executor = new PipelineExecutor(pipeline, { dryRun: true });
    const result = await executor.execute();
    consoleSpy.mockRestore();

    expect(result.status).toBe("completed");
    expect(executeRun).not.toHaveBeenCalled();
    // deploy was annotated RUN (condition is true on happy path)
    expect(result.nodes.get("deploy")!.status).toBe("pending"); // not overridden since RUN
  });

  it("dry-run: conditional node with condition false on happy path is annotated SKIP", async () => {
    // if_failed shorthand: condition is `build == "failed"` — false on happy path
    const pipeline = makePipeline([
      { id: "build", task: "build it" },
      { id: "notify", task: "notify failure", depends_on: ["build"], condition: 'build == "failed"' },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const executor = new PipelineExecutor(pipeline, { dryRun: true });
    const result = await executor.execute();
    consoleSpy.mockRestore();

    expect(result.status).toBe("completed");
    expect(executeRun).not.toHaveBeenCalled();
    // notify is skipped on happy path (condition false)
    expect(result.nodes.get("notify")!.status).toBe("skipped");
    expect(result.nodes.get("notify")!.skipReason).toContain("condition false on happy path");
  });

  it("dry-run: invalid condition expression reports error and fails pipeline", async () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"], condition: "!!@@invalid!!" },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const executor = new PipelineExecutor(pipeline, { dryRun: true });
    const result = await executor.execute();
    consoleSpy.mockRestore();

    expect(result.status).toBe("failed");
    expect(executeRun).not.toHaveBeenCalled();
  });

  // ── Loop node execution tests ──────────────────────────────────────────────

  it("loop node: completes when until expression becomes true after body succeeds", async () => {
    // executeRun returns success=true → _status="completed" → until `_status == "completed"` is true → loop completes in 1 iteration
    vi.mocked(executeRun).mockResolvedValue({
      success: true,
      output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
      validation: { passed: true, totalAttempts: 1, stepResults: [] },
      durationMs: 500,
    });

    const pipeline = makePipeline([
      {
        id: "retry-loop",
        task: "Retry until success",
        node_type: "loop",
        loop: { until: `_status == "completed"`, max_iterations: 5 },
      },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("retry-loop")!.status).toBe("completed");
    expect(result.nodes.get("retry-loop")!.loopState).toBeDefined();
    expect(result.nodes.get("retry-loop")!.loopState!.iterations).toHaveLength(1);
    expect(result.nodes.get("retry-loop")!.loopState!.iterations[0].status).toBe("completed");
  });

  it("loop node: body failure is iteration result, not loop termination", async () => {
    // First 2 calls return failure, 3rd returns success
    vi.mocked(executeRun)
      .mockResolvedValueOnce({
        success: false,
        output: undefined,
        validation: { passed: false, totalAttempts: 1, stepResults: [] },
        durationMs: 500,
        error: "Agent failed",
      })
      .mockResolvedValueOnce({
        success: false,
        output: undefined,
        validation: { passed: false, totalAttempts: 1, stepResults: [] },
        durationMs: 500,
        error: "Agent failed again",
      })
      .mockResolvedValue({
        success: true,
        output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 500,
      });

    const pipeline = makePipeline([
      {
        id: "retry-loop",
        task: "Retry until success",
        node_type: "loop",
        loop: { until: `_status == "completed"`, max_iterations: 5 },
      },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("retry-loop")!.status).toBe("completed");
    expect(result.nodes.get("retry-loop")!.loopState!.iterations).toHaveLength(3);
    expect(result.nodes.get("retry-loop")!.loopState!.iterations[0].status).toBe("failed");
    expect(result.nodes.get("retry-loop")!.loopState!.iterations[1].status).toBe("failed");
    expect(result.nodes.get("retry-loop")!.loopState!.iterations[2].status).toBe("completed");
    // executeRun was called 3 times (once per iteration)
    expect(executeRun).toHaveBeenCalledTimes(3);
  });

  it("loop node: exhaustion after max_iterations without until becoming true", async () => {
    // always fails → until never true → exhaustion after max_iterations=3
    vi.mocked(executeRun).mockResolvedValue({
      success: false,
      output: undefined,
      validation: { passed: false, totalAttempts: 1, stepResults: [] },
      durationMs: 500,
      error: "Always fails",
    });

    const pipeline = makePipeline([
      {
        id: "my-loop",
        task: "Always fail",
        node_type: "loop",
        loop: { until: `_status == "completed"`, max_iterations: 3 },
      },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    expect(result.nodes.get("my-loop")!.status).toBe("failed");
    expect(result.nodes.get("my-loop")!.error).toContain('Loop "my-loop" exhausted max_iterations (3)');
    expect(result.nodes.get("my-loop")!.loopState!.iterations).toHaveLength(3);
    expect(executeRun).toHaveBeenCalledTimes(3);
  });

  it("dry-run: loop node annotated with LOOP(max:N, until: expr)", async () => {
    const pipeline = makePipeline([
      {
        id: "retry-loop",
        task: "Retry until done",
        node_type: "loop",
        loop: { until: `_status == "completed"`, max_iterations: 5 },
      },
    ]);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.join(" "));
    });
    const executor = new PipelineExecutor(pipeline, { dryRun: true });
    const result = await executor.execute();
    consoleSpy.mockRestore();

    expect(result.status).toBe("completed");
    expect(executeRun).not.toHaveBeenCalled();
    // Check that the loop annotation appeared in console output
    const loopAnnotated = logLines.some(line => line.includes("LOOP(max:5") && line.includes(`_status == "completed"`));
    expect(loopAnnotated).toBe(true);
  });

  // ── Complex DAG: parallel tracks with diamond convergence ────────────────
  //
  //   Track A:          Track B:
  //     A1                 B1
  //      |                  |
  //     A2                 B2
  //      \                /
  //       +--- C1 ---+
  //            |
  //           C2
  //

  it("complex DAG: parallel tracks execute concurrently and converge", async () => {
    const callOrder: string[] = [];
    const inFlight = new Set<string>();
    let maxConcurrent = 0;
    vi.mocked(executeRun).mockImplementation(async (plan) => {
      inFlight.add(plan.task);
      maxConcurrent = Math.max(maxConcurrent, inFlight.size);
      // Small delay to allow parallel tasks to overlap
      await new Promise(r => setTimeout(r, 10));
      callOrder.push(plan.task);
      inFlight.delete(plan.task);
      return {
        success: true,
        output: { mode: "git", branch: `forge/${plan.task}/123`, sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
      };
    });

    const pipeline = makePipeline([
      { id: "a1", task: "Auth middleware" },
      { id: "a2", task: "Rate limiter", depends_on: ["a1"] },
      { id: "b1", task: "History/undo system" },
      { id: "b2", task: "Pipe stdin support", depends_on: ["b1"] },
      { id: "c1", task: "Shared SDK", depends_on: ["a2", "b2"] },
      { id: "c2", task: "Integration test", depends_on: ["c1"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(6);

    // All nodes completed
    for (const nodeId of ["a1", "a2", "b1", "b2", "c1", "c2"]) {
      expect(result.nodes.get(nodeId)!.status).toBe("completed");
    }

    // Stacked diffs: A1 before A2, B1 before B2
    expect(callOrder.indexOf("Auth middleware")).toBeLessThan(callOrder.indexOf("Rate limiter"));
    expect(callOrder.indexOf("History/undo system")).toBeLessThan(callOrder.indexOf("Pipe stdin support"));

    // Diamond convergence: C1 after both A2 and B2
    expect(callOrder.indexOf("Rate limiter")).toBeLessThan(callOrder.indexOf("Shared SDK"));
    expect(callOrder.indexOf("Pipe stdin support")).toBeLessThan(callOrder.indexOf("Shared SDK"));

    // Final: C2 last
    expect(callOrder.indexOf("Shared SDK")).toBeLessThan(callOrder.indexOf("Integration test"));
    expect(callOrder[callOrder.length - 1]).toBe("Integration test");

    // Parallel execution: roots (a1, b1) should overlap
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("complex DAG: track A failure skips C1/C2 but track B still completes", async () => {
    vi.mocked(executeRun).mockImplementation(async (plan) => {
      // A1 fails
      if (plan.task === "Auth middleware") {
        return {
          success: false,
          output: undefined,
          validation: { passed: false, totalAttempts: 1, stepResults: [] },
          durationMs: 500,
          error: "Auth middleware failed",
        };
      }
      return {
        success: true,
        output: { mode: "git", branch: `forge/test/123`, sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
      };
    });

    const pipeline = makePipeline([
      { id: "a1", task: "Auth middleware" },
      { id: "a2", task: "Rate limiter", depends_on: ["a1"] },
      { id: "b1", task: "History/undo system" },
      { id: "b2", task: "Pipe stdin support", depends_on: ["b1"] },
      { id: "c1", task: "Shared SDK", depends_on: ["a2", "b2"] },
      { id: "c2", task: "Integration test", depends_on: ["c1"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");

    // Track A: a1 failed, a2 cascade-skipped
    expect(result.nodes.get("a1")!.status).toBe("failed");
    expect(result.nodes.get("a2")!.status).toBe("skipped");

    // Track B: both completed independently
    expect(result.nodes.get("b1")!.status).toBe("completed");
    expect(result.nodes.get("b2")!.status).toBe("completed");

    // Convergence: c1 skipped because a2 was skipped, c2 cascade-skipped
    expect(result.nodes.get("c1")!.status).toBe("skipped");
    expect(result.nodes.get("c2")!.status).toBe("skipped");
  });

  it("complex DAG: convergence node C1 fails, only C2 is skipped", async () => {
    vi.mocked(executeRun).mockImplementation(async (plan) => {
      if (plan.task === "Shared SDK") {
        return {
          success: false,
          output: undefined,
          validation: { passed: false, totalAttempts: 1, stepResults: [] },
          durationMs: 500,
          error: "SDK build failed",
        };
      }
      return {
        success: true,
        output: { mode: "git", branch: `forge/test/123`, sha: "abc", filesChanged: 1, insertions: 10, deletions: 2 },
        validation: { passed: true, totalAttempts: 1, stepResults: [] },
        durationMs: 1000,
      };
    });

    const pipeline = makePipeline([
      { id: "a1", task: "Auth middleware" },
      { id: "a2", task: "Rate limiter", depends_on: ["a1"] },
      { id: "b1", task: "History/undo system" },
      { id: "b2", task: "Pipe stdin support", depends_on: ["b1"] },
      { id: "c1", task: "Shared SDK", depends_on: ["a2", "b2"] },
      { id: "c2", task: "Integration test", depends_on: ["c1"] },
    ]);

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");

    // Both tracks completed successfully
    for (const nodeId of ["a1", "a2", "b1", "b2"]) {
      expect(result.nodes.get(nodeId)!.status).toBe("completed");
    }

    // Convergence failed, final skipped
    expect(result.nodes.get("c1")!.status).toBe("failed");
    expect(result.nodes.get("c2")!.status).toBe("skipped");
    expect(result.nodes.get("c2")!.skipReason).toContain("c1");

    // All 5 upstream nodes executed, c2 was skipped
    expect(executeRun).toHaveBeenCalledTimes(5);
  });

  it("checkpoint-hydrated skips do not trigger cascade skip", async () => {
    // a is hydrated from checkpoint (status=skipped + hydratedFromCheckpoint + result.success)
    // b depends on a and has no condition — b should execute (NOT be cascade-skipped)
    vi.mocked(loadCheckpoint).mockImplementation(async (runId, nodeId) => {
      if (runId === "prior-run" && nodeId === "a") {
        return {
          nodeId: "a",
          pipelineRunId: "prior-run",
          timestamp: "2024-01-01T00:00:00.000Z",
          branch: "forge/a/abc",
          commitSha: "abc123",
        };
      }
      return null;
    });

    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);

    const executor = new PipelineExecutor(pipeline, {
      fromNode: "b",
      checkpointSourceRunId: "prior-run",
    });
    const result = await executor.execute();

    // a was hydrated (skipped with success result), b should have run
    expect(result.nodes.get("a")!.status).toBe("skipped");
    expect(result.nodes.get("a")!.hydratedFromCheckpoint?.pipelineRunId).toBe("prior-run");
    expect(result.nodes.get("b")!.status).toBe("completed");
    expect(executeRun).toHaveBeenCalledTimes(1); // only b
  });
});
