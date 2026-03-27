import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { OrchestratorState } from "../../src/orchestrator/state.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { Logger } from "../../src/logging/logger.js";
import { createState, TwoTierSlotManager } from "../../src/orchestrator/state.js";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";

// Mock reconciler
vi.mock("../../src/orchestrator/reconciler.js", () => ({
  reconcile: vi.fn().mockResolvedValue(undefined),
}));

// Mock dispatcher
vi.mock("../../src/orchestrator/dispatcher.js", () => ({
  filterCandidates: vi.fn().mockReturnValue([]),
  sortCandidates: vi.fn().mockReturnValue([]),
  dispatchIssue: vi.fn(),
}));

import { tick, startScheduler, evaluateSchedules, type TickDeps } from "../../src/orchestrator/scheduler.js";
import { reconcile } from "../../src/orchestrator/reconciler.js";
import { filterCandidates, sortCandidates, dispatchIssue } from "../../src/orchestrator/dispatcher.js";

function makeIssue(id: string): TrackerIssue {
  return {
    id,
    identifier: `GH-${id}`,
    title: "Test",
    description: "",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeTracker(): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrackerAdapter;
}

function makeDeps(overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    state: createState(),
    tracker: makeTracker(),
    workspaceManager: {} as unknown as WorkspaceManager,
    slotManager: new TwoTierSlotManager(3, 0),
    config: {
      orchestrator: {
        enabled: true,
        max_concurrent_agents: 3,
        poll_interval_ms: 100, // Short for testing
        stall_timeout_ms: 600000,
        max_retries: 5,
        max_retry_backoff_ms: 300000,
        drain_timeout_ms: 30000,
        continuation_delay_ms: 1000,
        in_progress_label: "in-progress",
      },
      tracker: {
        kind: "github",
        token: "test-token",
        active_states: ["open"],
        terminal_states: ["closed"],
        poll_interval_ms: 30000,
        auto_close: false,
      },
    } as unknown as ForgectlConfig,
    promptTemplate: "Fix {{issue_identifier}}",
    logger: makeLogger(),
    metrics: new MetricsCollector(),
    ...overrides,
  };
}

