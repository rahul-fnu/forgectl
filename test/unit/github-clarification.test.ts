import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWebhookHandlers, type WebhookDeps } from "../../src/github/webhooks.js";
import type { RunRow } from "../../src/storage/repositories/runs.js";

/** Create a minimal mock App with webhooks.on event registration. */
function createMockApp() {
  const handlers: Record<string, Function> = {};
  return {
    webhooks: {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    },
    handlers,
  };
}

function createMockOctokit() {
  return {
    rest: {
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }),
      },
    },
  };
}

function makeWaitingRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-waiting-1",
    task: "Fix bug",
    workflow: "code",
    status: "waiting_for_input",
    options: {},
    submittedAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:01:00Z",
    completedAt: null,
    result: null,
    error: null,
    pauseReason: "clarification",
    pauseContext: {
      reason: "clarification",
      phase: "agent_executing",
      question: "Which database?",
      issueContext: { owner: "acme", repo: "app", issueNumber: 10 },
    },
    approvalContext: null,
    approvalAction: null,
    githubCommentId: null,
    ...overrides,
  };
}

describe("clarification flow", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let deps: WebhookDeps;
  let resumeRunMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockApp = createMockApp();
    resumeRunMock = vi.fn().mockReturnValue({ runId: "run-waiting-1", pauseContext: {}, humanInput: "PostgreSQL" });

    deps = {
      triggerLabel: "forgectl",
      onDispatch: vi.fn(),
      onCommand: vi.fn().mockResolvedValue(undefined),
      runRepo: {
        insert: vi.fn(),
        findById: vi.fn(),
        updateStatus: vi.fn(),
        findByStatus: vi.fn().mockReturnValue([]),
        list: vi.fn().mockReturnValue([]),
        clearPauseContext: vi.fn(),
        findByGithubCommentId: vi.fn(),
        setGithubCommentId: vi.fn(),
      } as any,
      findWaitingRunForIssue: vi.fn().mockReturnValue(undefined),
      resumeRun: resumeRunMock,
    };

    registerWebhookHandlers(mockApp as any, deps);
  });

  it("resumes run when issue author replies to a waiting run", async () => {
    const waitingRun = makeWaitingRun();
    (deps.findWaitingRunForIssue as ReturnType<typeof vi.fn>).mockReturnValue(waitingRun);

    const octokit = createMockOctokit();
    const payload = {
      comment: {
        id: 555,
        body: "PostgreSQL",
        user: { login: "alice", type: "User" },
      },
      issue: {
        number: 10,
        user: { login: "alice" },
      },
      repository: {
        owner: { login: "acme" },
        name: "app",
      },
    };

    await mockApp.handlers["issue_comment.created"]({ payload, octokit });

    expect(deps.findWaitingRunForIssue).toHaveBeenCalledWith("acme", "app", 10);
    expect(resumeRunMock).toHaveBeenCalledWith(deps.runRepo, "run-waiting-1", "PostgreSQL");
    expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      comment_id: 555,
      content: "eyes",
    });
  });

  it("does not resume run when reply is from non-issue-author", async () => {
    const waitingRun = makeWaitingRun();
    (deps.findWaitingRunForIssue as ReturnType<typeof vi.fn>).mockReturnValue(waitingRun);

    const octokit = createMockOctokit();
    const payload = {
      comment: {
        id: 556,
        body: "PostgreSQL",
        user: { login: "bob", type: "User" },
      },
      issue: {
        number: 10,
        user: { login: "alice" },
      },
      repository: {
        owner: { login: "acme" },
        name: "app",
      },
    };

    await mockApp.handlers["issue_comment.created"]({ payload, octokit });

    expect(resumeRunMock).not.toHaveBeenCalled();
  });

  it("ignores reply on issue with no waiting run", async () => {
    (deps.findWaitingRunForIssue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const octokit = createMockOctokit();
    const payload = {
      comment: {
        id: 557,
        body: "PostgreSQL",
        user: { login: "alice", type: "User" },
      },
      issue: {
        number: 10,
        user: { login: "alice" },
      },
      repository: {
        owner: { login: "acme" },
        name: "app",
      },
    };

    await mockApp.handlers["issue_comment.created"]({ payload, octokit });

    expect(resumeRunMock).not.toHaveBeenCalled();
  });

  it("does not trigger resume on bot comments", async () => {
    const waitingRun = makeWaitingRun();
    (deps.findWaitingRunForIssue as ReturnType<typeof vi.fn>).mockReturnValue(waitingRun);

    const octokit = createMockOctokit();
    const payload = {
      comment: {
        id: 558,
        body: "I have a question before I can continue",
        user: { login: "forgectl[bot]", type: "Bot" },
      },
      issue: {
        number: 10,
        user: { login: "alice" },
      },
      repository: {
        owner: { login: "acme" },
        name: "app",
      },
    };

    await mockApp.handlers["issue_comment.created"]({ payload, octokit });

    expect(resumeRunMock).not.toHaveBeenCalled();
  });
});
