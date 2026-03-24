import { describe, it, expect } from "vitest";
import { formatFeedback } from "../../src/validation/feedback.js";
import type { StepResult } from "../../src/validation/step.js";
import type { ValidationStep } from "../../src/config/schema.js";

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    step: { name: "lint", command: "npm run lint", retries: 3, description: "Lint check" },
    passed: false,
    exitCode: 1,
    stdout: "error: missing semicolon",
    stderr: "",
    durationMs: 1234,
    ...overrides,
  };
}

describe("step pass/fail inversion", () => {
  function computePassed(step: ValidationStep, exitCode: number): boolean {
    return step.expect_failure === true ? exitCode !== 0 : exitCode === 0;
  }

  it("normal step passes when exitCode is 0", () => {
    expect(computePassed({ name: "t", command: "t", retries: 0, description: "" }, 0)).toBe(true);
  });

  it("normal step fails when exitCode is non-zero", () => {
    expect(computePassed({ name: "t", command: "t", retries: 0, description: "" }, 1)).toBe(false);
  });

  it("expect_failure step passes when exitCode is non-zero", () => {
    expect(computePassed({ name: "t", command: "t", retries: 0, description: "", expect_failure: true, before_fix: true }, 1)).toBe(true);
  });

  it("expect_failure step fails when exitCode is 0", () => {
    expect(computePassed({ name: "t", command: "t", retries: 0, description: "", expect_failure: true, before_fix: true }, 0)).toBe(false);
  });
});

describe("formatFeedback", () => {
  it("includes VALIDATION FAILED header", () => {
    const result = formatFeedback([makeStepResult()], "code");
    expect(result).toContain("VALIDATION FAILED");
  });

  it("includes step name and exit code", () => {
    const result = formatFeedback([makeStepResult({ exitCode: 2 })], "code");
    expect(result).toContain("lint");
    expect(result).toContain("exit code 2");
  });

  it("includes step command", () => {
    const result = formatFeedback([makeStepResult()], "code");
    expect(result).toContain("npm run lint");
  });

  it("includes stdout when present", () => {
    const result = formatFeedback([makeStepResult()], "code");
    expect(result).toContain("error: missing semicolon");
    expect(result).toContain("STDOUT");
  });

  it("includes stderr when present", () => {
    const result = formatFeedback([makeStepResult({ stderr: "fatal error", stdout: "" })], "code");
    expect(result).toContain("fatal error");
    expect(result).toContain("STDERR");
  });

  it("omits stdout section when empty", () => {
    const result = formatFeedback([makeStepResult({ stdout: "", stderr: "err" })], "code");
    expect(result).not.toContain("STDOUT");
  });

  it("uses workflow-specific instruction for code", () => {
    const result = formatFeedback([makeStepResult()], "code");
    expect(result).toContain("Fix the code issues");
    expect(result).toContain("Do NOT weaken linting rules");
  });

  it("uses workflow-specific instruction for research", () => {
    const result = formatFeedback([makeStepResult()], "research");
    expect(result).toContain("Fix the report");
    expect(result).toContain("sources are cited");
  });

  it("uses workflow-specific instruction for content", () => {
    const result = formatFeedback([makeStepResult()], "content");
    expect(result).toContain("Revise the content");
  });

  it("uses workflow-specific instruction for data", () => {
    const result = formatFeedback([makeStepResult()], "data");
    expect(result).toContain("Fix the data pipeline");
  });

  it("uses workflow-specific instruction for ops", () => {
    const result = formatFeedback([makeStepResult()], "ops");
    expect(result).toContain("Fix the infrastructure code");
  });

  it("falls back to general instruction for unknown workflow", () => {
    const result = formatFeedback([makeStepResult()], "unknown-workflow");
    expect(result).toContain("Fix the issues identified above");
  });

  it("includes fix instructions", () => {
    const result = formatFeedback([makeStepResult()], "code");
    expect(result).toContain("Fix the issues and the checks will run again");
  });

  it("handles multiple failed steps", () => {
    const steps = [
      makeStepResult({ step: { name: "lint", command: "npm run lint", retries: 3, description: "" } }),
      makeStepResult({ step: { name: "test", command: "npm test", retries: 3, description: "" }, stdout: "1 test failed" }),
    ];
    const result = formatFeedback(steps, "code");
    expect(result).toContain("lint");
    expect(result).toContain("test");
    expect(result).toContain("1 test failed");
  });

  it("truncates very long output", () => {
    const longOutput = "x".repeat(10000);
    const result = formatFeedback([makeStepResult({ stdout: longOutput })], "code");
    expect(result).toContain("truncated");
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it("does not truncate output within limit", () => {
    const shortOutput = "x".repeat(100);
    const result = formatFeedback([makeStepResult({ stdout: shortOutput })], "code");
    expect(result).not.toContain("truncated");
    expect(result).toContain(shortOutput);
  });
});
