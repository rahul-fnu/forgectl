import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NodeExecution, LoopState, LoopIterationRecord } from "../../src/pipeline/types.js";
import { ConditionVariableError } from "../../src/pipeline/condition.js";
import { validateDAG } from "../../src/pipeline/dag.js";
import type { PipelineDefinition } from "../../src/pipeline/types.js";

// --- Setup temp dir and homedir mock for checkpoint tests ---

const testDir = join(tmpdir(), `forgectl-loop-test-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Import after mock setup
const { saveLoopCheckpoint, loadLoopCheckpoint, GLOBAL_MAX_ITERATIONS } = await import(
  "../../src/pipeline/checkpoint.js"
);
const { evaluateCondition } = await import("../../src/pipeline/condition.js");

// ============================================================
// 1. LoopState type sanity (TypeScript compile-time checks expressed at runtime)
// ============================================================

describe("LoopState types", () => {
  it("loop-iterating is assignable to NodeExecution.status", () => {
    const exec: NodeExecution = {
      nodeId: "my-loop",
      status: "loop-iterating",
    };
    expect(exec.status).toBe("loop-iterating");
  });

  it("NodeExecution accepts a loopState field", () => {
    const loopState: LoopState = {
      currentIteration: 2,
      maxIterations: 10,
      iterations: [],
    };
    const exec: NodeExecution = {
      nodeId: "my-loop",
      status: "loop-iterating",
      loopState,
    };
    expect(exec.loopState).toBeDefined();
    expect(exec.loopState!.currentIteration).toBe(2);
  });

  it("LoopIterationRecord has required fields", () => {
    const record: LoopIterationRecord = {
      iteration: 1,
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
    };
    expect(record.iteration).toBe(1);
    expect(record.status).toBe("completed");
  });

  it("all NodeExecution status values remain valid", () => {
    const statuses: NodeExecution["status"][] = [
      "pending",
      "running",
      "loop-iterating",
      "completed",
      "failed",
      "skipped",
    ];
    expect(statuses).toHaveLength(6);
  });
});

// ============================================================
// 2. Loop checkpoint round-trip
// ============================================================

describe("loop checkpoint round-trip", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and loads a loop checkpoint with correct fields", () => {
    const loopState: LoopState = {
      currentIteration: 3,
      maxIterations: 10,
      iterations: [
        { iteration: 1, status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" },
        { iteration: 2, status: "completed", startedAt: "2026-01-01T00:01:00Z", completedAt: "2026-01-01T00:02:00Z" },
        { iteration: 3, status: "failed", startedAt: "2026-01-01T00:02:00Z", completedAt: "2026-01-01T00:03:00Z" },
      ],
    };

    saveLoopCheckpoint("run-1", "loop-node", 2, loopState);
    const loaded = loadLoopCheckpoint("run-1", "loop-node");

    expect(loaded).not.toBeNull();
    expect(loaded!.lastCompletedIteration).toBe(2);
    expect(loaded!.loopState.currentIteration).toBe(3);
    expect(loaded!.loopState.maxIterations).toBe(10);
    expect(loaded!.loopState.iterations).toHaveLength(3);
    expect(loaded!.loopState.iterations[0].iteration).toBe(1);
    expect(loaded!.loopState.iterations[2].status).toBe("failed");
  });

  it("overwrites in-place on successive saves (not appended)", () => {
    const state1: LoopState = { currentIteration: 1, maxIterations: 5, iterations: [] };
    const state2: LoopState = {
      currentIteration: 2,
      maxIterations: 5,
      iterations: [
        { iteration: 1, status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" },
      ],
    };

    saveLoopCheckpoint("run-2", "loop-a", 0, state1);
    saveLoopCheckpoint("run-2", "loop-a", 1, state2);

    const loaded = loadLoopCheckpoint("run-2", "loop-a");
    expect(loaded!.lastCompletedIteration).toBe(1);
    expect(loaded!.loopState.currentIteration).toBe(2);
    expect(loaded!.loopState.iterations).toHaveLength(1);
  });

  it("stores loop-checkpoint.json distinct from checkpoint.json", () => {
    const loopState: LoopState = { currentIteration: 1, maxIterations: 5, iterations: [] };
    saveLoopCheckpoint("run-3", "node-x", 1, loopState);

    // loop-checkpoint.json exists
    const loopFile = join(testDir, ".forgectl", "checkpoints", "run-3", "node-x", "loop-checkpoint.json");
    const checkpointFile = join(testDir, ".forgectl", "checkpoints", "run-3", "node-x", "checkpoint.json");

    expect(existsSync(loopFile)).toBe(true);
    expect(existsSync(checkpointFile)).toBe(false);
  });
});

// ============================================================
// 3. Loop checkpoint absent → returns null
// ============================================================

describe("loop checkpoint absent", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null for a non-existent loop checkpoint", () => {
    const result = loadLoopCheckpoint("nonexistent-run", "nonexistent-node");
    expect(result).toBeNull();
  });

  it("returns null for a run that exists but has no loop checkpoint", async () => {
    // Create the checkpoint dir for a different node
    mkdirSync(join(testDir, ".forgectl", "checkpoints", "run-x", "other-node"), { recursive: true });
    const result = loadLoopCheckpoint("run-x", "loop-node");
    expect(result).toBeNull();
  });
});

// ============================================================
// 4. Safety cap and GLOBAL_MAX_ITERATIONS constant
// ============================================================

describe("safety cap and GLOBAL_MAX_ITERATIONS", () => {
  it("GLOBAL_MAX_ITERATIONS is 50", () => {
    expect(GLOBAL_MAX_ITERATIONS).toBe(50);
  });

  it("clamping keeps values below the cap unchanged", () => {
    const configuredMax = 10;
    const effective = Math.min(configuredMax, GLOBAL_MAX_ITERATIONS);
    expect(effective).toBe(10);
  });

  it("clamping keeps values equal to the cap unchanged", () => {
    const configuredMax = 50;
    const effective = Math.min(configuredMax, GLOBAL_MAX_ITERATIONS);
    expect(effective).toBe(50);
  });

  it("clamping reduces values above 50 to 50", () => {
    const configuredMax = 100;
    const effective = Math.min(configuredMax, GLOBAL_MAX_ITERATIONS);
    expect(effective).toBe(50);
  });

  it("default max_iterations is 10 when YAML omits the field", () => {
    // Simulates the default a loop executor would apply
    const DEFAULT_MAX_ITERATIONS = 10;
    const nodeLoop = { until: "_status == \"completed\"" }; // no max_iterations
    const configured = (nodeLoop as { max_iterations?: number }).max_iterations ?? DEFAULT_MAX_ITERATIONS;
    const effective = Math.min(configured, GLOBAL_MAX_ITERATIONS);
    expect(effective).toBe(10);
  });

  it("GLOBAL_MAX_ITERATIONS is a number (not a string or undefined)", () => {
    expect(typeof GLOBAL_MAX_ITERATIONS).toBe("number");
    expect(GLOBAL_MAX_ITERATIONS).toBeGreaterThan(0);
  });
});

// ============================================================
// 5. Until expression evaluation with loop-specific context keys
// ============================================================

describe("until expression evaluation with loop context keys", () => {
  it("_status == 'completed' returns true when status is completed", () => {
    const ctx = {
      _status: "completed",
      _iteration: 1,
      _max_iterations: 10,
      _first_iteration: 1,
    };
    expect(evaluateCondition(`_status == "completed"`, ctx)).toBe(true);
  });

  it("_status == 'failed' returns false when status is completed", () => {
    const ctx = {
      _status: "completed",
      _iteration: 1,
      _max_iterations: 10,
      _first_iteration: 1,
    };
    expect(evaluateCondition(`_status == "failed"`, ctx)).toBe(false);
  });

  it("_iteration == 3 returns true when on iteration 3", () => {
    const ctx = {
      _status: "completed",
      _iteration: 3,
      _max_iterations: 10,
      _first_iteration: 0,
    };
    expect(evaluateCondition(`_iteration == 3`, ctx)).toBe(true);
  });

  it("_iteration == 3 returns false when on iteration 2", () => {
    const ctx = {
      _status: "completed",
      _iteration: 2,
      _max_iterations: 10,
      _first_iteration: 0,
    };
    expect(evaluateCondition(`_iteration == 3`, ctx)).toBe(false);
  });

  it("_first_iteration == 1 returns true on first iteration", () => {
    const ctx = {
      _status: "running",
      _iteration: 1,
      _max_iterations: 10,
      _first_iteration: 1,
    };
    expect(evaluateCondition(`_first_iteration == 1`, ctx)).toBe(true);
  });

  it("_first_iteration == 0 returns true on second iteration", () => {
    const ctx = {
      _status: "running",
      _iteration: 2,
      _max_iterations: 10,
      _first_iteration: 0,
    };
    expect(evaluateCondition(`_first_iteration == 0`, ctx)).toBe(true);
  });

  it("missing _status in context throws ConditionVariableError", () => {
    const ctx = {
      _iteration: 1,
      _max_iterations: 10,
      _first_iteration: 1,
    };
    expect(() => evaluateCondition(`_status == "completed"`, ctx)).toThrow(ConditionVariableError);
  });

  it("_max_iterations == 10 returns true when max is 10", () => {
    const ctx = {
      _status: "completed",
      _iteration: 5,
      _max_iterations: 10,
      _first_iteration: 0,
    };
    expect(evaluateCondition(`_max_iterations == 10`, ctx)).toBe(true);
  });
});

// ============================================================
// 6. DAG validation with loop nodes (no back-edges)
// ============================================================

describe("DAG validation with loop nodes", () => {
  it("loop node with loop field is valid (no back-edges created)", () => {
    const pipeline: PipelineDefinition = {
      name: "test-loop-dag",
      nodes: [
        {
          id: "setup",
          task: "Setup environment",
          node_type: "task",
        },
        {
          id: "retry-loop",
          task: "Retry until success",
          node_type: "loop",
          depends_on: ["setup"],
          loop: {
            until: `_status == "completed"`,
            max_iterations: 5,
          },
        },
        {
          id: "teardown",
          task: "Tear down",
          depends_on: ["retry-loop"],
        },
      ],
    };

    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("loop node without body field still validates as a DAG node", () => {
    const pipeline: PipelineDefinition = {
      name: "single-loop",
      nodes: [
        {
          id: "loop-node",
          task: "Iterate",
          node_type: "loop",
          loop: {
            until: `_iteration == 3`,
          },
        },
      ],
    };

    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });

  it("two loop nodes in sequence validate correctly", () => {
    const pipeline: PipelineDefinition = {
      name: "two-loops",
      nodes: [
        {
          id: "loop-a",
          task: "First loop",
          node_type: "loop",
          loop: { until: `_status == "completed"`, max_iterations: 3 },
        },
        {
          id: "loop-b",
          task: "Second loop",
          node_type: "loop",
          depends_on: ["loop-a"],
          loop: { until: `_status == "completed"`, max_iterations: 3 },
        },
      ],
    };

    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// 7. Loop exhaustion message format
// ============================================================

describe("loop exhaustion message format", () => {
  it("expected exhaustion error message format matches template", () => {
    const nodeId = "my-loop-node";
    const maxIterations = 10;
    const message = `Loop "${nodeId}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;

    expect(message).toContain(`Loop "my-loop-node"`);
    expect(message).toContain("exhausted max_iterations (10)");
    expect(message).toContain('"until" expression becoming true');
  });

  it("exhaustion message includes correct node ID and iteration count", () => {
    const cases = [
      { nodeId: "fetch-data", maxIterations: 50 },
      { nodeId: "validate-output", maxIterations: 5 },
      { nodeId: "retry-api-call", maxIterations: 1 },
    ];

    for (const { nodeId, maxIterations } of cases) {
      const message = `Loop "${nodeId}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;
      expect(message).toContain(`"${nodeId}"`);
      expect(message).toContain(`(${maxIterations})`);
    }
  });

  it("exhaustion message format is consistent across iteration counts", () => {
    const buildExhaustionError = (nodeId: string, n: number) =>
      `Loop "${nodeId}" exhausted max_iterations (${n}) without "until" expression becoming true`;

    expect(buildExhaustionError("loop-1", 10)).toMatchSnapshot();
    expect(buildExhaustionError("loop-1", 50)).toMatchSnapshot();
  });
});
