import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the step runner
vi.mock("../../src/validation/step.js", () => ({
  runValidationStep: vi.fn(),
}));

// Mock feedback and invoke (not used by gate but imported by runner.ts)
vi.mock("../../src/validation/feedback.js", () => ({
  formatFeedback: vi.fn(),
}));
vi.mock("../../src/agent/invoke.js", () => ({
  invokeAgent: vi.fn(),
}));
vi.mock("../../src/container/runner.js", () => ({
  execInContainer: vi.fn(),
}));

const { runValidationGate } = await import("../../src/validation/runner.js");
const { runValidationStep } = await import("../../src/validation/step.js");
const { invokeAgent } = await import("../../src/agent/invoke.js");

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockContainer = {} as any;

describe("runValidationGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Pass scenarios ---

  it("returns passed when single step passes", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: true,
      exitCode: 0,
      stdout: "Build succeeded",
      stderr: "",
      durationMs: 100,
    });

    const result = await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(result.passed).toBe(true);
    expect(result.totalAttempts).toBe(1);
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].name).toBe("build");
    expect(result.stepResults[0].passed).toBe(true);
    expect(result.stepResults[0].attempts).toBe(1);
  });

  it("returns passed when all multiple steps pass", async () => {
    vi.mocked(runValidationStep)
      .mockResolvedValueOnce({
        step: { name: "build", command: "npm run build", retries: 0, description: "" },
        passed: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 100,
      })
      .mockResolvedValueOnce({
        step: { name: "test", command: "npm test", retries: 0, description: "" },
        passed: true, exitCode: 0, stdout: "all passed", stderr: "", durationMs: 200,
      })
      .mockResolvedValueOnce({
        step: { name: "lint", command: "npm run lint", retries: 0, description: "" },
        passed: true, exitCode: 0, stdout: "clean", stderr: "", durationMs: 50,
      });

    const result = await runValidationGate(
      mockContainer,
      [
        { name: "build", command: "npm run build", retries: 0, description: "" },
        { name: "test", command: "npm test", retries: 0, description: "" },
        { name: "lint", command: "npm run lint", retries: 0, description: "" },
      ],
      "/workspace",
      mockLogger as any,
    );

    expect(result.passed).toBe(true);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults.every((s) => s.passed)).toBe(true);
  });

  it("returns passed with empty steps (no-op)", async () => {
    const result = await runValidationGate(
      mockContainer,
      [],
      "/workspace",
      mockLogger as any,
    );

    expect(result.passed).toBe(true);
    expect(result.totalAttempts).toBe(0);
    expect(result.stepResults).toEqual([]);
    expect(result.lastOutput).toBeUndefined();
  });

  // --- Failure scenarios ---

  it("returns failed when single step fails", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: false,
      exitCode: 1,
      stdout: "compilation error",
      stderr: "Error in main.ts",
      durationMs: 100,
    });

    const result = await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(result.passed).toBe(false);
    expect(result.stepResults[0].passed).toBe(false);
  });

  it("returns failed when any one of multiple steps fails", async () => {
    vi.mocked(runValidationStep)
      .mockResolvedValueOnce({
        step: { name: "build", command: "npm run build", retries: 0, description: "" },
        passed: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 100,
      })
      .mockResolvedValueOnce({
        step: { name: "test", command: "npm test", retries: 0, description: "" },
        passed: false, exitCode: 1, stdout: "1 test failed", stderr: "", durationMs: 200,
      });

    const result = await runValidationGate(
      mockContainer,
      [
        { name: "build", command: "npm run build", retries: 0, description: "" },
        { name: "test", command: "npm test", retries: 0, description: "" },
      ],
      "/workspace",
      mockLogger as any,
    );

    expect(result.passed).toBe(false);
    expect(result.stepResults[0].passed).toBe(true);
    expect(result.stepResults[1].passed).toBe(false);
  });

  it("still runs ALL steps even if first step fails", async () => {
    vi.mocked(runValidationStep)
      .mockResolvedValueOnce({
        step: { name: "build", command: "npm run build", retries: 0, description: "" },
        passed: false, exitCode: 1, stdout: "fail", stderr: "", durationMs: 100,
      })
      .mockResolvedValueOnce({
        step: { name: "test", command: "npm test", retries: 0, description: "" },
        passed: true, exitCode: 0, stdout: "pass", stderr: "", durationMs: 100,
      });

    const result = await runValidationGate(
      mockContainer,
      [
        { name: "build", command: "npm run build", retries: 0, description: "" },
        { name: "test", command: "npm test", retries: 0, description: "" },
      ],
      "/workspace",
      mockLogger as any,
    );

    // Both steps were run
    expect(runValidationStep).toHaveBeenCalledTimes(2);
    expect(result.stepResults[0].passed).toBe(false);
    expect(result.stepResults[1].passed).toBe(true);
    // Overall fails
    expect(result.passed).toBe(false);
  });

  // --- No retries / no agent invocation ---

  it("does NOT invoke agent on failure", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: false, exitCode: 1, stdout: "error", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(runValidationStep).toHaveBeenCalledTimes(1);
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it("runs each step exactly once (no retries regardless of step.retries value)", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 5, description: "" },
      passed: false, exitCode: 1, stdout: "error", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 5, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    // Even though retries=5 on the step, gate only runs once
    expect(runValidationStep).toHaveBeenCalledTimes(1);
  });

  // --- Output capture ---

  it("captures lastOutput from stdout", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: true, exitCode: 0, stdout: "Build succeeded in 2.3s", stderr: "", durationMs: 100,
    });

    const result = await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(result.lastOutput).toContain("Build succeeded in 2.3s");
  });

  it("captures lastOutput from stderr", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: false, exitCode: 1, stdout: "", stderr: "fatal: compilation error", durationMs: 100,
    });

    const result = await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(result.lastOutput).toContain("fatal: compilation error");
  });

  it("combines stdout and stderr in lastOutput", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "test", command: "npm test", retries: 0, description: "" },
      passed: false, exitCode: 1, stdout: "Tests: 1 passed", stderr: "Warning: deprecation", durationMs: 100,
    });

    const result = await runValidationGate(
      mockContainer,
      [{ name: "test", command: "npm test", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(result.lastOutput).toContain("Tests: 1 passed");
    expect(result.lastOutput).toContain("Warning: deprecation");
  });

  it("returns undefined lastOutput when no steps configured", async () => {
    const result = await runValidationGate(mockContainer, [], "/workspace", mockLogger as any);
    expect(result.lastOutput).toBeUndefined();
  });

  // --- Logger calls ---

  it("logs info message on gate start", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: true, exitCode: 0, stdout: "", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      "validation",
      expect.stringContaining("build gate"),
    );
  });

  it("logs info for passing step", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: true, exitCode: 0, stdout: "", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      "validation",
      expect.stringContaining("build"),
    );
  });

  it("logs error for failing step", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "test", command: "npm test", retries: 0, description: "" },
      passed: false, exitCode: 1, stdout: "", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "test", command: "npm test", retries: 0, description: "" }],
      "/workspace",
      mockLogger as any,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      "validation",
      expect.stringContaining("test"),
    );
  });

  // --- workingDir argument ---

  it("passes workingDir to runValidationStep", async () => {
    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "build", command: "npm run build", retries: 0, description: "" },
      passed: true, exitCode: 0, stdout: "", stderr: "", durationMs: 100,
    });

    await runValidationGate(
      mockContainer,
      [{ name: "build", command: "npm run build", retries: 0, description: "" }],
      "/custom/workspace",
      mockLogger as any,
    );

    expect(runValidationStep).toHaveBeenCalledWith(
      mockContainer,
      expect.objectContaining({ name: "build" }),
      "/custom/workspace",
    );
  });
});
