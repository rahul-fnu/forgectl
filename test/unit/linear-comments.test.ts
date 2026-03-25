import { describe, expect, it } from "vitest";
import {
  formatRunComment,
  shouldPostComment,
  type RunCommentData,
} from "../../src/tracker/linear-comments.js";

describe("formatRunComment", () => {
  const base: RunCommentData = {
    runId: "run-123",
    issueIdentifier: "ENG-42",
    status: "success",
    durationMs: 125_000, // 2m 5s
    tokenUsage: { input: 50_000, output: 10_000 },
    costUsd: 0.35,
    prUrl: "https://github.com/owner/repo/pull/7",
    branch: "forge/eng-42/abc",
    validationResults: [
      { name: "typecheck", passed: true, attempts: 1 },
      { name: "test", passed: true, attempts: 2 },
    ],
  };

  it("formats success comment with all fields", () => {
    const out = formatRunComment(base);
    expect(out).toContain("✅");
    expect(out).toContain("Success");
    expect(out).toContain("run-123");
    expect(out).toContain("2m 5s");
    expect(out).toContain("60,000");
    expect(out).toContain("50,000 in");
    expect(out).toContain("10,000 out");
    expect(out).toContain("$0.35");
    expect(out).toContain("https://github.com/owner/repo/pull/7");
    expect(out).toContain("`forge/eng-42/abc`");
    expect(out).toContain("✅ typecheck (1 attempt)");
    expect(out).toContain("✅ test (2 attempts)");
  });

  it("formats failure comment with error summary", () => {
    const data: RunCommentData = {
      ...base,
      status: "failure",
      validationResults: [{ name: "test", passed: false, attempts: 3 }],
      errorSummary: "jest: 2 tests failed in suite auth.test.ts",
    };
    const out = formatRunComment(data);
    expect(out).toContain("❌");
    expect(out).toContain("Failure");
    expect(out).toContain("❌ test (3 attempts)");
    expect(out).toContain("**Error:** jest: 2 tests failed");
  });

  it("truncates error summary to 500 chars", () => {
    const longError = "x".repeat(600);
    const data: RunCommentData = {
      ...base,
      status: "failure",
      errorSummary: longError,
    };
    const out = formatRunComment(data);
    expect(out).toContain("x".repeat(500) + "…");
    expect(out).not.toContain("x".repeat(501));
  });

  it("formats comment with no PR link", () => {
    const data: RunCommentData = { ...base, prUrl: undefined, branch: undefined };
    const out = formatRunComment(data);
    expect(out).not.toContain("**PR:**");
    expect(out).not.toContain("**Branch:**");
    expect(out).toContain("Success");
  });

  it("formats comment with no cost data", () => {
    const data: RunCommentData = { ...base, tokenUsage: undefined, costUsd: undefined };
    const out = formatRunComment(data);
    expect(out).not.toContain("Tokens");
    expect(out).not.toContain("Cost");
    expect(out).toContain("2m 5s");
  });

  it("formats timeout status", () => {
    const data: RunCommentData = { ...base, status: "timeout" };
    const out = formatRunComment(data);
    expect(out).toContain("⏰");
    expect(out).toContain("Timeout");
  });

  it("formats aborted status", () => {
    const data: RunCommentData = { ...base, status: "aborted" };
    const out = formatRunComment(data);
    expect(out).toContain("🛑");
    expect(out).toContain("Aborted");
  });

  it("formats cost_ceiling_exceeded status", () => {
    const data: RunCommentData = { ...base, status: "cost_ceiling_exceeded" };
    const out = formatRunComment(data);
    expect(out).toContain("💰");
    expect(out).toContain("Cost Ceiling Exceeded");
  });

  it("shows cost without token usage", () => {
    const data: RunCommentData = { ...base, tokenUsage: undefined, costUsd: 1.5 };
    const out = formatRunComment(data);
    expect(out).toContain("**Cost:** $1.50");
    expect(out).not.toContain("Tokens");
  });
});

describe("shouldPostComment", () => {
  const defaults = ["completed", "failed", "timeout", "aborted"];

  it("allows success when completed is in events", () => {
    expect(shouldPostComment("success", defaults)).toBe(true);
  });

  it("allows failure when failed is in events", () => {
    expect(shouldPostComment("failure", defaults)).toBe(true);
  });

  it("allows timeout when timeout is in events", () => {
    expect(shouldPostComment("timeout", defaults)).toBe(true);
  });

  it("allows aborted when aborted is in events", () => {
    expect(shouldPostComment("aborted", defaults)).toBe(true);
  });

  it("blocks success when completed is not in events", () => {
    expect(shouldPostComment("success", ["failed"])).toBe(false);
  });

  it("blocks failure when failed is not in events", () => {
    expect(shouldPostComment("failure", ["completed"])).toBe(false);
  });

  it("maps cost_ceiling_exceeded to failed event", () => {
    expect(shouldPostComment("cost_ceiling_exceeded", ["failed"])).toBe(true);
    expect(shouldPostComment("cost_ceiling_exceeded", ["completed"])).toBe(false);
  });
});
