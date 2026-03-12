import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the GitHub context plumbing chain:
 * server.ts -> orchestrator/index.ts -> dispatcher.ts -> worker.ts
 *
 * Verifies that octokit + repo flow from webhook handler through to executeWorker,
 * enabling progress comments, check runs, and PR descriptions.
 */

// Mock executeWorker to capture arguments
const mockExecuteWorker = vi.fn().mockResolvedValue({
  agentResult: { stdout: "ok", stderr: "", status: "completed", tokenUsage: { input: 100, output: 50, total: 150 }, durationMs: 1000, turnCount: 1 },
  comment: "done",
});

// Mock createProgressComment
const mockCreateProgressComment = vi.fn().mockResolvedValue(42);

// Mock setGithubCommentId
const mockSetGithubCommentId = vi.fn();

vi.mock("../../src/orchestrator/worker.js", () => ({
  executeWorker: mockExecuteWorker,
  buildOrchestratedRunPlan: vi.fn().mockReturnValue({ runId: "test-run" }),
}));

vi.mock("../../src/github/comments.js", () => ({
  createProgressComment: mockCreateProgressComment,
  buildResultComment: vi.fn().mockReturnValue("result comment"),
}));

vi.mock("../../src/orchestration/single.js", () => ({
  prepareExecution: vi.fn(),
}));

// Mock other dispatcher dependencies
vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

vi.mock("../../src/governance/autonomy.js", () => ({
  needsPreApproval: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/governance/approval.js", () => ({
  enterPendingApproval: vi.fn(),
}));

vi.mock("../../src/governance/rules.js", () => ({
  evaluateAutoApprove: vi.fn().mockReturnValue(false),
}));

