/**
 * Cross-phase integration test: verifies that the dispatcher passes the correct
 * number-based issue.id (not GitHub's internal ID) to all tracker mutation methods,
 * and that the reconciler passes number-based ids to fetchIssueStatesByIds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { Logger } from "../../src/logging/logger.js";
import { createState, type OrchestratorState, type WorkerInfo } from "../../src/orchestrator/state.js";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";

// Mock worker module
vi.mock("../../src/orchestrator/worker.js", () => ({
  executeWorker: vi.fn(),
}));

// Mock retry module
vi.mock("../../src/orchestrator/retry.js", () => ({
  classifyFailure: vi.fn().mockReturnValue("continuation"),
  calculateBackoff: vi.fn().mockReturnValue(10000),
  scheduleRetry: vi.fn(),
  cancelRetry: vi.fn(),
}));

// Mock events
vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
  runEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

// Mock triage module
vi.mock("../../src/orchestrator/triage.js", () => ({
  triageIssue: vi.fn().mockResolvedValue({ shouldDispatch: true, reason: "triage disabled" }),
}));

// Mock cleanup
vi.mock("../../src/container/cleanup.js", () => ({
  cleanupRun: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchIssue } from "../../src/orchestrator/dispatcher.js";
import { reconcile } from "../../src/orchestrator/reconciler.js";
import { executeWorker } from "../../src/orchestrator/worker.js";

function makeTracker(): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map([["42", "open"]])),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrackerAdapter;
}

function makeIssue(): TrackerIssue {
  return {
    id: "42",
    identifier: "#42",
    title: "Fix login bug",
    description: "Users cannot login",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "https://github.com/org/repo/issues/42",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
  };
}

function makeConfig(): ForgectlConfig {
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
    },
    tracker: {
      kind: "github",
      token: "test-token",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 30000,
      auto_close: true,
      done_label: "done",
    },
  } as unknown as ForgectlConfig;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("Cross-phase ID correctness", () => {
  let state: OrchestratorState;
  let tracker: ReturnType<typeof makeTracker>;
  let config: ForgectlConfig;
  let logger: Logger;
  let metrics: MetricsCollector;
  let workspaceManager: WorkspaceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createState();
    tracker = makeTracker();
    config = makeConfig();
    logger = makeLogger();
    metrics = new MetricsCollector();
    workspaceManager = {} as unknown as WorkspaceManager;
  });

  describe("Dispatcher passes number-based issue.id to tracker mutations", () => {
    it("updateLabels receives issue number '42' for in_progress label", async () => {
      const issue = makeIssue();
      await dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

      expect(tracker.updateLabels).toHaveBeenCalledWith("42", ["in-progress"], []);
    });

    it("postComment receives issue number '42' after worker completes", async () => {
      vi.mocked(executeWorker).mockResolvedValue({
        agentResult: {
          status: "completed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs: 100,
          turnCount: 1,
          stdout: "",
          stderr: "",
        },
        comment: "Agent completed task",
      });

      const issue = makeIssue();
      dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.postComment).toHaveBeenCalledWith("42", "Agent completed task");
      });
    });

    it("updateState receives issue number '42' for auto-close", async () => {
      vi.mocked(executeWorker).mockResolvedValue({
        agentResult: {
          status: "completed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs: 100,
          turnCount: 1,
          stdout: "",
          stderr: "",
        },
        comment: "done",
      });

      const issue = makeIssue();
      dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.updateState).toHaveBeenCalledWith("42", "closed");
      });
    });

    it("updateLabels receives issue number '42' for done label", async () => {
      vi.mocked(executeWorker).mockResolvedValue({
        agentResult: {
          status: "completed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs: 100,
          turnCount: 1,
          stdout: "",
          stderr: "",
        },
        comment: "done",
      });

      const issue = makeIssue();
      dispatchIssue(issue, state, tracker, config, workspaceManager, "prompt", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.updateLabels).toHaveBeenCalledWith("42", ["done"], ["in-progress"]);
      });
    });
  });

  describe("Reconciler passes number-based ids to fetchIssueStatesByIds", () => {
    it("fetchIssueStatesByIds receives ['42'] for running worker", async () => {
      state.running.set("42", {
        issueId: "42",
        identifier: "#42",
        issue: makeIssue(),
        session: { close: vi.fn(async () => {}) } as any,
        cleanup: { tempDirs: [], secretCleanups: [] },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        attempt: 1,
      } as WorkerInfo);
      state.claimed.add("42");

      await reconcile(state, tracker, workspaceManager as any, config, logger);

      expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledWith(["42"]);
    });
  });
});
