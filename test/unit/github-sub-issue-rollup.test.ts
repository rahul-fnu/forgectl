import { describe, it, expect, vi } from "vitest";
import {
  buildRollupMarker,
  findRollupCommentId,
  upsertRollupComment,
  buildSubIssueProgressComment,
  allChildrenTerminal,
} from "../../src/github/sub-issue-rollup.js";
import type { RollupOctokitLike } from "../../src/github/sub-issue-rollup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOctokit(overrides: Partial<RollupOctokitLike["rest"]["issues"]> = {}): RollupOctokitLike {
  return {
    rest: {
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 101 } }),
        updateComment: vi.fn().mockResolvedValue({}),
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// buildRollupMarker
// ---------------------------------------------------------------------------

describe("buildRollupMarker", () => {
  it("returns the hidden HTML comment with parent issue number", () => {
    expect(buildRollupMarker(42)).toBe("<!-- forgectl:progress:parent-42 -->");
  });

  it("works with different issue numbers", () => {
    expect(buildRollupMarker(1)).toBe("<!-- forgectl:progress:parent-1 -->");
    expect(buildRollupMarker(9999)).toBe("<!-- forgectl:progress:parent-9999 -->");
  });
});

// ---------------------------------------------------------------------------
// findRollupCommentId
// ---------------------------------------------------------------------------

describe("findRollupCommentId", () => {
  it("returns null when no comments exist", async () => {
    const octokit = makeOctokit({
      listComments: vi.fn().mockResolvedValue({ data: [] }),
    });
    const result = await findRollupCommentId(octokit, "owner", "repo", 42);
    expect(result).toBeNull();
  });

  it("returns comment id when marker is found in body", async () => {
    const octokit = makeOctokit({
      listComments: vi.fn().mockResolvedValue({
        data: [
          { id: 55, body: "some text" },
          { id: 99, body: "<!-- forgectl:progress:parent-42 -->\n## Sub-Issue Progress" },
        ],
      }),
    });
    const result = await findRollupCommentId(octokit, "owner", "repo", 42);
    expect(result).toBe(99);
  });

  it("does not return comment id for a different parent number", async () => {
    const octokit = makeOctokit({
      listComments: vi.fn().mockResolvedValue({
        data: [
          { id: 77, body: "<!-- forgectl:progress:parent-100 -->" },
        ],
      }),
    });
    const result = await findRollupCommentId(octokit, "owner", "repo", 42);
    expect(result).toBeNull();
  });

  it("paginates through multiple pages and finds marker on second page", async () => {
    const page1Data = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "no marker" }));
    const page2Data = [
      { id: 201, body: "<!-- forgectl:progress:parent-42 -->" },
    ];

    const listComments = vi.fn()
      .mockResolvedValueOnce({ data: page1Data })
      .mockResolvedValueOnce({ data: page2Data })
      .mockResolvedValueOnce({ data: [] });

    const octokit = makeOctokit({ listComments });
    const result = await findRollupCommentId(octokit, "owner", "repo", 42);
    expect(result).toBe(201);
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it("stops paginating when a page has fewer than per_page results", async () => {
    const listComments = vi.fn().mockResolvedValue({
      data: [{ id: 1, body: "no marker" }],
    });
    const octokit = makeOctokit({ listComments });
    const result = await findRollupCommentId(octokit, "owner", "repo", 5);
    expect(result).toBeNull();
    expect(listComments).toHaveBeenCalledTimes(1);
  });

  it("passes per_page=100 and page number in requests", async () => {
    const listComments = vi.fn().mockResolvedValue({ data: [] });
    const octokit = makeOctokit({ listComments });
    await findRollupCommentId(octokit, "myowner", "myrepo", 7);
    expect(listComments).toHaveBeenCalledWith({
      owner: "myowner",
      repo: "myrepo",
      issue_number: 7,
      per_page: 100,
      page: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// upsertRollupComment
// ---------------------------------------------------------------------------

describe("upsertRollupComment", () => {
  it("calls createComment when no marker comment exists", async () => {
    const octokit = makeOctokit({
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      createComment: vi.fn().mockResolvedValue({ data: { id: 500 } }),
    });
    await upsertRollupComment(octokit, "owner", "repo", 10, "body text");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 10,
      body: "body text",
    });
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("calls updateComment when marker comment exists", async () => {
    const octokit = makeOctokit({
      listComments: vi.fn().mockResolvedValue({
        data: [{ id: 42, body: "<!-- forgectl:progress:parent-10 -->" }],
      }),
      updateComment: vi.fn().mockResolvedValue({}),
    });
    await upsertRollupComment(octokit, "owner", "repo", 10, "new body");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      comment_id: 42,
      body: "new body",
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("creates fresh comment when marker was deleted (self-healing)", async () => {
    // First call returns nothing (marker deleted), so it creates
    const listComments = vi.fn().mockResolvedValue({ data: [] });
    const createComment = vi.fn().mockResolvedValue({ data: { id: 999 } });
    const octokit = makeOctokit({ listComments, createComment });
    await upsertRollupComment(octokit, "owner", "repo", 5, "fresh body");
    expect(createComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 5,
      body: "fresh body",
    });
  });
});

// ---------------------------------------------------------------------------
// buildSubIssueProgressComment
// ---------------------------------------------------------------------------

describe("buildSubIssueProgressComment", () => {
  it("includes the hidden marker at the top", () => {
    const comment = buildSubIssueProgressComment(42, []);
    expect(comment).toContain("<!-- forgectl:progress:parent-42 -->");
    // Marker must be at the very start
    expect(comment.startsWith("<!-- forgectl:progress:parent-42 -->")).toBe(true);
  });

  it("includes the heading", () => {
    const comment = buildSubIssueProgressComment(1, []);
    expect(comment).toContain("## Sub-Issue Progress");
  });

  it("renders completed child with checked box and green checkmark emoji", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "1", title: "Auth adapter", url: "https://github.com/o/r/issues/1", state: "completed" },
    ]);
    expect(comment).toContain("[x]");
    expect(comment).toContain("✅");
    expect(comment).toContain("Auth adapter");
    expect(comment).toContain("https://github.com/o/r/issues/1");
  });

  it("renders in_progress child with unchecked box and hourglass emoji", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "2", title: "DB schema", url: "https://github.com/o/r/issues/2", state: "in_progress" },
    ]);
    expect(comment).toContain("[ ]");
    expect(comment).toContain("⏳");
    expect(comment).toContain("DB schema");
  });

  it("renders pending child with unchecked box and white square emoji", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "3", title: "Tests", url: "https://github.com/o/r/issues/3", state: "pending" },
    ]);
    expect(comment).toContain("[ ]");
    expect(comment).toContain("⬜");
  });

  it("renders failed child with unchecked box and red X emoji", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "4", title: "CI pipeline", url: "https://github.com/o/r/issues/4", state: "failed" },
    ]);
    expect(comment).toContain("[ ]");
    expect(comment).toContain("❌");
  });

  it("renders blocked child with unchecked box and no entry sign emoji", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "5", title: "Deploy", url: "https://github.com/o/r/issues/5", state: "blocked" },
    ]);
    expect(comment).toContain("[ ]");
    expect(comment).toContain("⛔");
  });

  it("appends error summary for failed children", () => {
    const comment = buildSubIssueProgressComment(10, [
      {
        id: "4",
        title: "Auth adapter",
        url: "https://github.com/o/r/issues/42",
        state: "failed",
        errorSummary: "validation timeout",
      },
    ]);
    expect(comment).toContain("Failed: validation timeout");
  });

  it("does not append error text for non-failed children", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "1", title: "Done", url: "https://github.com/o/r/issues/1", state: "completed" },
    ]);
    expect(comment).not.toContain("Failed:");
  });

  it("renders footer with completed/total count", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "1", title: "Done", url: "https://github.com/o/r/issues/1", state: "completed" },
      { id: "2", title: "Pending", url: "https://github.com/o/r/issues/2", state: "pending" },
    ]);
    expect(comment).toContain("**Progress: 1/2 complete**");
  });

  it("shows 0/0 for empty children list", () => {
    const comment = buildSubIssueProgressComment(10, []);
    expect(comment).toContain("**Progress: 0/0 complete**");
  });

  it("counts only completed state in the numerator", () => {
    const comment = buildSubIssueProgressComment(10, [
      { id: "1", title: "Done", url: "https://u", state: "completed" },
      { id: "2", title: "Fail", url: "https://u", state: "failed" },
      { id: "3", title: "Block", url: "https://u", state: "blocked" },
    ]);
    expect(comment).toContain("**Progress: 1/3 complete**");
  });

  it("includes attribution line", () => {
    const comment = buildSubIssueProgressComment(10, []);
    expect(comment).toContain("forgectl");
  });
});

