import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
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
const { checkExclusionViolations } = await import("../../src/pipeline/exclusion.js");

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
// 3. Exclusion enforcement tests (checkExclusionViolations unit tests)
// ============================================================

describe("exclusion enforcement (checkExclusionViolations)", () => {
  let repoDir: string;

  beforeEach(() => {
    // Create a temp git repo with an initial commit containing test files
    repoDir = mkdtempSync(join(tmpdir(), "exclusion-test-"));
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });

    // Create directory structure and files
    mkdirSync(join(repoDir, "test"), { recursive: true });
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "test", "foo.test.ts"), "original test content");
    writeFileSync(join(repoDir, "src", "main.ts"), "original src content");

    // Commit
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("detects and reverts excluded file modifications", () => {
    // Simulate fix agent modifying a test file
    writeFileSync(join(repoDir, "test", "foo.test.ts"), "agent changed the test!");

    const result = checkExclusionViolations(repoDir, ["test/**", "*.test.ts"]);

    expect(result.violations).toContain("test/foo.test.ts");
    // Verify the file was reverted
    const content = readFileSync(join(repoDir, "test", "foo.test.ts"), "utf-8");
    expect(content).toBe("original test content");
  });

  it("allows modification of non-excluded files", () => {
    writeFileSync(join(repoDir, "src", "main.ts"), "agent fixed the source code");

    const result = checkExclusionViolations(repoDir, ["test/**", "*.test.ts"]);

    expect(result.violations).toEqual([]);
    // Verify the source file change was preserved
    const content = readFileSync(join(repoDir, "src", "main.ts"), "utf-8");
    expect(content).toBe("agent fixed the source code");
  });

  it("reverts only excluded files when both excluded and non-excluded are modified", () => {
    writeFileSync(join(repoDir, "test", "foo.test.ts"), "agent changed the test!");
    writeFileSync(join(repoDir, "src", "main.ts"), "agent fixed the source code");

    const result = checkExclusionViolations(repoDir, ["test/**"]);

    expect(result.violations).toContain("test/foo.test.ts");
    // Test file reverted
    expect(readFileSync(join(repoDir, "test", "foo.test.ts"), "utf-8")).toBe("original test content");
    // Source file preserved
    expect(readFileSync(join(repoDir, "src", "main.ts"), "utf-8")).toBe("agent fixed the source code");
  });

  it("returns empty violations when no files changed", () => {
    const result = checkExclusionViolations(repoDir, ["test/**"]);
    expect(result.violations).toEqual([]);
  });

  it("returns empty violations when excludePatterns is empty", () => {
    writeFileSync(join(repoDir, "test", "foo.test.ts"), "changed");
    const result = checkExclusionViolations(repoDir, []);
    expect(result.violations).toEqual([]);
  });
});

// ============================================================
// 4. Exclusion enforcement integration tests (PipelineExecutor)
// ============================================================

describe("exclusion enforcement (PipelineExecutor integration)", () => {
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
    // Create temp git repo for this test
    const exclusionRepoDir = mkdtempSync(join(tmpdir(), "exclusion-exec-test-"));
    execSync("git init", { cwd: exclusionRepoDir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: exclusionRepoDir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: exclusionRepoDir, stdio: "pipe" });
    mkdirSync(join(exclusionRepoDir, "test"), { recursive: true });
    writeFileSync(join(exclusionRepoDir, "test", "foo.test.ts"), "original");
    execSync("git add -A && git commit -m init", { cwd: exclusionRepoDir, stdio: "pipe" });

    // Mock executeRun to simulate agent modifying an excluded file
    vi.mocked(executeRun).mockImplementation(async () => {
      writeFileSync(join(exclusionRepoDir, "test", "foo.test.ts"), "agent modified test!");
      return {
        success: true,
        output: { mode: "files" as const, dir: "/tmp/out", files: ["result.md"], totalSize: 100 },
        validation: { passed: true, totalAttempts: 1, stepResults: [], lastOutput: "tests pass" },
        durationMs: 100,
      };
    });

    const pipeline = makeLoopPipeline({
      id: "exclusion-loop",
      task: "Fix code without touching tests",
      node_type: "loop",
      repo: exclusionRepoDir,
      loop: { until: '_status == "completed"', max_iterations: 3 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    // Strict assertion: must fail with specific exclusion error
    expect(result.nodes.get("exclusion-loop")!.status).toBe("failed");
    const nodeError = result.nodes.get("exclusion-loop")!.error ?? "";
    expect(nodeError).toContain("Fix agent modified excluded file(s)");
    expect(nodeError).toContain("test/foo.test.ts");

    rmSync(exclusionRepoDir, { recursive: true, force: true });
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
});

// ============================================================
// 5. Coverage variable injection tests
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
          // Use unique output per call so no-progress detection does not fire
          lastOutput: `no coverage info here — attempt ${callCount}`,
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

    // Use max_iterations=1 so only one iteration runs (no consecutive pair for no-progress check)
    // and the loop exhausts, exercising the coverage-aware exhaustion message path.
    const pipeline = makeLoopPipeline({
      id: "low-coverage-loop",
      task: "Improve coverage to 80%",
      node_type: "loop",
      loop: { until: `_status == "completed"`, max_iterations: 1 },
    });

    const executor = new PipelineExecutor(pipeline);
    const result = await executor.execute();

    expect(result.status).toBe("failed");
    const nodeError = result.nodes.get("low-coverage-loop")!.error ?? "";
    // Plan 02: exhaustion message includes coverage percentage
    expect(nodeError).toContain("exhausted max_iterations");
    expect(nodeError).toContain("final coverage: 45.0%");
  });
});
