import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { WorkerResult } from "../../src/orchestrator/worker.js";
import { createState, SlotManager, type OrchestratorState } from "../../src/orchestrator/state.js";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";
import type { Logger } from "../../src/logging/logger.js";

// Hoist shared mocks
const shared = vi.hoisted(() => ({
  executeWorkerMock: vi.fn(),
}));

// Mock executeWorker at module level
vi.mock("../../src/orchestrator/worker.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/orchestrator/worker.js")>();
  return {
    ...orig,
    executeWorker: shared.executeWorkerMock,
  };
});

// Mock emitRunEvent to silence SSE
vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
  runEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

// Import after mocks
import { dispatchIssue, filterCandidates, sortCandidates } from "../../src/orchestrator/dispatcher.js";
import { reconcile } from "../../src/orchestrator/reconciler.js";
import { classifyFailure, calculateBackoff } from "../../src/orchestrator/retry.js";

// Helper: create a mock TrackerIssue
function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "GH-1",
    title: overrides.title ?? "Fix the bug",
    description: overrides.description ?? "Detailed description",
    state: overrides.state ?? "open",
    priority: overrides.priority ?? null,
    labels: overrides.labels ?? ["forgectl"],
    assignees: overrides.assignees ?? [],
    url: overrides.url ?? "https://github.com/org/repo/issues/1",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
    blocked_by: overrides.blocked_by ?? [],
  };
}

// Helper: create a mock TrackerAdapter that records calls
function makeTracker(): TrackerAdapter & {
  calls: {
    postComment: Array<{ issueId: string; body: string }>;
    updateState: Array<{ issueId: string; state: string }>;
    updateLabels: Array<{ issueId: string; add: string[]; remove: string[] }>;
  };
  issueStates: Map<string, string>;
  candidateIssues: TrackerIssue[];
} {
  const calls = {
    postComment: [] as Array<{ issueId: string; body: string }>,
    updateState: [] as Array<{ issueId: string; state: string }>,
    updateLabels: [] as Array<{ issueId: string; add: string[]; remove: string[] }>,
  };
  const issueStates = new Map<string, string>();
  const candidateIssues: TrackerIssue[] = [];

  return {
    calls,
    issueStates,
    candidateIssues,
    fetchCandidateIssues: vi.fn(async () => candidateIssues),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => {
      const result = new Map<string, string>();
      for (const id of ids) {
        const state = issueStates.get(id);
        if (state) result.set(id, state);
      }
      return result;
    }),
    fetchIssuesByStates: vi.fn(async () => []),
    postComment: vi.fn(async (issueId: string, body: string) => {
      calls.postComment.push({ issueId, body });
    }),
    updateState: vi.fn(async (issueId: string, state: string) => {
      calls.updateState.push({ issueId, state });
    }),
    updateLabels: vi.fn(async (issueId: string, add: string[], remove: string[]) => {
      calls.updateLabels.push({ issueId, add, remove });
    }),
  };
}

// Helper: create a mock WorkspaceManager
function makeWorkspaceManager(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn(async () => ({ path: "/tmp/workspace", created: false })),
    removeWorkspace: vi.fn(async () => {}),
    cleanupTerminalWorkspaces: vi.fn(async () => {}),
    runBeforeHook: vi.fn(async () => {}),
    runAfterHook: vi.fn(async () => {}),
  } as unknown as WorkspaceManager;
}

// Helper: create a minimal ForgectlConfig
function makeConfig(overrides: {
  maxAgents?: number;
  maxRetries?: number;
  autoClose?: boolean;
  doneLabel?: string;
} = {}): ForgectlConfig {
  return {
    agent: { type: "claude-code", model: "", max_turns: 50, timeout: "30m", flags: [] },
    container: {
      image: "node:20",
      network: { mode: "open" },
      resources: { memory: "4g", cpus: 2 },
    },
    repo: {
      branch: { template: "forge/{{slug}}/{{ts}}", base: "main" },
      exclude: [],
    },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    orchestrator: {
      enabled: true,
      max_concurrent_agents: overrides.maxAgents ?? 2,
      poll_interval_ms: 5000,
      stall_timeout_ms: 600000,
      max_retries: overrides.maxRetries ?? 3,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 100,
      in_progress_label: "in-progress",
    },
    tracker: {
      kind: "github",
      token: "test-token",
      active_states: ["open", "in_progress"],
      terminal_states: ["closed", "done"],
      poll_interval_ms: 60000,
      auto_close: overrides.autoClose ?? false,
      repo: "org/repo",
      done_label: overrides.doneLabel,
    },
    board: {
      state_dir: "~/.forgectl/board",
      scheduler_tick_seconds: 30,
      max_concurrent_card_runs: 2,
    },
  } as ForgectlConfig;
}