// ---------------------------------------------------------------------------
// allChildrenTerminal
// ---------------------------------------------------------------------------

describe("allChildrenTerminal", () => {
  const TERMINAL = new Set(["closed", "completed", "failed"]);

  it("returns false for an empty map", () => {
    expect(allChildrenTerminal(new Map(), TERMINAL)).toBe(false);
  });

  it("returns true when all children are in terminal set", () => {
    const states = new Map([
      ["child-1", "closed"],
      ["child-2", "completed"],
      ["child-3", "failed"],
    ]);
    expect(allChildrenTerminal(states, TERMINAL)).toBe(true);
  });

  it("returns false when any child is not in terminal set", () => {
    const states = new Map([
      ["child-1", "closed"],
      ["child-2", "open"],
    ]);
    expect(allChildrenTerminal(states, TERMINAL)).toBe(false);
  });

  it("returns false when all children are non-terminal", () => {
    const states = new Map([
      ["child-1", "open"],
      ["child-2", "in_progress"],
    ]);
    expect(allChildrenTerminal(states, TERMINAL)).toBe(false);
  });

  it("works with a single terminal child", () => {
    const states = new Map([["child-1", "closed"]]);
    expect(allChildrenTerminal(states, TERMINAL)).toBe(true);
  });

  it("works with a single non-terminal child", () => {
    const states = new Map([["child-1", "open"]]);
    expect(allChildrenTerminal(states, TERMINAL)).toBe(false);
  });
});