describe("GitHub context plumbing", () => {
  const mockState = {
    claimed: new Set<string>(),
    running: new Map(),
    retryTimers: new Map(),
    retryAttempts: new Map(),
  };

  const mockTracker = {
    updateLabels: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    fetchIssues: vi.fn().mockResolvedValue([]),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
  };

  const mockConfig = {
    orchestrator: {
      in_progress_label: "in-progress",
      max_retries: 3,
      continuation_delay_ms: 1000,
      max_retry_backoff_ms: 5000,
      max_concurrent_agents: 2,
      poll_interval_ms: 30000,
      drain_timeout_ms: 10000,
    },
    agent: { type: "claude-code", model: "claude-sonnet", max_turns: 10, timeout: "5m", flags: [] },
    container: { image: "node:20", network: { mode: "open" }, resources: { memory: "512m", cpus: "1" } },
    repo: { exclude: [] },
    commit: { message: { prefix: "", template: "", include_task: false }, author: "", sign: false },
    workspace: { root: "/tmp/ws", hooks: {}, hook_timeout: "60s" },
    tracker: { auto_close: false, done_label: "", terminal_states: [] },
  };

  const mockWorkspaceManager = {
    ensureWorkspace: vi.fn().mockResolvedValue({ path: "/tmp/ws/test" }),
    runBeforeHook: vi.fn().mockResolvedValue(undefined),
    runAfterHook: vi.fn().mockResolvedValue(undefined),
    cleanupTerminalWorkspaces: vi.fn().mockResolvedValue(undefined),
  };

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockMetrics = {
    recordDispatch: vi.fn(),
    recordCompletion: vi.fn(),
    recordRetry: vi.fn(),
  };

  const mockIssue = {
    id: "123",
    identifier: "owner/repo#123",
    title: "Test issue",
    description: "Test description",
    state: "open",
    labels: ["forgectl"],
    priority: null,
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author: "testuser",
  };

  const mockOctokit = {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 42 } }),
        updateComment: vi.fn().mockResolvedValue({}),
      },
      checks: { create: vi.fn(), update: vi.fn() },
      pulls: { list: vi.fn(), update: vi.fn() },
    },
  };

  const mockRepo = { owner: "testowner", repo: "testrepo" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.claimed.clear();
    mockState.running.clear();
    mockState.retryTimers.clear();
    mockState.retryAttempts.clear();
  });

  describe("dispatcher passes GitHubDeps to executeWorker", () => {
    it("constructs GitHubDeps and passes to executeWorker when githubContext provided", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
        undefined,
        { octokit: mockOctokit, repo: mockRepo },
      );

      // Wait for async fire-and-forget to settle
      await vi.waitFor(() => {
        expect(mockExecuteWorker).toHaveBeenCalled();
      }, { timeout: 2000 });

      // executeWorker should be called with githubDeps at index 8
      const callArgs = mockExecuteWorker.mock.calls[0];
      const githubDeps = callArgs[8];
      expect(githubDeps).toBeDefined();
      expect(githubDeps.octokit).toBe(mockOctokit);
      expect(githubDeps.issueContext).toEqual({
        owner: "testowner",
        repo: "testrepo",
        issueNumber: 123,
      });
      expect(githubDeps.repoContext).toEqual(mockRepo);
    });

    it("calls createProgressComment before executeWorker when octokit is available", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      const callOrder: string[] = [];
      mockCreateProgressComment.mockImplementation(async () => {
        callOrder.push("createProgressComment");
        return 42;
      });
      mockExecuteWorker.mockImplementation(async () => {
        callOrder.push("executeWorker");
        return {
          agentResult: { stdout: "ok", stderr: "", status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 0, turnCount: 0 },
          comment: "done",
        };
      });

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
        undefined,
        { octokit: mockOctokit, repo: mockRepo },
      );

      await vi.waitFor(() => {
        expect(mockExecuteWorker).toHaveBeenCalled();
      }, { timeout: 2000 });

      expect(callOrder.indexOf("createProgressComment")).toBeLessThan(callOrder.indexOf("executeWorker"));
    });

    it("stores commentId via setGithubCommentId after createProgressComment", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      const governance = {
        autonomy: "full" as const,
        runRepo: { setGithubCommentId: mockSetGithubCommentId } as any,
      };

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
        governance,
        { octokit: mockOctokit, repo: mockRepo },
      );

      await vi.waitFor(() => {
        expect(mockSetGithubCommentId).toHaveBeenCalled();
      }, { timeout: 2000 });

      expect(mockSetGithubCommentId).toHaveBeenCalledWith(
        expect.any(String),
        42,
      );
    });

    it("constructs GitHubDeps with issueContext derived from issue + repo", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
        undefined,
        { octokit: mockOctokit, repo: mockRepo },
      );

      await vi.waitFor(() => {
        expect(mockExecuteWorker).toHaveBeenCalled();
      }, { timeout: 2000 });

      const callArgs = mockExecuteWorker.mock.calls[0];
      const githubDeps = callArgs[8];
      expect(githubDeps.issueContext.owner).toBe("testowner");
      expect(githubDeps.issueContext.repo).toBe("testrepo");
      expect(githubDeps.issueContext.issueNumber).toBe(123);
    });
  });

  describe("backward compatibility (no githubContext)", () => {
    it("executeWorker called without githubDeps when no githubContext provided", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
      );

      await vi.waitFor(() => {
        expect(mockExecuteWorker).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Last argument should be undefined (no githubDeps)
      const callArgs = mockExecuteWorker.mock.calls[0];
      const githubDeps = callArgs[8];
      expect(githubDeps).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("createProgressComment failure does not prevent executeWorker from running", async () => {
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      mockCreateProgressComment.mockRejectedValue(new Error("API rate limit"));

      dispatchIssue(
        mockIssue as any,
        mockState as any,
        mockTracker as any,
        mockConfig as any,
        mockWorkspaceManager as any,
        "template",
        mockLogger as any,
        mockMetrics as any,
        undefined,
        { octokit: mockOctokit, repo: mockRepo },
      );

      await vi.waitFor(() => {
        expect(mockExecuteWorker).toHaveBeenCalled();
      }, { timeout: 2000 });

      // executeWorker should still have been called
      expect(mockExecuteWorker).toHaveBeenCalledTimes(1);
      // But githubDeps should have commentId of 0 (fallback)
      const callArgs = mockExecuteWorker.mock.calls[0];
      const githubDeps = callArgs[8];
      expect(githubDeps).toBeDefined();
      expect(githubDeps.commentId).toBe(0);
    });
  });

  describe("server.ts onDispatch wiring", () => {
    it("server.ts does not discard octokit and repo in onDispatch callback", async () => {
      const fs = await import("node:fs");
      const serverSrc = fs.readFileSync("src/daemon/server.ts", "utf-8");
      // Should NOT have _octokit or _repo (underscore prefix means discarded)
      expect(serverSrc).not.toMatch(/onDispatch:.*_octokit/);
      expect(serverSrc).not.toMatch(/onDispatch:.*_repo/);
    });
  });

  describe("orchestrator index.ts forwarding", () => {
    it("Orchestrator.dispatchIssue accepts optional githubContext parameter", async () => {
      const fs = await import("node:fs");
      const indexSrc = fs.readFileSync("src/orchestrator/index.ts", "utf-8");
      // Should accept githubContext parameter
      expect(indexSrc).toMatch(/dispatchIssue\(issue.*githubContext/);
    });
  });
});
