import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleReactionEvent, type ReactionDeps } from "../../src/github/reactions.js";
import type { RunRow, RunRepository } from "../../src/storage/repositories/runs.js";

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-abc",
    task: "fix bug",
    workflow: null,
    status: "pending_approval",
    options: null,
    submittedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    pauseReason: null,
    pauseContext: null,
    approvalContext: null,
    approvalAction: null,
    githubCommentId: 555,
    ...overrides,
  };
}

function makeMockRunRepo(run?: RunRow): RunRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn().mockReturnValue(run),
    updateStatus: vi.fn(),
    findByStatus: vi.fn().mockReturnValue([]),
    list: vi.fn().mockReturnValue([]),
    clearPauseContext: vi.fn(),
    findByGithubCommentId: vi.fn().mockReturnValue(run),
    setGithubCommentId: vi.fn(),
  };
}

function makeMockOctokit() {
  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }),
        updateComment: vi.fn().mockResolvedValue({}),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission: "write" },
        }),
      },
    },
  };
}

function makeCommentReactionPayload(
  reaction: string,
  commentAuthorType: string = "Bot",
  commentId: number = 555,
) {
  return {
    action: "created" as const,
    reaction: {
      content: reaction,
      user: { login: "human-user", type: "User" },
    },
    comment: {
      id: commentId,
      user: { login: "forgectl[bot]", type: commentAuthorType },
      performed_via_github_app: commentAuthorType === "Bot" ? { id: 1 } : null,
    },
    issue: {
      number: 42,
      user: { login: "issue-author" },
    },
    repository: {
      owner: { login: "org" },
      name: "repo",
      full_name: "org/repo",
    },
  };
}

function makeIssueReactionPayload(reaction: string) {
  return {
    action: "created" as const,
    reaction: {
      content: reaction,
      user: { login: "human-user", type: "User" },
    },
    comment: undefined,
    issue: {
      number: 42,
      user: { login: "issue-author" },
    },
    repository: {
      owner: { login: "org" },
      name: "repo",
      full_name: "org/repo",
    },
  };
}

describe("handleReactionEvent", () => {
  let deps: ReactionDeps;
  let mockOctokit: ReturnType<typeof makeMockOctokit>;
  let mockRunRepo: ReturnType<typeof makeMockRunRepo>;

  beforeEach(() => {
    mockRunRepo = makeMockRunRepo(makeRunRow());
    mockOctokit = makeMockOctokit();
    deps = {
      runRepo: mockRunRepo,
      onDispatch: vi.fn(),
      onRerun: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("+1 reaction on bot comment calls approveRun with correct runId", async () => {
    const payload = makeCommentReactionPayload("+1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.findByGithubCommentId).toHaveBeenCalledWith(555);
    expect(mockRunRepo.updateStatus).toHaveBeenCalled();
  });

  it("-1 reaction on bot comment calls rejectRun with correct runId", async () => {
    const payload = makeCommentReactionPayload("-1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.findByGithubCommentId).toHaveBeenCalledWith(555);
    expect(mockRunRepo.updateStatus).toHaveBeenCalled();
  });

  it("rocket reaction on issue body calls dispatch callback", async () => {
    const payload = makeIssueReactionPayload("rocket");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(deps.onDispatch).toHaveBeenCalled();
  });

  it("reaction on arbitrary user comment (not bot) is ignored", async () => {
    const payload = makeCommentReactionPayload("+1", "User", 999);

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.findByGithubCommentId).not.toHaveBeenCalled();
    expect(mockRunRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("reaction from user without write access is silently ignored", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "read" },
    });

    const payload = makeCommentReactionPayload("+1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("+1 reaction on comment with no associated run is silently ignored", async () => {
    mockRunRepo.findByGithubCommentId.mockReturnValue(undefined);

    const payload = makeCommentReactionPayload("+1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("bot adds eyes reaction as acknowledgment when processing valid reaction", async () => {
    const payload = makeCommentReactionPayload("+1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      comment_id: 555,
      content: "eyes",
    });
  });

  it("unrecognized reaction type is ignored", async () => {
    const payload = makeCommentReactionPayload("heart");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(mockRunRepo.updateStatus).not.toHaveBeenCalled();
    expect(mockOctokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
  });

  it("rocket reaction on issue body does not check comment author", async () => {
    // Issue body reactions have no comment - just trigger dispatch
    const payload = makeIssueReactionPayload("rocket");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(deps.onDispatch).toHaveBeenCalled();
    expect(mockRunRepo.findByGithubCommentId).not.toHaveBeenCalled();
  });

  it("non-rocket reaction on issue body is ignored", async () => {
    const payload = makeIssueReactionPayload("+1");

    await handleReactionEvent(payload, mockOctokit as any, deps);

    expect(deps.onDispatch).not.toHaveBeenCalled();
  });
});
