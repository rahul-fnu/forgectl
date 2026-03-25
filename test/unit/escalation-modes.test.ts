import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/validation/step.js", () => ({
  runValidationStep: vi.fn(),
}));
vi.mock("../../src/validation/feedback.js", () => ({
  formatFeedback: vi.fn().mockReturnValue("fix the errors"),
}));
vi.mock("../../src/agent/invoke.js", () => ({
  invokeAgent: vi.fn(),
}));
vi.mock("../../src/container/runner.js", () => ({
  execInContainer: vi.fn(),
}));
vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

const { runValidationLoop } = await import("../../src/validation/runner.js");
const { runValidationStep } = await import("../../src/validation/step.js");
const { invokeAgent } = await import("../../src/agent/invoke.js");
const { execInContainer } = await import("../../src/container/runner.js");
const { formatFeedback } = await import("../../src/validation/feedback.js");
const { emitRunEvent } = await import("../../src/logging/events.js");

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockContainer = {} as any;

function makePlan(opts: {
  retries?: number;
  maxSameFailures?: number;
  onRepeatedFailure?: "abort" | "change_strategy" | "escalate";
} = {}) {
  return {
    runId: "test-run-123",
    input: { mountPath: "/workspace", mode: "repo" as const, sources: [], exclude: [] },
    validation: {
      steps: [{ name: "build", command: "npm run build", retries: opts.retries ?? 5, description: "" }],
      onFailure: "abandon" as const,
      maxSameFailures: opts.maxSameFailures ?? 2,
      onRepeatedFailure: opts.onRepeatedFailure ?? "abort",
      lintSteps: [],
    },
    workflow: { name: "code" },
    agent: { type: "claude-code", maxTurns: 10, timeout: 60000, model: "", flags: [] },
  } as any;
}

describe("escalation modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: agent fix succeeds, git diff returns different files, unique feedback
    vi.mocked(invokeAgent).mockResolvedValue({
      stdout: "fixed", stderr: "", exitCode: 0, durationMs: 100,
    });
    vi.mocked(execInContainer).mockImplementation(async () => ({
      stdout: `file${Math.random()}.ts\n`, stderr: "", exitCode: 0, durationMs: 10,
    }));
    let fbCount = 0;
    vi.mocked(formatFeedback).mockImplementation(() => `feedback ${++fbCount}`);
  });

  describe("abort mode", () => {
    it("stops after N identical failures", async () => {
      // Always return the same error output
      vi.mocked(runValidationStep).mockResolvedValue({
        step: { name: "build", command: "npm run build", retries: 5, description: "" },
        passed: false, exitCode: 1, stdout: "Error: cannot find module 'foo'", stderr: "", durationMs: 100,
      });

      const result = await runValidationLoop(
        mockContainer, makePlan({ maxSameFailures: 2, onRepeatedFailure: "abort" }),
        {} as any, {} as any, [], mockLogger as any,
      );

      expect(result.passed).toBe(false);
      expect(result.repeatedFailure).toBeDefined();
      expect(result.repeatedFailure!.count).toBe(2);
      expect(result.repeatedFailure!.stepName).toBe("build");
      expect(result.totalAttempts).toBe(2);
    });

    it("emits escalation event on abort", async () => {
      vi.mocked(runValidationStep).mockResolvedValue({
        step: { name: "build", command: "npm run build", retries: 5, description: "" },
        passed: false, exitCode: 1, stdout: "same error", stderr: "", durationMs: 100,
      });

      await runValidationLoop(
        mockContainer, makePlan({ maxSameFailures: 2, onRepeatedFailure: "abort" }),
        {} as any, {} as any, [], mockLogger as any,
      );

      expect(emitRunEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: "test-run-123",
        type: "escalation",
        data: expect.objectContaining({ action: "abort" }),
      }));
    });
  });

  describe("change_strategy mode", () => {
    it("injects meta-prompt and resets counter, aborts on second repeat", async () => {
      let callCount = 0;
      vi.mocked(runValidationStep).mockImplementation(async () => ({
        step: { name: "build", command: "npm run build", retries: 10, description: "" },
        passed: false, exitCode: 1, stdout: "same error over and over", stderr: "", durationMs: 100,
      }));

      const result = await runValidationLoop(
        mockContainer,
        makePlan({ retries: 10, maxSameFailures: 2, onRepeatedFailure: "change_strategy" }),
        {} as any, {} as any, [], mockLogger as any,
      );

      expect(result.passed).toBe(false);
      expect(result.repeatedFailure).toBeDefined();

      // Should have invoked agent with strategy change meta-prompt
      const invokeCalls = vi.mocked(invokeAgent).mock.calls;
      const strategyCall = invokeCalls.find(c =>
        typeof c[2] === "string" && c[2].includes("fundamentally different approach")
      );
      expect(strategyCall).toBeDefined();

      // Two escalation events: first change_strategy, then abort
      const escalationCalls = vi.mocked(emitRunEvent).mock.calls.filter(
        c => c[0].type === "escalation"
      );
      expect(escalationCalls.length).toBe(2);
      expect(escalationCalls[0][0].data.action).toBe("change_strategy");
      expect(escalationCalls[1][0].data.action).toBe("abort");
    });
  });

  describe("escalate mode", () => {
    it("aborts and emits escalation event with escalate action", async () => {
      vi.mocked(runValidationStep).mockResolvedValue({
        step: { name: "build", command: "npm run build", retries: 5, description: "" },
        passed: false, exitCode: 1, stdout: "persistent error", stderr: "", durationMs: 100,
      });

      const result = await runValidationLoop(
        mockContainer, makePlan({ maxSameFailures: 2, onRepeatedFailure: "escalate" }),
        {} as any, {} as any, [], mockLogger as any,
      );

      expect(result.passed).toBe(false);
      expect(result.repeatedFailure).toBeDefined();

      expect(emitRunEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "escalation",
        data: expect.objectContaining({
          action: "escalate",
          count: 2,
          stepName: "build",
        }),
      }));
    });
  });

  describe("different signatures don't trigger escalation", () => {
    it("does not escalate when failures have different outputs", async () => {
      let callCount = 0;
      vi.mocked(runValidationStep).mockImplementation(async () => ({
        step: { name: "build", command: "npm run build", retries: 5, description: "" },
        passed: false, exitCode: 1, stdout: `Error in file${++callCount}.ts`, stderr: "", durationMs: 100,
      }));

      const result = await runValidationLoop(
        mockContainer, makePlan({ retries: 4, maxSameFailures: 2, onRepeatedFailure: "abort" }),
        {} as any, {} as any, [], mockLogger as any,
      );

      expect(result.repeatedFailure).toBeUndefined();
      // Should have exhausted retries rather than escalating
      expect(result.totalAttempts).toBe(5);
    });
  });
});