// Helper: create a mock Logger
function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Logger;
}

// Helper: make a successful WorkerResult
function makeSuccessResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    agentResult: {
      stdout: "Done",
      stderr: "",
      status: "completed",
      tokenUsage: { input: 1000, output: 500, total: 1500 },
      durationMs: 5000,
      turnCount: 3,
    },
    comment: "## forgectl Agent Report\n\n**Status:** Pass\n**Branch:** `forge/fix/123`",
    validationResult: {
      passed: true,
      totalAttempts: 1,
      stepResults: [{ name: "lint", passed: true, command: "npm run lint", output: "", attempts: 1 }],
    },
    branch: "forge/fix/123",
    ...overrides,
  };
}

// Helper: make a failed WorkerResult
function makeFailedResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    agentResult: {
      stdout: "",
      stderr: "Agent crashed",
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 1000,
      turnCount: 0,
    },
    comment: "## forgectl Agent Report\n\n**Status:** Fail",
    ...overrides,
  };
}

describe("E2E Orchestration", () => {
  let state: OrchestratorState;
  let tracker: ReturnType<typeof makeTracker>;
  let config: ForgectlConfig;
  let workspaceManager: WorkspaceManager;
  let logger: Logger;
  let metrics: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createState();
    tracker = makeTracker();
    workspaceManager = makeWorkspaceManager();
    logger = makeLogger();
    metrics = new MetricsCollector();
  });

  describe("Happy path: dispatch -> validate -> comment -> auto-close", () => {
    it("posts comment with validation results and branch after successful worker", async () => {
      config = makeConfig({ autoClose: true, doneLabel: "done" });
      const issue = makeIssue();
      const successResult = makeSuccessResult();

      shared.executeWorkerMock.mockResolvedValueOnce(successResult);

      // Dispatch the issue
      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      // Issue should be claimed and running
      expect(state.claimed.has("issue-1")).toBe(true);

      // Wait for the async worker to complete
      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      // Comment should contain the worker's comment
      expect(tracker.calls.postComment[0].issueId).toBe("issue-1");
      expect(tracker.calls.postComment[0].body).toContain("forgectl Agent Report");
    });

    it("auto-closes the issue and adds done label on success", async () => {
      config = makeConfig({ autoClose: true, doneLabel: "done" });
      const issue = makeIssue();

      shared.executeWorkerMock.mockResolvedValueOnce(makeSuccessResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      // Wait for auto-close and done label
      await vi.waitFor(() => {
        expect(tracker.calls.updateState.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      expect(tracker.calls.updateState[0]).toEqual({ issueId: "issue-1", state: "closed" });

      await vi.waitFor(() => {
        expect(tracker.calls.updateLabels.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 2000 });

      // First updateLabels is adding in_progress, second is adding done + removing in-progress
      const doneLabel = tracker.calls.updateLabels.find(
        (c) => c.add.includes("done"),
      );
      expect(doneLabel).toBeDefined();
      expect(doneLabel!.remove).toContain("in-progress");
    });

    it("does not auto-close when auto_close is false", async () => {
      config = makeConfig({ autoClose: false });
      const issue = makeIssue();

      shared.executeWorkerMock.mockResolvedValueOnce(makeSuccessResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      // Give time for any potential auto-close (should not happen)
      await new Promise((r) => setTimeout(r, 100));

      expect(tracker.calls.updateState).toHaveLength(0);
    });

    it("records completion metrics on success", async () => {
      config = makeConfig({ autoClose: true, doneLabel: "done" });
      const issue = makeIssue();

      shared.executeWorkerMock.mockResolvedValueOnce(makeSuccessResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      // Metrics should show completion
      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.dispatched).toBe(1);
      // completed gets recorded as 'completed' via classifyFailure returning 'continuation'
      expect(snapshot.totals.completed).toBe(1);
    });
  });

  describe("Agent failure with retry and backoff", () => {
    it("retries on agent failure up to max_retries", async () => {
      config = makeConfig({ maxRetries: 3 });
      const issue = makeIssue();

      // First call fails, triggers retry
      shared.executeWorkerMock.mockResolvedValueOnce(makeFailedResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      // After failure: retry attempt recorded, retryTimers should have an entry
      // The state.retryAttempts should be incremented
      expect(state.retryAttempts.get("issue-1")).toBe(1);

      // A retry timer should be scheduled (issue released after delay)
      expect(state.retryTimers.has("issue-1")).toBe(true);
    });

    it("exhausts retries and releases issue after max_retries", async () => {
      config = makeConfig({ maxRetries: 2 });
      const issue = makeIssue();

      // Pre-set retry attempts to max - 1 (so next failure exhausts)
      state.retryAttempts.set("issue-1", 1);

      shared.executeWorkerMock.mockResolvedValueOnce(makeFailedResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 2000 });

      // Should have posted exhaustion comment
      const exhaustionComment = tracker.calls.postComment.find(
        (c) => c.body.includes("Max retries"),
      );
      expect(exhaustionComment).toBeDefined();

      // Issue should be fully released
      expect(state.claimed.has("issue-1")).toBe(false);
      expect(state.retryAttempts.has("issue-1")).toBe(false);
    });

    it("uses exponential backoff for retry delays", () => {
      // Verify backoff calculation
      expect(calculateBackoff(1, 300000)).toBe(10000);      // 10s
      expect(calculateBackoff(2, 300000)).toBe(20000);      // 20s
      expect(calculateBackoff(3, 300000)).toBe(40000);      // 40s
      expect(calculateBackoff(4, 300000)).toBe(80000);      // 80s
      expect(calculateBackoff(10, 300000)).toBe(300000);    // capped at max
    });

    it("classifies completed as continuation and failed as error", () => {
      expect(classifyFailure("completed")).toBe("continuation");
      expect(classifyFailure("failed")).toBe("error");
      expect(classifyFailure("timeout")).toBe("error");
    });
  });

  describe("Issue closed during run (reconciler)", () => {
    it("removes worker when issue reaches terminal state", async () => {
      config = makeConfig();
      const issue = makeIssue({ id: "issue-2", identifier: "GH-2" });

      // Put worker in running map (simulating active dispatch)
      state.claimed.add("issue-2");
      state.running.set("issue-2", {
        issueId: "issue-2",
        identifier: "GH-2",
        issue,
        session: { close: vi.fn(async () => {}) } as any,
        cleanup: { tempDirs: [], secretCleanups: [] },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        attempt: 1,
      });

      // Tracker reports issue as "closed" (terminal)
      tracker.issueStates.set("issue-2", "closed");

      await reconcile(state, tracker, workspaceManager, config, logger);

      // Worker should be removed from running and claim released
      expect(state.running.has("issue-2")).toBe(false);
      expect(state.claimed.has("issue-2")).toBe(false);
    });

    it("removes worker when issue is in non-active state", async () => {
      config = makeConfig();
      const issue = makeIssue({ id: "issue-3", identifier: "GH-3" });

      state.claimed.add("issue-3");
      state.running.set("issue-3", {
        issueId: "issue-3",
        identifier: "GH-3",
        issue,
        session: { close: vi.fn(async () => {}) } as any,
        cleanup: { tempDirs: [], secretCleanups: [] },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        attempt: 1,
      });

      // Tracker reports issue in non-active, non-terminal state (e.g., "review")
      tracker.issueStates.set("issue-3", "review");

      await reconcile(state, tracker, workspaceManager, config, logger);

      // Worker should be stopped and released
      expect(state.running.has("issue-3")).toBe(false);
      expect(state.claimed.has("issue-3")).toBe(false);
    });

    it("keeps worker running when issue is still active", async () => {
      config = makeConfig();
      const issue = makeIssue({ id: "issue-4", identifier: "GH-4" });

      state.claimed.add("issue-4");
      state.running.set("issue-4", {
        issueId: "issue-4",
        identifier: "GH-4",
        issue,
        session: { close: vi.fn(async () => {}) } as any,
        cleanup: { tempDirs: [], secretCleanups: [] },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        attempt: 1,
      });

      // Tracker reports issue still "open" (active state)
      tracker.issueStates.set("issue-4", "open");

      await reconcile(state, tracker, workspaceManager, config, logger);

      // Worker should still be running
      expect(state.running.has("issue-4")).toBe(true);
      expect(state.claimed.has("issue-4")).toBe(true);
    });
  });

  describe("Concurrent dispatch respects slot limits", () => {
    it("only dispatches up to available slots", () => {
      config = makeConfig({ maxAgents: 2 });
      const slotManager = new SlotManager(2);

      const issues = [
        makeIssue({ id: "issue-a", identifier: "GH-A", created_at: "2026-01-01T00:00:00Z" }),
        makeIssue({ id: "issue-b", identifier: "GH-B", created_at: "2026-01-02T00:00:00Z" }),
        makeIssue({ id: "issue-c", identifier: "GH-C", created_at: "2026-01-03T00:00:00Z" }),
      ];

      // All three are candidates
      const eligible = filterCandidates(issues, state, new Set());
      expect(eligible).toHaveLength(3);

      const sorted = sortCandidates(eligible);
      const available = slotManager.availableSlots(state.running);
      expect(available).toBe(2);

      // Mock executeWorker to never resolve (simulating long-running work)
      shared.executeWorkerMock.mockReturnValue(new Promise(() => {}));

      // Dispatch up to slot limit
      for (const issue of sorted.slice(0, available)) {
        dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      }

      // Only 2 should be claimed and running
      expect(state.claimed.size).toBe(2);
      expect(state.running.size).toBe(2);
      expect(state.claimed.has("issue-a")).toBe(true);
      expect(state.claimed.has("issue-b")).toBe(true);
      expect(state.claimed.has("issue-c")).toBe(false);
    });

    it("dispatches waiting issue after a slot opens", async () => {
      config = makeConfig({ maxAgents: 2 });
      const slotManager = new SlotManager(2);

      const issues = [
        makeIssue({ id: "issue-a", identifier: "GH-A", created_at: "2026-01-01T00:00:00Z" }),
        makeIssue({ id: "issue-b", identifier: "GH-B", created_at: "2026-01-02T00:00:00Z" }),
        makeIssue({ id: "issue-c", identifier: "GH-C", created_at: "2026-01-03T00:00:00Z" }),
      ];

      // First dispatch: issue-a completes quickly, issue-b stays running
      shared.executeWorkerMock
        .mockResolvedValueOnce(makeSuccessResult()) // issue-a
        .mockReturnValueOnce(new Promise(() => {})); // issue-b hangs

      // Dispatch first two
      const firstBatch = issues.slice(0, 2);
      for (const issue of firstBatch) {
        dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      }

      expect(state.claimed.size).toBe(2);

      // Wait for issue-a to complete (releases from running map, but claim stays via continuation)
      await vi.waitFor(() => {
        expect(state.running.has("issue-a")).toBe(false);
      }, { timeout: 2000 });

      // Now 1 slot available, issue-c can be dispatched
      const available = slotManager.availableSlots(state.running);
      expect(available).toBeGreaterThanOrEqual(1);

      shared.executeWorkerMock.mockReturnValueOnce(new Promise(() => {}));
      const remainingCandidates = filterCandidates([issues[2]], state, new Set());
      expect(remainingCandidates).toHaveLength(1);

      dispatchIssue(issues[2], state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      expect(state.claimed.has("issue-c")).toBe(true);
    });

    it("filters out already claimed and running issues", () => {
      const issues = [
        makeIssue({ id: "issue-x", identifier: "GH-X" }),
        makeIssue({ id: "issue-y", identifier: "GH-Y" }),
        makeIssue({ id: "issue-z", identifier: "GH-Z" }),
      ];

      // Claim issue-x and add issue-y to running
      state.claimed.add("issue-x");
      state.running.set("issue-y", {} as any);

      const eligible = filterCandidates(issues, state, new Set());
      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe("issue-z");
    });

    it("filters out blocked issues when blockers are not terminal", () => {
      const issues = [
        makeIssue({ id: "issue-blocked", identifier: "GH-BLOCKED", blocked_by: ["issue-blocker"] }),
        makeIssue({ id: "issue-free", identifier: "GH-FREE" }),
      ];

      // No terminal IDs means blocker is not terminal
      const eligible = filterCandidates(issues, state, new Set());
      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe("issue-free");

      // With blocker in terminal set, blocked issue becomes eligible
      const eligibleWithTerminal = filterCandidates(issues, state, new Set(["issue-blocker"]));
      expect(eligibleWithTerminal).toHaveLength(2);
    });
  });

  describe("Priority sorting", () => {
    it("sorts by priority ascending, then by created_at", () => {
      const issues = [
        makeIssue({ id: "low", identifier: "GH-LOW", priority: "3", created_at: "2026-01-01T00:00:00Z" }),
        makeIssue({ id: "high", identifier: "GH-HIGH", priority: "1", created_at: "2026-01-03T00:00:00Z" }),
        makeIssue({ id: "med", identifier: "GH-MED", priority: "2", created_at: "2026-01-02T00:00:00Z" }),
      ];

      const sorted = sortCandidates(issues);
      expect(sorted.map((i) => i.id)).toEqual(["high", "med", "low"]);
    });

    it("sorts issues without priority after those with priority", () => {
      const issues = [
        makeIssue({ id: "no-prio", identifier: "GH-NP", priority: null, created_at: "2026-01-01T00:00:00Z" }),
        makeIssue({ id: "has-prio", identifier: "GH-HP", priority: "1", created_at: "2026-01-02T00:00:00Z" }),
      ];

      const sorted = sortCandidates(issues);
      expect(sorted[0].id).toBe("has-prio");
      expect(sorted[1].id).toBe("no-prio");
    });
  });
});