describe("tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls reconcile before fetching candidates", async () => {
    const deps = makeDeps();
    const callOrder: string[] = [];

    vi.mocked(reconcile).mockImplementation(async () => {
      callOrder.push("reconcile");
    });
    vi.mocked(deps.tracker.fetchCandidateIssues).mockImplementation(async () => {
      callOrder.push("fetchCandidates");
      return [];
    });

    await tick(deps);

    expect(callOrder).toEqual(["reconcile", "fetchCandidates"]);
  });

  it("fetches candidates from tracker", async () => {
    const deps = makeDeps();
    await tick(deps);
    expect(deps.tracker.fetchCandidateIssues).toHaveBeenCalled();
  });

  it("filters and sorts candidates", async () => {
    const deps = makeDeps();
    const issues = [makeIssue("1"), makeIssue("2")];
    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(issues);
    vi.mocked(filterCandidates).mockReturnValue(issues);
    vi.mocked(sortCandidates).mockReturnValue(issues);

    await tick(deps);

    expect(filterCandidates).toHaveBeenCalledWith(issues, deps.state, expect.any(Set), undefined);
    expect(sortCandidates).toHaveBeenCalledWith(issues);
  });

  it("dispatches critical-path issues first (DAG-aware ordering)", async () => {
    const deps = makeDeps();
    // Issue "1" is a root that "2" and "3" depend on
    // Issue "2" is a leaf, "3" is also a leaf
    // After "1" completes (terminal), "2" and "3" become eligible
    // But if "1" is already done, among "2" and "3":
    //   "2" unblocks "4", so it should dispatch before "3"
    const issue2 = { ...makeIssue("2"), blocked_by: [] };
    const issue3 = { ...makeIssue("3"), blocked_by: [] };
    const issue4 = { ...makeIssue("4"), blocked_by: ["2"] };

    // All three are candidates (full set for DAG computation)
    const allCandidates = [issue2, issue3, issue4];
    // Only issue2 and issue3 are eligible (issue4 is blocked by issue2)
    const eligible = [issue3, issue2]; // intentionally reversed

    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(allCandidates);
    vi.mocked(filterCandidates).mockReturnValue(eligible);
    vi.mocked(sortCandidates).mockReturnValue(eligible); // no priority reorder

    await tick(deps);

    // issue2 should be dispatched first because it unblocks issue4
    expect(dispatchIssue).toHaveBeenCalledTimes(2);
    const firstDispatched = vi.mocked(dispatchIssue).mock.calls[0][0];
    const secondDispatched = vi.mocked(dispatchIssue).mock.calls[1][0];
    expect(firstDispatched.id).toBe("2");
    expect(secondDispatched.id).toBe("3");
  });

  it("never dispatches issues with unresolved blockers", async () => {
    const deps = makeDeps();
    // Issue "B" is blocked by "A", which is NOT in terminal state
    const issueA = makeIssue("A");
    const issueB = { ...makeIssue("B"), blocked_by: ["A"] };

    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue([issueA, issueB]);
    // filterCandidates already handles this — only issueA passes
    vi.mocked(filterCandidates).mockReturnValue([issueA]);
    vi.mocked(sortCandidates).mockReturnValue([issueA]);

    await tick(deps);

    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchIssue).mock.calls[0][0].id).toBe("A");
  });

  it("dispatches up to available slots", async () => {
    const deps = makeDeps();
    const issues = [makeIssue("1"), makeIssue("2"), makeIssue("3"), makeIssue("4")];
    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(issues);
    vi.mocked(filterCandidates).mockReturnValue(issues);
    vi.mocked(sortCandidates).mockReturnValue(issues);

    // SlotManager with max 3 — should dispatch only 3
    await tick(deps);

    expect(dispatchIssue).toHaveBeenCalledTimes(3);
  });

  it("dispatches nothing when no slots available", async () => {
    const deps = makeDeps({
      slotManager: new TwoTierSlotManager(0, 0),
    });
    // Fill state.running to max so available = 0
    const max = deps.config.orchestrator?.max_concurrent_agents ?? 3;
    for (let i = 0; i < max; i++) {
      deps.state.running.set(`fill-${i}`, {} as any);
    }
    const issues = [makeIssue("1")];
    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(issues);
    vi.mocked(filterCandidates).mockReturnValue(issues);
    vi.mocked(sortCandidates).mockReturnValue(issues);

    await tick(deps);

    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it("handles reconcile errors gracefully", async () => {
    const deps = makeDeps();
    vi.mocked(reconcile).mockRejectedValueOnce(new Error("reconcile failed"));

    // Should not throw
    await expect(tick(deps)).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("passes promotedFindings to dispatchIssue", async () => {
    const findings = [
      { id: 1, run_id: "r1", file: "src/foo.ts", line: 10, severity: "MUST_FIX", category: "bug", message: "fix this", sha: "abc", created_at: "2026-01-01", promoted: 1 },
    ];
    const deps = makeDeps({ promotedFindings: findings as any });
    const issues = [makeIssue("1")];
    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(issues);
    vi.mocked(filterCandidates).mockReturnValue(issues);
    vi.mocked(sortCandidates).mockReturnValue(issues);

    await tick(deps);

    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(dispatchIssue).mock.calls[0];
    // promotedFindings is the 17th positional arg (index 16)
    expect(callArgs[16]).toBe(findings);
  });

  describe("subIssueCache integration (SUBISSUE-03)", () => {
    it("populates terminalIssueIds from subIssueCache entries with terminal states", async () => {
      const { SubIssueCache } = await import("../../src/tracker/sub-issue-cache.js");
      const cache = new SubIssueCache();

      // Set up cache: parent issue 10 has children 20 (closed) and 21 (open)
      const childStates = new Map([["20", "closed"], ["21", "open"]]);
      cache.set({
        parentId: "10",
        childIds: ["20", "21"],
        childStates,
        fetchedAt: Date.now(),
      });

      const deps = makeDeps({ subIssueCache: cache });
      await tick(deps);

      // filterCandidates should be called with a Set containing "20" (closed) but not "21" (open)
      const callArgs = vi.mocked(filterCandidates).mock.calls[0];
      const terminalIds = callArgs[2] as Set<string>;
      expect(terminalIds.has("20")).toBe(true);
      expect(terminalIds.has("21")).toBe(false);
    });

    it("uses empty terminalIssueIds when subIssueCache is not provided (backward compat)", async () => {
      const deps = makeDeps(); // no subIssueCache
      await tick(deps);

      const callArgs = vi.mocked(filterCandidates).mock.calls[0];
      const terminalIds = callArgs[2] as Set<string>;
      expect(terminalIds.size).toBe(0);
    });

    it("uses empty terminalIssueIds when cache has entries but none are terminal", async () => {
      const { SubIssueCache } = await import("../../src/tracker/sub-issue-cache.js");
      const cache = new SubIssueCache();

      // All children are open (not terminal)
      const childStates = new Map([["20", "open"], ["21", "open"]]);
      cache.set({
        parentId: "10",
        childIds: ["20", "21"],
        childStates,
        fetchedAt: Date.now(),
      });

      const deps = makeDeps({ subIssueCache: cache });
      await tick(deps);

      const callArgs = vi.mocked(filterCandidates).mock.calls[0];
      const terminalIds = callArgs[2] as Set<string>;
      expect(terminalIds.size).toBe(0);
    });

    it("supports custom terminal_states from config", async () => {
      const { SubIssueCache } = await import("../../src/tracker/sub-issue-cache.js");
      const cache = new SubIssueCache();

      const childStates = new Map([["20", "done"], ["21", "open"]]);
      cache.set({
        parentId: "10",
        childIds: ["20", "21"],
        childStates,
        fetchedAt: Date.now(),
      });

      const deps = makeDeps({
        subIssueCache: cache,
        config: {
          orchestrator: {
            enabled: true,
            max_concurrent_agents: 3,
            poll_interval_ms: 100,
            stall_timeout_ms: 600000,
            max_retries: 5,
            max_retry_backoff_ms: 300000,
            drain_timeout_ms: 30000,
            continuation_delay_ms: 1000,
            in_progress_label: "in-progress",
          },
          tracker: {
            kind: "github",
            token: "test-token",
            active_states: ["open"],
            terminal_states: ["done", "closed"],
            poll_interval_ms: 30000,
            auto_close: false,
          },
        } as unknown as import("../../src/config/schema.js").ForgectlConfig,
      });
      await tick(deps);

      const callArgs = vi.mocked(filterCandidates).mock.calls[0];
      const terminalIds = callArgs[2] as Set<string>;
      expect(terminalIds.has("20")).toBe(true); // "done" is terminal
      expect(terminalIds.has("21")).toBe(false); // "open" is not terminal
    });
  });
});

describe("startScheduler", () => {
  let stopFn: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Stop any running scheduler and drain lingering microtasks
    // to prevent async bleed between tests
    if (stopFn) { stopFn(); stopFn = null; }
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  /** Flush microtasks so async tick() fully completes and schedules its setTimeout.
   *  200 iterations is empirically sufficient to drain the microtask queue for tick() + setTimeout promise chain
   *  (tick now has dynamic imports for evaluateSchedules, KG context building, etc.). */
  async function flushTick(): Promise<void> {
    for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(0);
  }

  it("returns a stop function", () => {
    const deps = makeDeps();
    stopFn = startScheduler(deps);
    expect(typeof stopFn).toBe("function");
  });

  it("runs first tick immediately", async () => {
    const deps = makeDeps();
    stopFn = startScheduler(deps);

    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("schedules next tick after poll_interval_ms", async () => {
    const deps = makeDeps();
    stopFn = startScheduler(deps);

    // First tick
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Advance past poll_interval_ms (100ms) and flush second tick
    await vi.advanceTimersByTimeAsync(100);
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("stops further ticks when stop is called", async () => {
    const deps = makeDeps();
    stopFn = startScheduler(deps);

    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(1);

    stopFn();
    stopFn = null;

    await vi.advanceTimersByTimeAsync(200);
    await flushTick();
    // Should not have run more ticks
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("uses setTimeout chain (not setInterval)", async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const deps = makeDeps();
    stopFn = startScheduler(deps);

    // First tick completes
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Advance to second tick
    await vi.advanceTimersByTimeAsync(100);
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(2);

    // Advance to third tick — proves the chain continues
    await vi.advanceTimersByTimeAsync(100);
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(3);

    // Verify setInterval was never used with the poll interval
    expect(setIntervalSpy.mock.calls.filter(c => c[1] === 100)).toHaveLength(0);

    // With setInterval, ticks would still fire after stop.
    // With setTimeout chain, stop prevents the next tick from scheduling.
    stopFn();
    stopFn = null;
    const countAfterStop = vi.mocked(reconcile).mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(countAfterStop);

    setIntervalSpy.mockRestore();
  });

  it("continues scheduling even after tick errors", async () => {
    const deps = makeDeps();
    vi.mocked(reconcile)
      .mockRejectedValueOnce(new Error("tick 1 error"))
      .mockResolvedValue(undefined);

    stopFn = startScheduler(deps);

    // First tick (error)
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Second tick — should still be scheduled despite previous error
    await vi.advanceTimersByTimeAsync(100);
    await flushTick();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

describe("evaluateSchedules", () => {
  it("returns empty array when no schedules configured", async () => {
    const config = { schedules: [] } as unknown as ForgectlConfig;
    const result = await evaluateSchedules(config, "/tmp/test-kg.db", makeLogger());
    expect(result).toEqual([]);
  });

  it("creates synthetic issue for matching schedule", async () => {
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();

    const config = {
      schedules: [{
        name: "qa-sweep",
        cron: `${minute} ${hour} * * *`,
        task: "Run QA checks on the codebase",
      }],
    } as unknown as ForgectlConfig;

    const dbPath = `/tmp/test-eval-${Date.now()}.db`;
    const result = await evaluateSchedules(config, dbPath, makeLogger());
    expect(result.length).toBe(1);
    expect(result[0].identifier).toBe("schedule/qa-sweep");
    expect(result[0].description).toBe("Run QA checks on the codebase");
    expect(result[0].labels).toContain("scheduled");
    expect(result[0].metadata.synthetic).toBe(true);
    expect(result[0].metadata.scheduleName).toBe("qa-sweep");
  });

  it("skips non-matching schedules", async () => {
    const config = {
      schedules: [{
        name: "midnight-sweep",
        cron: "0 0 31 2 *",
        task: "Never runs",
      }],
    } as unknown as ForgectlConfig;

    const result = await evaluateSchedules(config, "/tmp/test-nomatch-kg.db", makeLogger());
    expect(result).toEqual([]);
  });

  it("prevents duplicate runs within same minute", async () => {
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();

    const config = {
      schedules: [{
        name: "dedup-test",
        cron: `${minute} ${hour} * * *`,
        task: "Test deduplication",
      }],
    } as unknown as ForgectlConfig;

    const dbPath = `/tmp/test-dedup-${Date.now()}.db`;
    const logger = makeLogger();

    const result1 = await evaluateSchedules(config, dbPath, logger);
    expect(result1.length).toBe(1);

    const result2 = await evaluateSchedules(config, dbPath, logger);
    expect(result2.length).toBe(0);
  });

  it("includes repo in metadata when specified", async () => {
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();

    const config = {
      schedules: [{
        name: "repo-sweep",
        cron: `${minute} ${hour} * * *`,
        task: "Sweep specific repo",
        repo: "owner/repo",
      }],
    } as unknown as ForgectlConfig;

    const dbPath = `/tmp/test-repo-${Date.now()}.db`;
    const result = await evaluateSchedules(config, dbPath, makeLogger());
    expect(result.length).toBe(1);
    expect(result[0].metadata.repo).toBe("owner/repo");
  });
});
