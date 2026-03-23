import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { OrchestratorState, WorkerInfo } from "../../src/orchestrator/state.js";
import type { ForgectlConfig, OrchestratorConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { Logger } from "../../src/logging/logger.js";
import { createState, claimIssue } from "../../src/orchestrator/state.js";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";

// Mock worker module
vi.mock("../../src/orchestrator/worker.js", () => ({
  executeWorker: vi.fn(),
}));

// Mock retry module
vi.mock("../../src/orchestrator/retry.js", () => ({
  classifyFailure: vi.fn(),
  calculateBackoff: vi.fn().mockReturnValue(10000),
  scheduleRetry: vi.fn(),
  cancelRetry: vi.fn(),
  cleanupRetryRecords: vi.fn(),
}));

// Import the module under test (after mocks are set up)
import {
  filterCandidates,
  sortCandidates,
  dispatchIssue,
  extractPriorityNumber,
} from "../../src/orchestrator/dispatcher.js";

// Import mocked modules for assertions
import { executeWorker } from "../../src/orchestrator/worker.js";
import { classifyFailure, calculateBackoff, scheduleRetry } from "../../src/orchestrator/retry.js";

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "1",
    identifier: "#1",
    title: "Test issue",
    description: "desc",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "https://example.com/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
    ...overrides,
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

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): ForgectlConfig {
  return {
    orchestrator: {
      enabled: true,
      max_concurrent_agents: 3,
      poll_interval_ms: 30000,
      stall_timeout_ms: 600000,
      max_retries: 5,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 1000,
      in_progress_label: "in-progress",
      ...overrides,
    },
    tracker: {
      kind: "github",
      token: "test-token",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 30000,
      auto_close: false,
      in_progress_label: "in-progress",
    },
  } as unknown as ForgectlConfig;
}

