import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLoopDetectorState,
  recordFileWrite,
  recordValidationError,
  recordToolCall,
} from "../../src/agent/loop-detector.js";

// Mocks for validation loop integration tests
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

describe("agent/loop-detector", () => {
  describe("recordFileWrite", () => {
    it("does not trigger below threshold", () => {
      const state = createLoopDetectorState();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
    });

    it("triggers on 4+ writes to 1 file", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/index.ts");
      recordFileWrite(state, "src/index.ts");
      recordFileWrite(state, "src/index.ts");
      const result = recordFileWrite(state, "src/index.ts");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_file_writes");
      expect(result!.detail).toContain("4 writes");
      expect(result!.detail).toContain("1 file(s)");
    });

    it("triggers on 4+ writes to 2 files", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/a.ts");
      recordFileWrite(state, "src/b.ts");
      recordFileWrite(state, "src/a.ts");
      const result = recordFileWrite(state, "src/b.ts");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_file_writes");
      expect(result!.detail).toContain("2 file(s)");
    });

    it("does not trigger when writes spread across 3+ files", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/a.ts");
      recordFileWrite(state, "src/b.ts");
      recordFileWrite(state, "src/c.ts");
      const result = recordFileWrite(state, "src/a.ts");
      expect(result).toBeNull();
    });
  });

  describe("recordValidationError", () => {
    it("does not trigger below 3 repetitions", () => {
      const state = createLoopDetectorState();
      expect(recordValidationError(state, "Error: cannot find module")).toBeNull();
      expect(recordValidationError(state, "Error: cannot find module")).toBeNull();
    });

    it("triggers on 3 consecutive identical errors", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: cannot find module");
      recordValidationError(state, "Error: cannot find module");
      const result = recordValidationError(state, "Error: cannot find module");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_validation_error");
      expect(result!.detail).toContain("3 times");
    });

    it("does not trigger when errors differ", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: cannot find module A");
      recordValidationError(state, "Error: cannot find module B");
      const result = recordValidationError(state, "Error: cannot find module C");
      expect(result).toBeNull();
    });

    it("resets count when a different error interrupts", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: X");
      recordValidationError(state, "Error: X");
      recordValidationError(state, "Error: Y"); // interrupts
      const result = recordValidationError(state, "Error: X");
      expect(result).toBeNull(); // only 1 consecutive now
    });

    it("normalizes timestamps in error output", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "2026-03-22T10:00:00.123 Error: fail");
      recordValidationError(state, "2026-03-22T10:01:00.456 Error: fail");
      const result = recordValidationError(state, "2026-03-22T10:02:00.789 Error: fail");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_validation_error");
    });

    it("triggers within 1 turn of meeting threshold", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: same thing");
      recordValidationError(state, "Error: same thing");
      // Third call should trigger immediately
      const result = recordValidationError(state, "Error: same thing");
      expect(result).not.toBeNull();
    });
  });

  describe("recordToolCall", () => {
    it("does not trigger below 3 repetitions", () => {
      const state = createLoopDetectorState();
      expect(recordToolCall(state, "writeFile", '{"path":"a.ts"}')).toBeNull();
      expect(recordToolCall(state, "writeFile", '{"path":"a.ts"}')).toBeNull();
    });

    it("triggers on 3 consecutive identical tool calls", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      const result = recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_tool_call");
      expect(result!.detail).toContain("writeFile");
      expect(result!.detail).toContain("3 times");
    });

    it("does not trigger when params differ", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "writeFile", '{"path":"a.ts"}');
      recordToolCall(state, "writeFile", '{"path":"b.ts"}');
      const result = recordToolCall(state, "writeFile", '{"path":"c.ts"}');
      expect(result).toBeNull();
    });

    it("does not trigger when tool names differ", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "readFile", '{"path":"a.ts"}');
      recordToolCall(state, "writeFile", '{"path":"a.ts"}');
      const result = recordToolCall(state, "readFile", '{"path":"a.ts"}');
      expect(result).toBeNull(); // only 1 consecutive
    });
  });

  describe("loop detection triggers within 1 turn of threshold", () => {
    it("file write detection triggers on the exact 4th write", () => {
      const state = createLoopDetectorState();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      // 4th write triggers immediately
      expect(recordFileWrite(state, "f.ts")).not.toBeNull();
    });

    it("validation error detection triggers on the exact 3rd identical error", () => {
      const state = createLoopDetectorState();
      expect(recordValidationError(state, "err")).toBeNull();
      expect(recordValidationError(state, "err")).toBeNull();
      expect(recordValidationError(state, "err")).not.toBeNull();
    });

    it("tool call detection triggers on the exact 3rd identical call", () => {
      const state = createLoopDetectorState();
      expect(recordToolCall(state, "t", "p")).toBeNull();
      expect(recordToolCall(state, "t", "p")).toBeNull();
      expect(recordToolCall(state, "t", "p")).not.toBeNull();
    });
  });
});

// ─── Validation loop integration tests ───

