import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerIssue } from "../../src/tracker/types.js";
import type { RunRepository, RunRow } from "../../src/storage/repositories/runs.js";
import type { IssueContext, ParsedCommand } from "../../src/github/types.js";

/**
 * Import the command handler and helpers we'll create.
 * These are extracted from server.ts for testability.
 */
import {
  handleSlashCommand,
  findRunForIssue,
  type CommandHandlerDeps,
} from "../../src/github/command-handler.js";

function makeIssueContext(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    owner: "acme",
    repo: "widgets",
    issueNumber: 42,
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-123",
    task: "Fix the bug",
    workflow: null,
    status: "running",
    options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
    submittedAt: "2026-03-10T00:00:00Z",
    startedAt: "2026-03-10T00:01:00Z",
    completedAt: null,
    result: null,
    error: null,
    pauseReason: null,
    pauseContext: null,
    approvalContext: null,
    approvalAction: null,
    githubCommentId: null,
    ...overrides,
  };
}

function makeOctokit() {
  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function makeOrchestrator() {
  return {
    dispatchIssue: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
  };
}

function makeRunRepo(runs: RunRow[] = []): RunRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn((id: string) => runs.find((r) => r.id === id)),
    updateStatus: vi.fn(),
    findByStatus: vi.fn((status: string) => runs.filter((r) => r.status === status)),
    list: vi.fn(() => runs),
    clearPauseContext: vi.fn(),
    findByGithubCommentId: vi.fn(),
    setGithubCommentId: vi.fn(),
  };
}

describe("findRunForIssue", () => {
  it("finds an active run matching the issue context", () => {
    const run = makeRunRow({
      status: "running",
      options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
    });
    const repo = makeRunRepo([run]);
    const result = findRunForIssue(repo, makeIssueContext(), ["running"]);
    expect(result).toEqual(run);
  });

  it("returns undefined when no matching run exists", () => {
    const run = makeRunRow({
      status: "running",
      options: { issueContext: { owner: "other", repo: "other", issueNumber: 99 } },
    });
    const repo = makeRunRepo([run]);
    const result = findRunForIssue(repo, makeIssueContext(), ["running"]);
    expect(result).toBeUndefined();
  });

  it("matches task string containing issue identifier when options has no issueContext", () => {
    const run = makeRunRow({
      status: "running",
      task: "acme/widgets#42: Fix the bug",
      options: null,
    });
    const repo = makeRunRepo([run]);
    const result = findRunForIssue(repo, makeIssueContext(), ["running"]);
    expect(result).toEqual(run);
  });
});

describe("handleSlashCommand", () => {
  let octokit: ReturnType<typeof makeOctokit>;
  let orchestrator: ReturnType<typeof makeOrchestrator>;
  let context: IssueContext;

  beforeEach(() => {
    octokit = makeOctokit();
    orchestrator = makeOrchestrator();
    context = makeIssueContext();
  });

  describe("/forgectl run", () => {
    it("dispatches issue to orchestrator", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "run", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(orchestrator.dispatchIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "42",
          identifier: "acme/widgets#42",
        }),
      );
    });

    it("posts error when orchestrator is unavailable", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator: null,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "run", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("not running"),
        }),
      );
    });
  });

  describe("/forgectl rerun", () => {
    it("dispatches issue to orchestrator (re-dispatch)", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "rerun", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(orchestrator.dispatchIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "42",
          identifier: "acme/widgets#42",
        }),
      );
    });
  });

  describe("/forgectl approve", () => {
    it("calls approveRun with the matching pending run", async () => {
      const run = makeRunRow({
        id: "run-approve",
        status: "pending_approval",
        options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
      });
      const runRepo = makeRunRepo([run]);
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo,
        approveRun: vi.fn().mockReturnValue({ previousStatus: "pending_approval" }),
      };
      await handleSlashCommand(
        { command: "approve", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(deps.approveRun).toHaveBeenCalledWith(runRepo, "run-approve");
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("approved"),
        }),
      );
    });

    it("posts error when no pending run exists", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
        approveRun: vi.fn(),
      };
      await handleSlashCommand(
        { command: "approve", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(deps.approveRun).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("No run pending approval"),
        }),
      );
    });
  });

  describe("/forgectl reject", () => {
    it("calls rejectRun with the matching pending run", async () => {
      const run = makeRunRow({
        id: "run-reject",
        status: "pending_approval",
        options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
      });
      const runRepo = makeRunRepo([run]);
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo,
        rejectRun: vi.fn(),
      };
      await handleSlashCommand(
        { command: "reject", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(deps.rejectRun).toHaveBeenCalledWith(runRepo, "run-reject");
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("rejected"),
        }),
      );
    });

    it("posts error when no pending run exists", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
        rejectRun: vi.fn(),
      };
      await handleSlashCommand(
        { command: "reject", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(deps.rejectRun).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("No run pending approval"),
        }),
      );
    });
  });

  describe("/forgectl stop", () => {
    it("cancels the active run for the issue", async () => {
      const run = makeRunRow({
        id: "run-stop",
        status: "running",
        options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
      });
      const runRepo = makeRunRepo([run]);
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo,
      };
      await handleSlashCommand(
        { command: "stop", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(runRepo.updateStatus).toHaveBeenCalledWith("run-stop", {
        status: "cancelled",
      });
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("stopped"),
        }),
      );
    });

    it("posts error when no active run exists", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "stop", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("No active run"),
        }),
      );
    });
  });

  describe("/forgectl status", () => {
    it("posts run status info when a run exists", async () => {
      const run = makeRunRow({
        id: "run-status",
        status: "running",
        options: { issueContext: { owner: "acme", repo: "widgets", issueNumber: 42 } },
      });
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo([run]),
      };
      await handleSlashCommand(
        { command: "status", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("running"),
        }),
      );
    });

    it("posts error when no run exists", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "status", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("No run found"),
        }),
      );
    });
  });

  describe("/forgectl help", () => {
    it("posts the help message", async () => {
      const deps: CommandHandlerDeps = {
        orchestrator,
        runRepo: makeRunRepo(),
      };
      await handleSlashCommand(
        { command: "help", args: [] },
        octokit as any,
        context,
        "user1",
        1,
        deps,
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("forgectl commands"),
        }),
      );
    });
  });
});
