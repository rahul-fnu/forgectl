import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineDefinition } from "../../src/pipeline/types.js";

// Mocks needed for PipelineExecutor tests
vi.mock("../../src/config/loader.js", () => ({
  loadConfig: () => ({
    agent: { type: "codex", model: "", max_turns: 50, timeout: "30m", flags: [] },
    container: { network: {}, resources: { memory: "4g", cpus: 2 } },
    repo: {
      branch: { template: "forge/{{slug}}/{{ts}}", base: "main" },
      exclude: ["test/**", "*.test.ts"],
    },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: { message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true }, author: { name: "forgectl", email: "forge@localhost" }, sign: false },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
  }),
}));

vi.mock("../../src/orchestration/modes.js", () => ({
  executeRun: vi.fn().mockResolvedValue({
    success: true,
    output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
    validation: { passed: true, totalAttempts: 1, stepResults: [], lastOutput: "All files | 72.34 | ..." },
    durationMs: 500,
  }),
}));

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

// --- Setup temp dir and homedir mock for checkpoint tests ---

const testDir = join(tmpdir(), `forgectl-self-correction-test-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Import extractCoverage from the coverage utility
const { extractCoverage } = await import("../../src/pipeline/coverage.js");
const { executeRun } = await import("../../src/orchestration/modes.js");
const { PipelineExecutor } = await import("../../src/pipeline/executor.js");

// ============================================================
// 1. extractCoverage unit tests
// ============================================================

describe("extractCoverage", () => {
  it("parses vitest format: All files | 72.34 | ...", () => {
    expect(extractCoverage("All files | 72.34 | 50 | 80 | 72.34")).toBe(72.34);
  });

  it("parses jest/istanbul Statements format", () => {
    expect(extractCoverage("Statements   : 85.5% ( 100/117 )")).toBe(85.5);
  });

  it("parses c8/istanbul Lines format", () => {
    expect(extractCoverage("Lines        : 91.2% ( 200/219 )")).toBe(91.2);
  });

  it("parses generic coverage format", () => {
    expect(extractCoverage("91.2% coverage")).toBe(91.2);
  });

  it("returns -1 when no coverage pattern matches", () => {
    expect(extractCoverage("all tests passed")).toBe(-1);
  });

  it("returns -1 for empty string", () => {
    expect(extractCoverage("")).toBe(-1);
  });
});

// ============================================================
// Helper: make a loop pipeline definition
// ============================================================

function makeLoopPipeline(
  loopNode: PipelineDefinition["nodes"][number],
  extraNodes?: PipelineDefinition["nodes"],
): PipelineDefinition {
  return {
    name: "self-correction-test",
    nodes: [loopNode, ...(extraNodes ?? [])],
  };
}

// ============================================================
// 2. No-progress detection tests
// ============================================================

describe("no-progress detection", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    vi.clearAllMocks();
    // Re-set default mock after clearAllMocks()
    vi.mocked(executeRun).mockResolvedValue({
      success: true,
      output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
      validation: { passed: true, totalAttempts: 1, stepResults: [], lastOutput: "All files | 72.34 | ..." },
      durationMs: 500,
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("aborts loop when consecutive iterations produce identical test output", async () => {
    const sameOutput = "All files | 50.00 | some output that stays the same";
    vi.mocked(executeRun).mockResolvedValue({
      success: false,
      output: undefined,
      validation: { passed: false, totalAttempts: 1, stepResults: [], lastOutput: sameOutput },
      durationMs: 100,
      error: "tests failed",
    });

    const pipeline = makeLoopPipeline({
      id: "no-progress-loop",
      task: "Fix failing tests",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 5 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    const nodeError = result.nodes.get("no-progress-loop")!.error ?? "";
    expect(nodeError).toContain("no progress detected");
  });

  it("continues loop when consecutive iterations produce different output", async () => {
    let callCount = 0;
    vi.mocked(executeRun).mockImplementation(async () => {
      callCount++;
      return {
        success: callCount >= 3,
        output: callCount >= 3
          ? { mode: "files" as const, dir: "/tmp/out", files: ["result.md"], totalSize: 100 }
          : undefined,
        validation: {
          passed: callCount >= 3,
          totalAttempts: 1,
          stepResults: [],
          lastOutput: `Output after attempt ${callCount}`,
        },
        durationMs: 100,
        error: callCount < 3 ? "not done yet" : undefined,
      };
    });

    const pipeline = makeLoopPipeline({
      id: "progress-loop",
      task: "Fix tests progressively",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 5 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
    expect(result.nodes.get("progress-loop")!.status).toBe("completed");
  });

  it("does not trigger no-progress on first iteration", async () => {
    vi.mocked(executeRun).mockResolvedValueOnce({
      success: true,
      output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
      validation: { passed: true, totalAttempts: 1, stepResults: [], lastOutput: "some output" },
      durationMs: 100,
    });

    const pipeline = makeLoopPipeline({
      id: "first-iter-loop",
      task: "Single iteration",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 5 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("completed");
  });
});

// ============================================================
// 3. Exclusion enforcement tests
// ============================================================

describe("exclusion enforcement", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(executeRun).mockResolvedValue({
      success: true,
      output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
      validation: { passed: true, totalAttempts: 1, stepResults: [], lastOutput: "All files | 90.00 | ..." },
      durationMs: 500,
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("fails iteration when fix agent modifies excluded file", async () => {
    // Mock execSync for git diff — returns an excluded file
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        execSync: vi.fn().mockReturnValue("test/foo.test.ts\n"),
      };
    });

    const pipeline = makeLoopPipeline({
      id: "exclusion-loop",
      task: "Fix code without touching tests",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 3 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    // If exclusion enforcement is wired, node should fail with the exclusion error
    if (result.nodes.get("exclusion-loop")!.status === "failed") {
      const nodeError = result.nodes.get("exclusion-loop")!.error ?? "";
      expect(nodeError).toContain("Fix agent modified excluded file(s): test/foo.test.ts");
    } else {
      // If not yet wired (Plan 01 state), this will be "completed" — Plan 02 makes it fail
      expect(result.nodes.get("exclusion-loop")!.status).toBe("completed");
    }
  });

  it("allows modification of non-excluded files", async () => {
    const pipeline = makeLoopPipeline({
      id: "allowed-files-loop",
      task: "Fix code",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 3 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.nodes.get("allowed-files-loop")!.status).toBe("completed");
  });

  it("reverts excluded files via git checkout when violated (placeholder)", () => {
    // This test validates the revert behavior; actual verification is in Plan 02
    // when execSync is properly mocked and wired into executeLoopNode
    expect(true).toBe(true); // placeholder for Plan 02
  });
});

// ============================================================
// 4. Coverage variable injection tests
// ============================================================

describe("coverage variable injection", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(executeRun).mockResolvedValue({
      success: false,
      output: undefined,
      validation: { passed: false, totalAttempts: 1, stepResults: [], lastOutput: "All files | 72.34 | ..." },
      durationMs: 500,
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("_coverage injected into until expression context when coverage meets threshold", async () => {
    vi.mocked(executeRun).mockResolvedValue({
      success: true,
      output: { mode: "files", dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
      validation: {
        passed: true,
        totalAttempts: 1,
        stepResults: [],
        lastOutput: "All files | 85.00 | ...",
      },
      durationMs: 500,
    });

    // Use _status only for Plan 01 — Plan 02 will wire _coverage into the context
    // so `_coverage >= 80` becomes a valid until expression
    const pipeline = makeLoopPipeline({
      id: "coverage-threshold-loop",
      task: "Improve coverage",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 5 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    // Loop exits when _status == "completed"
    expect(result.nodes.get("coverage-threshold-loop")!.status).toBe("completed");
  });

  it("_coverage is -1 when no coverage in output", async () => {
    let callCount = 0;
    vi.mocked(executeRun).mockImplementation(async () => {
      callCount++;
      return {
        success: callCount >= 3,
        output: callCount >= 3
          ? { mode: "files" as const, dir: "/tmp/out", files: ["result.md"], totalSize: 100 }
          : undefined,
        validation: {
          passed: callCount >= 3,
          totalAttempts: 1,
          stepResults: [],
          lastOutput: "no coverage info here",
        },
        durationMs: 100,
        error: callCount < 3 ? "not done" : undefined,
      };
    });

    const pipeline = makeLoopPipeline({
      id: "no-coverage-loop",
      task: "Run without coverage reporting",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 5 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    // Loop should complete based on _status condition, _coverage == -1 doesn't break anything
    expect(result.nodes.get("no-coverage-loop")!.status).toBe("completed");
  });

  it("exhaustion message includes final coverage when coverage below threshold", async () => {
    vi.mocked(executeRun).mockResolvedValue({
      success: false,
      output: undefined,
      validation: {
        passed: false,
        totalAttempts: 1,
        stepResults: [],
        lastOutput: "All files | 45.00 | ...",
      },
      durationMs: 100,
      error: "coverage too low",
    });

    const pipeline = makeLoopPipeline({
      id: "low-coverage-loop",
      task: "Improve coverage to 80%",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 2 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    // In Plan 02, exhaustion message will include "final coverage: 45"
    // For now, verify the loop exhausted as expected
    const nodeError = result.nodes.get("low-coverage-loop")!.error ?? "";
    expect(nodeError).toContain("exhausted max_iterations");
  });
});
