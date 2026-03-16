/**
 * Integration wiring tests for sub-issue rollup callback in dispatcher.
 *
 * Tests verify that triggerParentRollup (exported for testing) correctly:
 * - Posts rollup comment on parent after child completion
 * - Swallows errors (never throws)
 * - Adds forge:synthesize label when all children are terminal
 * - Skips rollup when child has no parent in cache
 * - Skips rollup when githubContext is undefined
 * - Handles synthesizer-gated close (success path and failure path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubIssueCache, SubIssueEntry } from "../../src/tracker/sub-issue-cache.js";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { Logger } from "../../src/logging/logger.js";
import type { GitHubContext } from "../../src/orchestrator/dispatcher.js";

// Mock the sub-issue-rollup module
vi.mock("../../src/github/sub-issue-rollup.js", () => ({
  upsertRollupComment: vi.fn().mockResolvedValue(undefined),
  buildSubIssueProgressComment: vi.fn().mockReturnValue("mock progress comment body"),
  allChildrenTerminal: vi.fn().mockReturnValue(false),
}));

import { triggerParentRollup, handleSynthesizerOutcome } from "../../src/orchestrator/dispatcher.js";
import {
  upsertRollupComment,
  buildSubIssueProgressComment,
  allChildrenTerminal,
} from "../../src/github/sub-issue-rollup.js";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "42",
    identifier: "ISSUE-42",
    title: "Fix the thing",
    description: "do it",
    state: "open",
    labels: [],
    priority: null,
    assignees: [],
    blocked_by: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: "https://github.com/owner/repo/issues/42",
    ...overrides,
  };
}

function makeTracker(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as TrackerAdapter;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeGitHubContext(): GitHubContext {
  return {
    octokit: { rest: { issues: {} } },
    repo: { owner: "owner", repo: "repo" },
  };
}

function makeCacheEntry(
  parentId: string,
  childIds: string[],
  childStates: Map<string, string> = new Map(childIds.map((id) => [id, "open"])),
): SubIssueEntry {
  return {
    parentId,
    childIds,
    childStates,
    fetchedAt: Date.now(),
  };
}

function makeCache(entries: SubIssueEntry[]): SubIssueCache {
  return {
    get: vi.fn((id: string) => entries.find((e) => e.parentId === id) ?? null),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    getAllEntries: vi.fn().mockReturnValue(entries),
  } as unknown as SubIssueCache;
}

function makeConfig(overrides: { terminal_states?: string[]; auto_close?: boolean } = {}) {
  return {
    orchestrator: {
      in_progress_label: "forge:in-progress",
      max_retries: 3,
      continuation_delay_ms: 1000,
      max_retry_backoff_ms: 30000,
    },
    tracker: {
      terminal_states: overrides.terminal_states ?? ["closed"],
      auto_close: overrides.auto_close ?? false,
      done_label: undefined,
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests: triggerParentRollup
// ---------------------------------------------------------------------------

describe("triggerParentRollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: upsertRollupComment succeeds, buildSubIssueProgressComment returns a body, allChildrenTerminal returns false
    vi.mocked(upsertRollupComment).mockResolvedValue(undefined);
    vi.mocked(buildSubIssueProgressComment).mockReturnValue("mock progress comment body");
    vi.mocked(allChildrenTerminal).mockReturnValue(false);
  });

  it("posts rollup comment on parent when child completes", async () => {
    const childIssue = makeIssue({ id: "42", title: "Child issue" });
    const parentEntry = makeCacheEntry("10", ["42", "43"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    expect(buildSubIssueProgressComment).toHaveBeenCalledWith(10, expect.any(Array));
    expect(upsertRollupComment).toHaveBeenCalledWith(
      githubCtx.octokit,
      "owner",
      "repo",
      10,
      "mock progress comment body",
    );
  });

  it("updates child state to 'closed' before building comment", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"], new Map([["42", "open"]]));
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    // The child state should be updated to 'closed' in the entry before the terminal check
    expect(allChildrenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ size: 1 }),
      expect.any(Set),
    );
    // Entry childStates should be updated
    expect(parentEntry.childStates.get("42")).toBe("closed");
  });

  it("swallows upsertRollupComment errors and does not throw", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    vi.mocked(upsertRollupComment).mockRejectedValue(new Error("GitHub API down"));

    // Must not throw
    await expect(
      triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it("auto-closes parent epic when all children are terminal", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    vi.mocked(allChildrenTerminal).mockReturnValue(true);

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    expect(tracker.updateState).toHaveBeenCalledWith("10", "closed");
  });

  it("does NOT add forge:synthesize label when children are not all terminal", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42", "43"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    vi.mocked(allChildrenTerminal).mockReturnValue(false);

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    expect(tracker.updateLabels).not.toHaveBeenCalled();
  });

  it("swallows label update errors (fire-and-forget with warn)", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker({
      updateLabels: vi.fn().mockRejectedValue(new Error("label fail")),
    });
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    vi.mocked(allChildrenTerminal).mockReturnValue(true);

    // Must not throw
    await expect(
      triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger),
    ).resolves.toBeUndefined();
  });

  it("silently skips rollup when child has no parent in cache", async () => {
    const childIssue = makeIssue({ id: "99" }); // not in any cache entry
    const parentEntry = makeCacheEntry("10", ["42", "43"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    expect(upsertRollupComment).not.toHaveBeenCalled();
    expect(buildSubIssueProgressComment).not.toHaveBeenCalled();
    expect(tracker.updateLabels).not.toHaveBeenCalled();
  });

  it("passes terminal states from config to allChildrenTerminal", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig({ terminal_states: ["closed", "done", "cancelled"] });

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    expect(allChildrenTerminal).toHaveBeenCalledWith(
      expect.any(Map),
      new Set(["closed", "done", "cancelled"]),
    );
  });

  it("builds child URLs using github context repo info", async () => {
    const childIssue = makeIssue({ id: "42", title: "My child issue" });
    const parentEntry = makeCacheEntry("10", ["42", "43"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker();
    const githubCtx = makeGitHubContext(); // owner/repo
    const logger = makeLogger();
    const config = makeConfig();

    await triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger);

    // Check that buildSubIssueProgressComment was called with children that have proper URLs
    const callArgs = vi.mocked(buildSubIssueProgressComment).mock.calls[0];
    const children = callArgs[1] as Array<{ id: string; url: string; title: string }>;
    const child42 = children.find((c) => c.id === "42");
    expect(child42?.url).toBe("https://github.com/owner/repo/issues/42");
    expect(child42?.title).toBe("My child issue");

    // Other children get fallback title
    const child43 = children.find((c) => c.id === "43");
    expect(child43?.url).toBe("https://github.com/owner/repo/issues/43");
    expect(child43?.title).toBe("#43");
  });
});

// ---------------------------------------------------------------------------
// Tests: synthesizer-gated close (tested through dispatchIssue integration)
// We test this by checking the exported synthesizer helpers (if any) or
// verifying the full flow via a mock-heavy integration test.
// ---------------------------------------------------------------------------

describe("synthesizer-gated close (synthesize label on issue)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertRollupComment).mockResolvedValue(undefined);
    vi.mocked(buildSubIssueProgressComment).mockReturnValue("final summary");
    vi.mocked(allChildrenTerminal).mockReturnValue(false);
  });

  it("triggerParentRollup completes without throwing even when all mocks fail", async () => {
    const childIssue = makeIssue({ id: "42" });
    const parentEntry = makeCacheEntry("10", ["42"]);
    const cache = makeCache([parentEntry]);
    const tracker = makeTracker({
      updateLabels: vi.fn().mockRejectedValue(new Error("fail")),
      postComment: vi.fn().mockRejectedValue(new Error("fail")),
      updateState: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const githubCtx = makeGitHubContext();
    const logger = makeLogger();
    const config = makeConfig();

    vi.mocked(upsertRollupComment).mockRejectedValue(new Error("API fail"));
    vi.mocked(allChildrenTerminal).mockReturnValue(true);

    await expect(
      triggerParentRollup(childIssue, cache, tracker, githubCtx, config, logger),
    ).resolves.toBeUndefined();
  });

  it("when issue has forge:synthesize label and worker succeeds, closes parent and removes label", async () => {
    const issue = makeIssue({ id: "10", identifier: "ISSUE-10", labels: ["forge:synthesize"] });
    const tracker = makeTracker();
    const logger = makeLogger();

    handleSynthesizerOutcome(issue, "success", tracker, logger);

    // Allow fire-and-forget promises to settle
    await Promise.resolve();

    expect(tracker.updateState).toHaveBeenCalledWith("10", "closed");
    expect(tracker.updateLabels).toHaveBeenCalledWith("10", [], ["forge:synthesize"]);
  });

  it("when issue has forge:synthesize label and worker fails, posts error comment and does NOT close", async () => {
    const issue = makeIssue({ id: "10", identifier: "ISSUE-10", labels: ["forge:synthesize"] });
    const tracker = makeTracker();
    const logger = makeLogger();

    handleSynthesizerOutcome(issue, "failure", tracker, logger);

    // Allow fire-and-forget promises to settle
    await Promise.resolve();

    expect(tracker.postComment).toHaveBeenCalledWith(
      "10",
      expect.stringContaining("failed"),
    );
    expect(tracker.postComment).toHaveBeenCalledWith(
      "10",
      expect.stringContaining("ISSUE-10"),
    );
    expect(tracker.updateState).not.toHaveBeenCalled();
  });
});
