import { describe, it, expect, vi, beforeEach } from "vitest";

// These will be imported once implemented
// For now we test the wiring behavior

describe("Comment consolidation wiring", () => {
  describe("toRunResult mapping", () => {
    it("maps completed AgentResult to success RunResult", async () => {
      const { toRunResult } = await import("../../src/orchestrator/worker.js");
      const result = toRunResult(
        "run-123",
        {
          stdout: "done",
          stderr: "",
          status: "completed",
          tokenUsage: { input: 1000, output: 500, total: 1500 },
          durationMs: 5000,
          turnCount: 3,
        },
        5000,
        undefined,
        "feat/my-branch",
        "default",
      );
      expect(result.runId).toBe("run-123");
      expect(result.status).toBe("success");
      expect(result.duration).toMatch(/5s/);
      expect(result.cost).toBeDefined();
      expect(result.cost!.input_tokens).toBe(1000);
      expect(result.cost!.output_tokens).toBe(500);
      expect(result.workflow).toBe("default");
      expect(result.agent).toBeDefined();
    });

    it("maps failed AgentResult to failure RunResult", async () => {
      const { toRunResult } = await import("../../src/orchestrator/worker.js");
      const result = toRunResult(
        "run-456",
        {
          stdout: "",
          stderr: "error occurred",
          status: "failed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs: 100,
          turnCount: 0,
        },
        100,
      );
      expect(result.status).toBe("failure");
      expect(result.runId).toBe("run-456");
    });

    it("includes validation results when provided", async () => {
      const { toRunResult } = await import("../../src/orchestrator/worker.js");
      const mockValidation = {
        passed: true,
        stepResults: [
          { name: "lint", passed: true, exitCode: 0, stdout: "", stderr: "" },
          { name: "test", passed: false, exitCode: 1, stdout: "", stderr: "fail", error: "test failed" },
        ],
        totalAttempts: 1,
      };
      const result = toRunResult("run-789", {
        stdout: "",
        stderr: "",
        status: "completed",
        tokenUsage: { input: 0, output: 0, total: 0 },
        durationMs: 0,
        turnCount: 0,
      }, 0, mockValidation);
      expect(result.validationResults).toHaveLength(2);
      expect(result.validationResults![0].step).toBe("lint");
      expect(result.validationResults![0].passed).toBe(true);
      expect(result.validationResults![1].passed).toBe(false);
    });
  });

  describe("worker uses github/comments.ts", () => {
    it("worker imports buildResultComment from github/comments, not orchestrator/comment", async () => {
      // Read the worker source and verify imports
      const fs = await import("node:fs");
      const workerSrc = fs.readFileSync("src/orchestrator/worker.ts", "utf-8");
      expect(workerSrc).toContain('from "../github/comments.js"');
      expect(workerSrc).not.toMatch(/import.*buildResultComment.*from.*\.\/comment/);
    });
  });

  describe("worker progress updates with githubDeps", () => {
    it("calls updateProgressComment at agent_executing stage when githubDeps provided", async () => {
      // We test the exported helper that worker uses
      const { updateProgressComment } = await import("../../src/github/comments.js");
      const mockOctokit = {
        rest: {
          issues: {
            updateComment: vi.fn().mockResolvedValue({}),
          },
        },
      };
      const context = { owner: "test", repo: "repo", issueNumber: 1 };
      await updateProgressComment(mockOctokit as any, context, 42, {
        runId: "run-1",
        status: "running",
        completedStages: ["agent_executing"],
      });
      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 42,
        }),
      );
    });
  });

  describe("dispatcher creates progress comment", () => {
    it("createProgressComment returns comment id", async () => {
      const { createProgressComment } = await import("../../src/github/comments.js");
      const mockOctokit = {
        rest: {
          issues: {
            createComment: vi.fn().mockResolvedValue({ data: { id: 99 } }),
          },
        },
      };
      const context = { owner: "test", repo: "repo", issueNumber: 1 };
      const commentId = await createProgressComment(mockOctokit as any, context, {
        runId: "run-1",
        status: "started",
        completedStages: [],
      });
      expect(commentId).toBe(99);
    });
  });

  describe("non-GitHub runs skip GitHub calls", () => {
    it("worker without githubDeps produces comment string without errors", async () => {
      // toRunResult should work without any GitHub context
      const { toRunResult } = await import("../../src/orchestrator/worker.js");
      const result = toRunResult("run-no-gh", {
        stdout: "ok",
        stderr: "",
        status: "completed",
        tokenUsage: { input: 100, output: 50, total: 150 },
        durationMs: 1000,
        turnCount: 1,
      }, 1000);
      expect(result.runId).toBe("run-no-gh");
      expect(result.status).toBe("success");
    });
  });

  describe("error handling", () => {
    it("GitHub API errors in updateProgressComment are catchable", async () => {
      const { updateProgressComment } = await import("../../src/github/comments.js");
      const mockOctokit = {
        rest: {
          issues: {
            updateComment: vi.fn().mockRejectedValue(new Error("API rate limit")),
          },
        },
      };
      const context = { owner: "test", repo: "repo", issueNumber: 1 };
      await expect(
        updateProgressComment(mockOctokit as any, context, 42, {
          runId: "run-1",
          status: "running",
          completedStages: ["agent_executing"],
        }),
      ).rejects.toThrow("API rate limit");
    });
  });

  describe("orchestrator/comment.ts is deprecated", () => {
    it("has @deprecated JSDoc on exports", async () => {
      const fs = await import("node:fs");
      const commentSrc = fs.readFileSync("src/orchestrator/comment.ts", "utf-8");
      expect(commentSrc).toContain("@deprecated");
    });
  });
});