describe("validation loop — loop detection integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mockContainer = {} as any;

  function makePlan(retries = 5) {
    return {
      input: { mountPath: "/workspace", mode: "repo" as const, sources: [], exclude: [] },
      validation: {
        steps: [{ name: "lint", command: "npm run lint", retries, description: "" }],
        onFailure: "abandon" as const,
      },
      workflow: { name: "code" },
      agent: { type: "claude-code", maxTurns: 10, timeout: 60000, model: "", flags: [] },
    } as any;
  }

  it("detects file write loop via git diff during validation retries", async () => {
    const { runValidationLoop } = await import("../../src/validation/runner.js");
    const { runValidationStep } = await import("../../src/validation/step.js");
    const { invokeAgent } = await import("../../src/agent/invoke.js");
    const { execInContainer } = await import("../../src/container/runner.js");

    // Validation always fails with a unique error each time (avoids validation error loop)
    let errCount = 0;
    vi.mocked(runValidationStep).mockImplementation(async () => ({
      step: { name: "lint", command: "npm run lint", retries: 5, description: "" },
      passed: false, exitCode: 1, stdout: `error ${++errCount}`, stderr: "", durationMs: 100,
    }));
    // Agent fix always "succeeds"
    vi.mocked(invokeAgent).mockResolvedValue({
      stdout: "fixed", stderr: "", exitCode: 0, durationMs: 100,
    });
    // git diff always returns the same single file
    vi.mocked(execInContainer).mockResolvedValue({
      stdout: "src/index.ts\n", stderr: "", exitCode: 0, durationMs: 10,
    });
    // Unique feedback each time (avoids tool call loop)
    const { formatFeedback } = await import("../../src/validation/feedback.js");
    let fbCount = 0;
    vi.mocked(formatFeedback).mockImplementation(() => `feedback ${++fbCount}`);

    const result = await runValidationLoop(
      mockContainer, makePlan(), {} as any, {} as any, [], mockLogger as any,
    );

    expect(result.passed).toBe(false);
    expect(result.loopDetected).toBeDefined();
    expect(result.loopDetected!.type).toBe("repeated_file_writes");
    expect(result.loopDetected!.detail).toContain("src/index.ts");
  });

  it("detects tool call loop when same feedback is sent 3 times", async () => {
    const { runValidationLoop } = await import("../../src/validation/runner.js");
    const { runValidationStep } = await import("../../src/validation/step.js");
    const { invokeAgent } = await import("../../src/agent/invoke.js");
    const { execInContainer } = await import("../../src/container/runner.js");
    const { formatFeedback } = await import("../../src/validation/feedback.js");

    // Always the same failure with a unique error each time (so validation error loop doesn't fire)
    let callCount = 0;
    vi.mocked(runValidationStep).mockImplementation(async () => ({
      step: { name: "lint", command: "npm run lint", retries: 5, description: "" },
      passed: false, exitCode: 1, stdout: `error ${++callCount}`, stderr: "", durationMs: 100,
    }));
    vi.mocked(invokeAgent).mockResolvedValue({
      stdout: "fixed", stderr: "", exitCode: 0, durationMs: 100,
    });
    // git diff returns different files each time (no file write loop)
    let diffCount = 0;
    vi.mocked(execInContainer).mockImplementation(async () => ({
      stdout: `file${++diffCount}.ts\n`, stderr: "", exitCode: 0, durationMs: 10,
    }));
    // Same feedback each time triggers tool call loop
    vi.mocked(formatFeedback).mockReturnValue("same feedback every time");

    const result = await runValidationLoop(
      mockContainer, makePlan(), {} as any, {} as any, [], mockLogger as any,
    );

    expect(result.passed).toBe(false);
    expect(result.loopDetected).toBeDefined();
    expect(result.loopDetected!.type).toBe("repeated_tool_call");
    expect(result.loopDetected!.detail).toContain("agent-fix");
  });

  it("halts immediately on the turn loop is detected", async () => {
    const { runValidationLoop } = await import("../../src/validation/runner.js");
    const { runValidationStep } = await import("../../src/validation/step.js");
    const { invokeAgent } = await import("../../src/agent/invoke.js");
    const { execInContainer } = await import("../../src/container/runner.js");

    vi.mocked(runValidationStep).mockResolvedValue({
      step: { name: "lint", command: "npm run lint", retries: 10, description: "" },
      passed: false, exitCode: 1, stdout: "same error", stderr: "", durationMs: 100,
    });
    vi.mocked(invokeAgent).mockResolvedValue({
      stdout: "fixed", stderr: "", exitCode: 0, durationMs: 100,
    });
    // git diff returns same file each time — triggers on 4th iteration
    vi.mocked(execInContainer).mockResolvedValue({
      stdout: "src/main.ts\n", stderr: "", exitCode: 0, durationMs: 10,
    });

    const result = await runValidationLoop(
      mockContainer, makePlan(10), {} as any, {} as any, [], mockLogger as any,
    );

    // Should halt well before 10 retries
    // File write loop triggers at 4th write (after 4 fix cycles)
    // But validation error loop may trigger first (3 identical errors)
    expect(result.loopDetected).toBeDefined();
    expect(result.totalAttempts).toBeLessThanOrEqual(5);
  });
});
