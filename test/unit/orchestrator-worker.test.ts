import { describe, it, expect } from "vitest";
import { buildResultComment, type CommentData } from "../../src/orchestrator/comment.js";

describe("buildResultComment", () => {
  const baseData: CommentData = {
    status: "completed",
    durationMs: 154_000,
    agentType: "claude-code",
    attempt: 1,
    tokenUsage: { input: 12_345, output: 6_789, total: 19_134 },
  };

  it("includes Pass for completed status", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("Pass");
  });

  it("includes Fail for failed status", () => {
    const result = buildResultComment({ ...baseData, status: "failed" });
    expect(result).toContain("Fail");
  });

  it("includes human-readable duration", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("2m 34s");
  });

  it("includes token usage table with comma-formatted numbers", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("12,345");
    expect(result).toContain("6,789");
    expect(result).toContain("19,134");
  });

  it("includes agent type", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("claude-code");
  });

  it("includes attempt number", () => {
    const result = buildResultComment({ ...baseData, attempt: 3 });
    const result1 = buildResultComment(baseData);
    expect(result).toContain("3");
    expect(result1).toContain("1");
  });

  it("includes validation checklist when validationResults provided", () => {
    const data: CommentData = {
      ...baseData,
      validationResults: [
        { name: "typecheck", passed: true },
        { name: "lint", passed: false, error: "2 errors found" },
      ],
    };
    const result = buildResultComment(data);
    expect(result).toContain("[x] typecheck");
    expect(result).toContain("[ ] lint");
    expect(result).toContain("2 errors found");
  });

  it("omits validation section when validationResults is empty", () => {
    const data: CommentData = { ...baseData, validationResults: [] };
    const result = buildResultComment(data);
    expect(result).not.toContain("Validation");
  });

  it("omits validation section when validationResults is undefined", () => {
    const result = buildResultComment(baseData);
    expect(result).not.toContain("Validation");
  });

  it("includes branch line when branch provided", () => {
    const data: CommentData = { ...baseData, branch: "forge/issue-42/abc123" };
    const result = buildResultComment(data);
    expect(result).toContain("forge/issue-42/abc123");
  });

  it("includes forgectl Agent Report header", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("## forgectl Agent Report");
  });

  it("formats duration for sub-minute durations", () => {
    const result = buildResultComment({ ...baseData, durationMs: 45_000 });
    expect(result).toContain("45s");
  });

  it("formats duration for hour+ durations", () => {
    const result = buildResultComment({ ...baseData, durationMs: 3_661_000 });
    expect(result).toContain("1h 1m 1s");
  });
});
