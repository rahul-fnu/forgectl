import { describe, it, expect, vi } from "vitest";
import {
  buildProgressComment,
  buildResultComment,
  buildClarificationComment,
  createProgressComment,
  updateProgressComment,
  type RunProgress,
  type RunResult,
} from "../../src/github/comments.js";
import type { IssueContext } from "../../src/github/types.js";

describe("buildProgressComment", () => {
  it("produces markdown with unchecked checklist for started status", () => {
    const progress: RunProgress = {
      runId: "run-abc123",
      status: "started",
      completedStages: [],
    };
    const md = buildProgressComment(progress);
    expect(md).toContain("## forgectl run `run-abc123`");
    expect(md).toContain("- [ ] Agent executing");
    expect(md).toContain("- [ ] Validation");
    expect(md).toContain("- [ ] Output collection");
  });

  it("checks completed stages in checklist", () => {
    const progress: RunProgress = {
      runId: "run-abc123",
      status: "validating",
      completedStages: ["agent_executing"],
    };
    const md = buildProgressComment(progress);
    expect(md).toContain("- [x] Agent executing");
    expect(md).toContain("- [ ] Validation");
    expect(md).toContain("- [ ] Output collection");
  });

  it("includes run ID in header", () => {
    const progress: RunProgress = {
      runId: "run-xyz789",
      status: "started",
      completedStages: [],
    };
    const md = buildProgressComment(progress);
    expect(md).toContain("run-xyz789");
  });

  it("shows validation attempt number when present", () => {
    const progress: RunProgress = {
      runId: "run-abc",
      status: "validation_retry",
      completedStages: ["agent_executing"],
      validationAttempt: 3,
    };
    const md = buildProgressComment(progress);
    expect(md).toContain("attempt 3");
  });
});

describe("buildResultComment", () => {
  it("produces collapsible details with summary line", () => {
    const result: RunResult = {
      runId: "run-abc123",
      status: "success",
      duration: "3m 22s",
      cost: { input_tokens: 10000, output_tokens: 5000, estimated_usd: "$0.42" },
    };
    const md = buildResultComment(result);
    expect(md).toContain("3m 22s");
    expect(md).toContain("$0.42");
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
  });

  it("includes expandable section for changes", () => {
    const result: RunResult = {
      runId: "run-abc123",
      status: "success",
      duration: "2m",
      changes: ["src/foo.ts", "src/bar.ts"],
    };
    const md = buildResultComment(result);
    expect(md).toContain("<summary>");
    expect(md).toContain("Changes");
    expect(md).toContain("src/foo.ts");
    expect(md).toContain("src/bar.ts");
  });

  it("includes expandable section for validation results", () => {
    const result: RunResult = {
      runId: "run-abc123",
      status: "success",
      duration: "1m",
      validationResults: [
        { step: "lint", passed: true },
        { step: "test", passed: false, output: "2 failures" },
      ],
    };
    const md = buildResultComment(result);
    expect(md).toContain("Validation");
    expect(md).toContain("lint");
    expect(md).toContain("test");
  });

  it("includes expandable section for cost breakdown", () => {
    const result: RunResult = {
      runId: "run-abc",
      status: "success",
      duration: "5m",
      cost: { input_tokens: 50000, output_tokens: 20000, estimated_usd: "$1.23" },
    };
    const md = buildResultComment(result);
    expect(md).toContain("Cost");
    expect(md).toContain("50000");
    expect(md).toContain("20000");
    expect(md).toContain("$1.23");
  });

  it("shows success emoji for successful runs", () => {
    const result: RunResult = {
      runId: "run-abc",
      status: "success",
      duration: "1m",
    };
    const md = buildResultComment(result);
    // Should have a success indicator
    expect(md).toMatch(/completed|success/i);
  });

  it("shows failure indicator for failed runs", () => {
    const result: RunResult = {
      runId: "run-abc",
      status: "failure",
      duration: "1m",
    };
    const md = buildResultComment(result);
    expect(md).toMatch(/failed|failure/i);
  });

  it("includes forgectl footer", () => {
    const result: RunResult = {
      runId: "run-abc",
      status: "success",
      duration: "1m",
    };
    const md = buildResultComment(result);
    expect(md).toContain("forgectl");
  });
});

describe("buildClarificationComment", () => {
  it("includes @mention of issue author", () => {
    const md = buildClarificationComment("What branch?", "octocat");
    expect(md).toContain("@octocat");
  });

  it("includes quoted question", () => {
    const md = buildClarificationComment("What branch should I target?", "octocat");
    expect(md).toContain("> What branch should I target?");
  });

  it("includes reply instruction", () => {
    const md = buildClarificationComment("Question?", "octocat");
    expect(md).toContain("Reply to this comment to continue");
  });

  it("includes italic run paused note", () => {
    const md = buildClarificationComment("Question?", "octocat");
    expect(md).toContain("_Run paused");
    expect(md).toContain("will resume when you reply_");
  });
});

describe("createProgressComment", () => {
  it("returns comment ID from API response", async () => {
    const mockOctokit = {
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({
            data: { id: 99887766 },
          }),
        },
      },
    };
    const context: IssueContext = { owner: "org", repo: "repo", issueNumber: 42 };
    const progress: RunProgress = {
      runId: "run-abc",
      status: "started",
      completedStages: [],
    };

    const commentId = await createProgressComment(mockOctokit as any, context, progress);

    expect(commentId).toBe(99887766);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 42,
      body: expect.stringContaining("forgectl run"),
    });
  });
});

describe("updateProgressComment", () => {
  it("calls octokit.rest.issues.updateComment with correct comment_id", async () => {
    const mockOctokit = {
      rest: {
        issues: {
          updateComment: vi.fn().mockResolvedValue({}),
        },
      },
    };
    const context: IssueContext = { owner: "org", repo: "repo", issueNumber: 42 };
    const progress: RunProgress = {
      runId: "run-abc",
      status: "validating",
      completedStages: ["agent_executing"],
    };

    await updateProgressComment(mockOctokit as any, context, 99887766, progress);

    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      comment_id: 99887766,
      body: expect.stringContaining("forgectl run"),
    });
  });
});
