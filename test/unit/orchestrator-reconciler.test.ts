import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerAdapter } from "../../src/tracker/types.js";
import type { OrchestratorState, WorkerInfo } from "../../src/orchestrator/state.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { Logger } from "../../src/logging/logger.js";
import type { AgentSession } from "../../src/agent/session.js";
import type { CleanupContext } from "../../src/container/cleanup.js";
import { createState } from "../../src/orchestrator/state.js";

// Mock cleanup module
vi.mock("../../src/container/cleanup.js", () => ({
  cleanupRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock retry module
vi.mock("../../src/orchestrator/retry.js", () => ({
  scheduleRetry: vi.fn(),
  calculateBackoff: vi.fn().mockReturnValue(10000),
}));

import { reconcile } from "../../src/orchestrator/reconciler.js";
import { cleanupRun } from "../../src/container/cleanup.js";
import { scheduleRetry, calculateBackoff } from "../../src/orchestrator/retry.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeTracker(stateMap?: Map<string, string>): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(stateMap ?? new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrackerAdapter;
}

function makeSession(): AgentSession {
  return {
    invoke: vi.fn(),
    isAlive: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

function makeCleanup(): CleanupContext {
  return { tempDirs: [], secretCleanups: [] };
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
      active_states: ["open", "in_progress"],
      terminal_states: ["closed", "done"],
      poll_interval_ms: 30000,
      auto_close: false,
    },
  } as unknown as ForgectlConfig;
}

function makeWorkerInfo(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    issueId: "1",
    identifier: "#1",
    issue: {
      id: "1",
      identifier: "#1",
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
    },
    session: makeSession(),
    cleanup: makeCleanup(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    attempt: 1,
    ...overrides,
  };
}

function makeWorkspaceManager(): WorkspaceManager {
  return {
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceManager;
}

describe("reconcile", () => {
  let state: OrchestratorState;
  let logger: ReturnType<typeof makeLogger>;
  let config: ForgectlConfig;
  let workspaceManager: ReturnType<typeof makeWorkspaceManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createState();
    logger = makeLogger();
    config = makeConfig();
    workspaceManager = makeWorkspaceManager();
  });

  it("returns early when no workers are running", async () => {
    const tracker = makeTracker();
    await reconcile(state, tracker, workspaceManager, config, logger);
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("fetches states for all running issue IDs", async () => {
    const worker = makeWorkerInfo({ issueId: "a" });
    state.running.set("a", worker);
    state.claimed.add("a");

    const tracker = makeTracker(new Map([["a", "open"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledWith(["a"]);
  });

  it("cleans up terminal state issues", async () => {
    const session = makeSession();
    const cleanup = makeCleanup();
    const worker = makeWorkerInfo({ issueId: "a", session, cleanup });
    state.running.set("a", worker);
    state.claimed.add("a");

    const tracker = makeTracker(new Map([["a", "closed"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(session.close).toHaveBeenCalled();
    expect(cleanupRun).toHaveBeenCalledWith(cleanup);
    expect(workspaceManager.removeWorkspace).toHaveBeenCalledWith("#1");
    expect(state.running.has("a")).toBe(false);
    expect(state.claimed.has("a")).toBe(false);
  });

  it("cleans up non-active non-terminal state issues without workspace removal", async () => {
    const session = makeSession();
    const cleanup = makeCleanup();
    const worker = makeWorkerInfo({ issueId: "a", session, cleanup });
    state.running.set("a", worker);
    state.claimed.add("a");

    // "blocked" is neither active nor terminal
    const tracker = makeTracker(new Map([["a", "blocked"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(session.close).toHaveBeenCalled();
    expect(cleanupRun).toHaveBeenCalledWith(cleanup);
    expect(workspaceManager.removeWorkspace).not.toHaveBeenCalled();
    expect(state.running.has("a")).toBe(false);
    expect(state.claimed.has("a")).toBe(false);
  });

  it("updates issue state in-memory for active state issues", async () => {
    const worker = makeWorkerInfo({ issueId: "a" });
    worker.issue.state = "open";
    state.running.set("a", worker);
    state.claimed.add("a");

    const tracker = makeTracker(new Map([["a", "in_progress"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    // Worker should still be running
    expect(state.running.has("a")).toBe(true);
    // Issue state should be updated
    expect(state.running.get("a")!.issue.state).toBe("in_progress");
  });

  it("logs warning and keeps workers running on fetchIssueStatesByIds failure", async () => {
    const worker = makeWorkerInfo({ issueId: "a" });
    state.running.set("a", worker);
    state.claimed.add("a");

    const tracker = makeTracker();
    vi.mocked(tracker.fetchIssueStatesByIds).mockRejectedValue(new Error("network error"));

    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(logger.warn).toHaveBeenCalled();
    // Workers should still be running
    expect(state.running.has("a")).toBe(true);
    expect(state.claimed.has("a")).toBe(true);
  });

  it("detects stalled workers past stall_timeout_ms", async () => {
    const session = makeSession();
    const cleanup = makeCleanup();
    const stalledWorker = makeWorkerInfo({
      issueId: "a",
      session,
      cleanup,
      lastActivityAt: Date.now() - 700000, // 700s ago, past 600s timeout
    });
    state.running.set("a", stalledWorker);
    state.claimed.add("a");

    const tracker = makeTracker(new Map([["a", "open"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(session.close).toHaveBeenCalled();
    expect(cleanupRun).toHaveBeenCalledWith(cleanup);
    expect(state.running.has("a")).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("schedules error retry for stalled workers when retries remain", async () => {
    const session = makeSession();
    const cleanup = makeCleanup();
    const stalledWorker = makeWorkerInfo({
      issueId: "a",
      session,
      cleanup,
      lastActivityAt: Date.now() - 700000,
    });
    state.running.set("a", stalledWorker);
    state.claimed.add("a");

    const tracker = makeTracker(new Map([["a", "open"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(scheduleRetry).toHaveBeenCalledWith(
      "a",
      expect.any(Number),
      expect.any(Function),
      state,
    );
  });

  it("releases stalled workers when max retries exhausted", async () => {
    const session = makeSession();
    const cleanup = makeCleanup();
    const stalledWorker = makeWorkerInfo({
      issueId: "a",
      session,
      cleanup,
      lastActivityAt: Date.now() - 700000,
    });
    state.running.set("a", stalledWorker);
    state.claimed.add("a");
    state.retryAttempts.set("a", 5);

    const tracker = makeTracker(new Map([["a", "open"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    expect(state.claimed.has("a")).toBe(false);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("handles cleanup failure for one worker without affecting others", async () => {
    const session1 = makeSession();
    vi.mocked(session1.close).mockRejectedValue(new Error("close failed"));
    const worker1 = makeWorkerInfo({ issueId: "a", identifier: "#1", session: session1 });

    const session2 = makeSession();
    const worker2 = makeWorkerInfo({ issueId: "b", identifier: "#2", session: session2 });

    state.running.set("a", worker1);
    state.running.set("b", worker2);
    state.claimed.add("a");
    state.claimed.add("b");

    const tracker = makeTracker(new Map([["a", "closed"], ["b", "closed"]]));
    await reconcile(state, tracker, workspaceManager, config, logger);

    // Both should be attempted; second should succeed despite first failing
    expect(session2.close).toHaveBeenCalled();
  });
});
