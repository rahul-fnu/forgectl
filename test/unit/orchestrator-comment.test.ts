import { describe, it, expect } from "vitest";
import { buildResultComment } from "../../src/orchestrator/comment.js";
import type { CommentData, RichCommentData } from "../../src/orchestrator/comment.js";

function makeCommentData(overrides?: Partial<CommentData>): CommentData {
  return {
    status: "completed",
    durationMs: 120000,
    agentType: "claude-code",
    attempt: 1,
    tokenUsage: { input: 5000, output: 2000, total: 7000 },
    ...overrides,
  };
}

describe("buildResultComment", () => {
  describe("backward compatibility with CommentData", () => {
    it("produces standard comment with status, agent, attempt, duration", () => {
      const result = buildResultComment(makeCommentData());
      expect(result).toContain("## forgectl Agent Report");
      expect(result).toContain("**Status:** Pass");
      expect(result).toContain("**Agent:** claude-code");
      expect(result).toContain("**Attempt:** 1");
      expect(result).toContain("**Duration:** 2m");
    });

    it("includes token usage table", () => {
      const result = buildResultComment(makeCommentData());
      expect(result).toContain("### Token Usage");
      expect(result).toContain("5,000");
      expect(result).toContain("2,000");
      expect(result).toContain("7,000");
    });

    it("includes branch when provided", () => {
      const result = buildResultComment(makeCommentData({ branch: "forgectl/run-1" }));
      expect(result).toContain("`forgectl/run-1`");
    });

    it("includes validation results when provided", () => {
      const result = buildResultComment(makeCommentData({
        validationResults: [
          { name: "typecheck", passed: true },
          { name: "lint", passed: false, error: "2 errors" },
        ],
      }));
      expect(result).toContain("[x] typecheck");
      expect(result).toContain("[ ] lint");
      expect(result).toContain("2 errors");
    });

    it("does not include rich sections when not provided", () => {
      const result = buildResultComment(makeCommentData());
      expect(result).not.toContain("### Changes");
      expect(result).not.toContain("### Estimated Cost");
      expect(result).not.toContain("<details>");
    });
  });

  describe("RichCommentData: file changes", () => {
    it("includes Changes section with file paths and stats", () => {
      const data: RichCommentData = {
        ...makeCommentData(),
        filesChanged: [
          { path: "src/index.ts", additions: 12, deletions: 3 },
          { path: "test/foo.test.ts", additions: 45, deletions: 0 },
        ],
      };
      const result = buildResultComment(data);
      expect(result).toContain("### Changes");
      expect(result).toContain("`src/index.ts` (+12 -3)");
      expect(result).toContain("`test/foo.test.ts` (+45 -0)");
    });

    it("truncates file list to 20 with overflow message", () => {
      const files = Array.from({ length: 25 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        additions: i,
        deletions: 0,
      }));
      const data: RichCommentData = {
        ...makeCommentData(),
        filesChanged: files,
      };
      const result = buildResultComment(data);
      expect(result).toContain("and 5 more");
      // Should show exactly 20 files
      expect(result).toContain("`src/file-0.ts`");
      expect(result).toContain("`src/file-19.ts`");
      expect(result).not.toContain("`src/file-20.ts`");
    });
  });

  describe("RichCommentData: cost estimate", () => {
    it("includes Estimated Cost section", () => {
      const data: RichCommentData = {
        ...makeCommentData(),
        costEstimate: {
          inputCost: 0.015,
          outputCost: 0.03,
          totalCost: 0.045,
          currency: "USD",
        },
      };
      const result = buildResultComment(data);
      expect(result).toContain("### Estimated Cost");
      expect(result).toContain("$0.0450");
      expect(result).toContain("Input:");
      expect(result).toContain("Output:");
    });
  });

  describe("RichCommentData: collapsible validation details", () => {
    it("uses details/summary for failed steps with stderr", () => {
      const data: RichCommentData = {
        ...makeCommentData(),
        validationDetails: [
          { name: "typecheck", passed: true, durationMs: 2100 },
          { name: "lint", passed: false, error: "2 errors", stderr: "Error: missing semicolon\nError: unused var", durationMs: 1500 },
        ],
      };
      const result = buildResultComment(data);
      expect(result).toContain("<details>");
      expect(result).toContain("lint");
      expect(result).toContain("failed");
      expect(result).toContain("missing semicolon");
      expect(result).toContain("</details>");
    });

    it("shows passed steps without collapsible", () => {
      const data: RichCommentData = {
        ...makeCommentData(),
        validationDetails: [
          { name: "typecheck", passed: true, durationMs: 2100 },
        ],
      };
      const result = buildResultComment(data);
      expect(result).toContain("typecheck");
      expect(result).toContain("passed");
      // Passed steps don't need collapsible
      expect(result).not.toContain("<details>");
    });
  });

  describe("length guard", () => {
    it("truncates to stay under 60000 chars", () => {
      // Create a comment with very long stderr in validation details
      const longStderr = "x".repeat(70000);
      const data: RichCommentData = {
        ...makeCommentData(),
        filesChanged: Array.from({ length: 25 }, (_, i) => ({
          path: `src/file-${i}.ts`,
          additions: i,
          deletions: 0,
        })),
        validationDetails: [
          { name: "test", passed: false, stderr: longStderr, durationMs: 1000 },
        ],
      };
      const result = buildResultComment(data);
      expect(result.length).toBeLessThanOrEqual(60000);
      expect(result).toContain("truncated");
    });
  });
});