describe("filterCandidates", () => {
  let state: OrchestratorState;

  beforeEach(() => {
    state = createState();
  });

  it("returns all candidates when nothing is claimed or running", () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" })];
    const result = filterCandidates(issues, state, new Set());
    expect(result).toHaveLength(2);
  });

  it("excludes issues already in claimed Set", () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" })];
    claimIssue(state, "a");
    const result = filterCandidates(issues, state, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("excludes issues already in running Map", () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" })];
    state.running.set("b", {} as WorkerInfo);
    const result = filterCandidates(issues, state, new Set());
    // "b" is running so excluded; "a" passes
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("excludes issues with non-terminal blockers", () => {
    const issues = [
      makeIssue({ id: "a", blocked_by: ["blocker-1"] }),
      makeIssue({ id: "b", blocked_by: [] }),
    ];
    // blocker-1 is NOT terminal
    const terminalIds = new Set<string>();
    const result = filterCandidates(issues, state, terminalIds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("includes issues whose blockers are all terminal", () => {
    const issues = [
      makeIssue({ id: "a", blocked_by: ["blocker-1"] }),
    ];
    const terminalIds = new Set(["blocker-1"]);
    const result = filterCandidates(issues, state, terminalIds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("returns empty array when all issues are claimed", () => {
    const issues = [makeIssue({ id: "a" })];
    claimIssue(state, "a");
    const result = filterCandidates(issues, state, new Set());
    expect(result).toHaveLength(0);
  });

  // ── Complex DAG: parallel tracks with diamond convergence ──────────────
  //
  //   Track A:          Track B:
  //     A1                 B1
  //      |                  |
  //     A2                 B2
  //      \                /
  //       +--- C1 ---+
  //            |
  //           C2
  //

  it("complex DAG: only roots are eligible when no blockers are terminal", () => {
    const issues = [
      makeIssue({ id: "a1", blocked_by: [] }),
      makeIssue({ id: "a2", blocked_by: ["a1"] }),
      makeIssue({ id: "b1", blocked_by: [] }),
      makeIssue({ id: "b2", blocked_by: ["b1"] }),
      makeIssue({ id: "c1", blocked_by: ["a2", "b2"] }),
      makeIssue({ id: "c2", blocked_by: ["c1"] }),
    ];
    const result = filterCandidates(issues, state, new Set());
    expect(result.map(i => i.id).sort()).toEqual(["a1", "b1"]);
  });

  it("complex DAG: completing track A roots unlocks A2 but not C1", () => {
    const issues = [
      makeIssue({ id: "a2", blocked_by: ["a1"] }),
      makeIssue({ id: "b1", blocked_by: [] }),
      makeIssue({ id: "b2", blocked_by: ["b1"] }),
      makeIssue({ id: "c1", blocked_by: ["a2", "b2"] }),
      makeIssue({ id: "c2", blocked_by: ["c1"] }),
    ];
    // a1 is terminal (completed)
    const terminalIds = new Set(["a1"]);
    const result = filterCandidates(issues, state, terminalIds);
    // a2 is unblocked (a1 terminal), b1 has no blockers, but b2/c1/c2 still blocked
    expect(result.map(i => i.id).sort()).toEqual(["a2", "b1"]);
  });

  it("complex DAG: both tracks complete unlocks convergence node C1", () => {
    const issues = [
      makeIssue({ id: "c1", blocked_by: ["a2", "b2"] }),
      makeIssue({ id: "c2", blocked_by: ["c1"] }),
    ];
    // Both track tails are terminal
    const terminalIds = new Set(["a1", "a2", "b1", "b2"]);
    const result = filterCandidates(issues, state, terminalIds);
    // c1 is unblocked, c2 still blocked by c1
    expect(result.map(i => i.id)).toEqual(["c1"]);
  });

  it("complex DAG: only one track complete does NOT unlock C1", () => {
    const issues = [
      makeIssue({ id: "c1", blocked_by: ["a2", "b2"] }),
      makeIssue({ id: "c2", blocked_by: ["c1"] }),
    ];
    // Only track A is terminal, track B still active
    const terminalIds = new Set(["a1", "a2"]);
    const result = filterCandidates(issues, state, terminalIds);
    expect(result).toHaveLength(0);
  });

  it("complex DAG: C1 terminal unlocks final integration C2", () => {
    const issues = [
      makeIssue({ id: "c2", blocked_by: ["c1"] }),
    ];
    const terminalIds = new Set(["a1", "a2", "b1", "b2", "c1"]);
    const result = filterCandidates(issues, state, terminalIds);
    expect(result.map(i => i.id)).toEqual(["c2"]);
  });
});

describe("extractPriorityNumber", () => {
  it("extracts P0 from labels", () => {
    expect(extractPriorityNumber(null, ["P0", "bug"])).toBe(0);
  });

  it("extracts P1 from labels", () => {
    expect(extractPriorityNumber(null, ["enhancement", "P1"])).toBe(1);
  });

  it("extracts P2 from labels", () => {
    expect(extractPriorityNumber(null, ["P2"])).toBe(2);
  });

  it("extracts priority:critical from labels", () => {
    expect(extractPriorityNumber(null, ["priority:critical"])).toBe(0);
  });

  it("extracts priority:high from labels", () => {
    expect(extractPriorityNumber(null, ["priority:high"])).toBe(1);
  });

  it("extracts priority:medium from labels", () => {
    expect(extractPriorityNumber(null, ["priority:medium"])).toBe(2);
  });

  it("extracts priority:low from labels", () => {
    expect(extractPriorityNumber(null, ["priority:low"])).toBe(3);
  });

  it("parses numeric priority field directly", () => {
    expect(extractPriorityNumber("2", [])).toBe(2);
  });

  it("returns Infinity for null priority and no matching labels", () => {
    expect(extractPriorityNumber(null, ["bug", "enhancement"])).toBe(Infinity);
  });
});

describe("sortCandidates", () => {
  it("sorts by priority ascending (P0 before P1 before P2)", () => {
    const issues = [
      makeIssue({ id: "p2", labels: ["P2"], created_at: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "p0", labels: ["P0"], created_at: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "p1", labels: ["P1"], created_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortCandidates(issues);
    expect(sorted.map((i) => i.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("uses created_at as tiebreaker (oldest first)", () => {
    const issues = [
      makeIssue({ id: "newer", labels: ["P1"], created_at: "2026-02-01T00:00:00Z" }),
      makeIssue({ id: "older", labels: ["P1"], created_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortCandidates(issues);
    expect(sorted.map((i) => i.id)).toEqual(["older", "newer"]);
  });

  it("uses identifier as final tiebreaker", () => {
    const issues = [
      makeIssue({ id: "1", identifier: "GH-2", labels: ["P1"], created_at: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "2", identifier: "GH-1", labels: ["P1"], created_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortCandidates(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["GH-1", "GH-2"]);
  });

  it("treats null priority as lowest (sorted last)", () => {
    const issues = [
      makeIssue({ id: "none", priority: null, labels: [], created_at: "2026-01-01T00:00:00Z" }),
      makeIssue({ id: "p1", labels: ["P1"], created_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortCandidates(issues);
    expect(sorted.map((i) => i.id)).toEqual(["p1", "none"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortCandidates([])).toEqual([]);
  });
});

describe("dispatchIssue", () => {
  let state: OrchestratorState;
  let tracker: ReturnType<typeof makeTracker>;
  let config: ForgectlConfig;
  let logger: ReturnType<typeof makeLogger>;
  let workspaceManager: WorkspaceManager;
  let metrics: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createState();
    tracker = makeTracker();
    config = makeConfig();
    logger = makeLogger();
    workspaceManager = {} as unknown as WorkspaceManager;
    metrics = new MetricsCollector();
  });

  it("returns immediately if issue is already claimed", () => {
    const issue = makeIssue({ id: "a" });
    claimIssue(state, "a");
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);
    expect(executeWorker).not.toHaveBeenCalled();
  });

  it("claims the issue on dispatch", () => {
    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);
    expect(state.claimed.has("a")).toBe(true);
  });

  it("calls updateLabels with in_progress_label (best-effort)", () => {
    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);
    expect(tracker.updateLabels).toHaveBeenCalledWith("a", ["in-progress"], []);
  });

  it("adds WorkerInfo to running Map", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "done",
    });

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(executeWorker).toHaveBeenCalled();
    });
  });

  it("posts comment after worker completes", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "Agent completed",
    });
    vi.mocked(classifyFailure).mockReturnValue("continuation");

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(tracker.postComment).toHaveBeenCalledWith("a", "Agent completed");
    });
  });

  it("releases issue immediately on continuation (completed)", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "done",
    });
    vi.mocked(classifyFailure).mockReturnValue("continuation");

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(state.claimed.has("a")).toBe(false);
    });

    // scheduleRetry should NOT be called for continuation path
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("releases issue on max retries exhausted", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "failed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "failed",
    });
    vi.mocked(classifyFailure).mockReturnValue("error");

    // Set retry attempts to max
    state.retryAttempts.set("a", 5);

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(state.claimed.has("a")).toBe(false);
    });
  });

  it("removes in_progress label on max retries exhausted", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "failed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "failed",
    });
    vi.mocked(classifyFailure).mockReturnValue("error");

    state.retryAttempts.set("a", 5);

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(tracker.updateLabels).toHaveBeenCalledWith("a", [], ["in-progress"]);
    });
  });

  it("schedules error retry with backoff when retries remain", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "failed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "failed",
    });
    vi.mocked(classifyFailure).mockReturnValue("error");
    vi.mocked(calculateBackoff).mockReturnValue(20000);

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(scheduleRetry).toHaveBeenCalledWith(
        "a",
        20000,
        expect.any(Function),
        state,
        undefined,
      );
    });
  });

  it("calls tracker.updateState('closed') when auto_close=true and agent completed", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "done",
    });
    vi.mocked(classifyFailure).mockReturnValue("continuation");

    const configWithAutoClose = makeConfig();
    (configWithAutoClose.tracker as any).auto_close = true;

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, configWithAutoClose, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(tracker.updateState).toHaveBeenCalledWith("a", "closed");
    });
  });

  it("calls tracker.updateLabels with done_label when configured and agent completed", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "done",
    });
    vi.mocked(classifyFailure).mockReturnValue("continuation");

    const configWithDoneLabel = makeConfig();
    (configWithDoneLabel.tracker as any).done_label = "done";

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, configWithDoneLabel, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(tracker.updateLabels).toHaveBeenCalledWith("a", ["done"], ["in-progress"]);
    });
  });

  it("does NOT auto-close on agent failure", async () => {
    vi.mocked(executeWorker).mockResolvedValue({
      agentResult: { status: "failed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 100, turnCount: 1, stdout: "", stderr: "" },
      comment: "failed",
    });
    vi.mocked(classifyFailure).mockReturnValue("error");

    const configWithAutoClose = makeConfig();
    (configWithAutoClose.tracker as any).auto_close = true;
    (configWithAutoClose.tracker as any).done_label = "done";

    const issue = makeIssue({ id: "a" });
    dispatchIssue(issue, state, tracker, configWithAutoClose, workspaceManager, "prompt", logger, metrics);

    await vi.waitFor(() => {
      expect(tracker.postComment).toHaveBeenCalled();
    });

    // Give time for any async calls to complete
    await new Promise(r => setTimeout(r, 50));
    expect(tracker.updateState).not.toHaveBeenCalledWith("a", "closed");
  });
});
