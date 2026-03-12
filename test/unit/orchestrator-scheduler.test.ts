import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { OrchestratorState } from "../../src/orchestrator/state.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { Logger } from "../../src/logging/logger.js";
import { createState, SlotManager } from "../../src/orchestrator/state.js";
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

import { tick, startScheduler, type TickDeps } from "../../src/orchestrator/scheduler.js";
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
    slotManager: new SlotManager(3),
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
      slotManager: new SlotManager(0),
    });
    const issues = [makeIssue("1")];
    vi.mocked(deps.tracker.fetchCandidateIssues).mockResolvedValue(issues);
    vi.mocked(filterCandidates).mockReturnValue(issues);
    vi.mocked(sortCandidates).mockReturnValue(issues);

    await tick(deps);

    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it("handles reconcile errors gracefully", async () => {
    const deps = makeDeps();
    vi.mocked(reconcile).mockRejectedValue(new Error("reconcile failed"));

    // Should not throw
    await expect(tick(deps)).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});

describe("startScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stop function", () => {
    const deps = makeDeps();
    const stop = startScheduler(deps);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("runs first tick immediately", async () => {
    const deps = makeDeps();
    const stop = startScheduler(deps);

    // Flush the promise microtask queue
    await vi.advanceTimersByTimeAsync(0);

    expect(reconcile).toHaveBeenCalledTimes(1);
    stop();
  });

  it("schedules next tick after poll_interval_ms", async () => {
    const deps = makeDeps();
    const stop = startScheduler(deps);

    // First tick
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Advance to second tick
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops further ticks when stop is called", async () => {
    const deps = makeDeps();
    const stop = startScheduler(deps);

    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    stop();

    await vi.advanceTimersByTimeAsync(200);
    // Should not have run more ticks
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("uses setTimeout chain (not setInterval)", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    const deps = makeDeps();
    const stop = startScheduler(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalled();
    // setInterval should NOT be used (other than vitest internal calls)
    const setIntervalCallCount = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 100, // our poll interval
    ).length;
    expect(setIntervalCallCount).toBe(0);

    stop();
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("continues scheduling even after tick errors", async () => {
    const deps = makeDeps();
    vi.mocked(reconcile)
      .mockRejectedValueOnce(new Error("tick 1 error"))
      .mockResolvedValue(undefined);

    const stop = startScheduler(deps);

    // First tick (error)
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Second tick (should still schedule)
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(2);

    stop();
  });
});
