import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { OrchestratorState, WorkerInfo } from "../../src/orchestrator/state.js";
import type { AgentSession } from "../../src/agent/session.js";
import type { CleanupContext } from "../../src/container/cleanup.js";
import { Orchestrator } from "../../src/orchestrator/index.js";

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Test issue",
    description: "desc",
    state: "closed",
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

function makeTracker(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeWorkspaceManager(overrides: Partial<WorkspaceManager> = {}): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue({ path: "/tmp/ws", identifier: "issue-1", created: false }),
    runBeforeHook: vi.fn().mockResolvedValue(undefined),
    runAfterHook: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    cleanupTerminalWorkspaces: vi.fn().mockResolvedValue(undefined),
    getWorkspacePath: vi.fn().mockReturnValue("/tmp/ws"),
    ...overrides,
  } as unknown as WorkspaceManager;
}

function makeConfig(overrides: Partial<ForgectlConfig> = {}): ForgectlConfig {
  return {
    agent: { type: "claude-code", model: "", max_turns: 50, timeout: "30m", flags: [], usage_limit: { enabled: false } },
    container: {
      image: undefined,
      dockerfile: undefined,
      network: { mode: undefined, allow: undefined },
      resources: { memory: "4g", cpus: 2 },
    },
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: [] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
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
      poll_interval_ms: 60000,
      auto_close: false,
      repo: "owner/repo",
    },
    board: {
      state_dir: "~/.forgectl/board",
      scheduler_tick_seconds: 30,
      max_concurrent_card_runs: 2,
    },
    ...overrides,
  } as ForgectlConfig;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: false,
    entries: [],
    onEntry: vi.fn(),
  } as any;
}

describe("Orchestrator", () => {
  let tracker: TrackerAdapter;
  let workspaceManager: WorkspaceManager;
  let config: ForgectlConfig;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = makeTracker();
    workspaceManager = makeWorkspaceManager();
    config = makeConfig();
    logger = makeLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start()", () => {
    it("starts the scheduler after startup recovery", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      expect(orchestrator.isRunning()).toBe(true);
      // Log message should indicate started
      expect(logger.info).toHaveBeenCalledWith(
        "orchestrator",
        expect.stringContaining("started"),
      );
    });

    it("runs startup recovery that cleans terminal workspaces", async () => {
      const terminalIssues = [
        makeIssue({ identifier: "ISSUE-10", state: "closed" }),
        makeIssue({ identifier: "ISSUE-20", state: "closed" }),
      ];
      (tracker.fetchIssuesByStates as any).mockResolvedValue(terminalIssues);

      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      expect(tracker.fetchIssuesByStates).toHaveBeenCalledWith(["closed"]);
      expect(workspaceManager.cleanupTerminalWorkspaces).toHaveBeenCalledWith(
        ["ISSUE-10", "ISSUE-20"],
      );
    });

    it("startup recovery failure logs warning but does not prevent start", async () => {
      (tracker.fetchIssuesByStates as any).mockRejectedValue(new Error("network fail"));

      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      // Should still be running despite recovery failure
      expect(orchestrator.isRunning()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        "orchestrator",
        expect.stringContaining("recovery"),
      );
    });
  });

  describe("stop()", () => {
    it("sets running to false and clears retry timers", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();
      expect(orchestrator.isRunning()).toBe(true);

      await orchestrator.stop();
      expect(orchestrator.isRunning()).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        "orchestrator",
        expect.stringContaining("stopped"),
      );
    });

    it("releases all claims and removes in_progress labels", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      // Manually add claims to state for testing
      const state = orchestrator.getState();
      state.claimed.add("ISSUE-1");
      state.claimed.add("ISSUE-2");

      await orchestrator.stop();

      // Should have tried to remove in_progress labels for claimed issues
      expect(tracker.updateLabels).toHaveBeenCalledWith("ISSUE-1", [], ["in-progress"]);
      expect(tracker.updateLabels).toHaveBeenCalledWith("ISSUE-2", [], ["in-progress"]);
    });

    it("resolves cleanly even if label removal fails", async () => {
      (tracker.updateLabels as any).mockRejectedValue(new Error("API error"));

      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();
      const state = orchestrator.getState();
      state.claimed.add("ISSUE-1");

      // Should not throw
      await orchestrator.stop();
      expect(orchestrator.isRunning()).toBe(false);
    });

    it("drains running sessions with timeout and force-kills", async () => {
      const mockSession: AgentSession = {
        invoke: vi.fn().mockResolvedValue({ stdout: "", stderr: "", status: "completed", tokenUsage: { input: 0, output: 0, total: 0 }, durationMs: 0, turnCount: 0 }),
        close: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
        isActive: vi.fn().mockReturnValue(true),
      };

      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      // Add a running worker to state
      const state = orchestrator.getState();
      state.claimed.add("ISSUE-1");
      const workerInfo: WorkerInfo = {
        issueId: "ISSUE-1",
        identifier: "ISSUE-1",
        issue: makeIssue(),
        session: mockSession,
        cleanup: { tempDirs: [], secretCleanups: [] },
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        attempt: 1,
      };
      state.running.set("ISSUE-1", workerInfo);

      // Stop the orchestrator — session.close() will never resolve,
      // so drain timeout fires
      const stopPromise = orchestrator.stop();

      // Advance past drain timeout
      await vi.advanceTimersByTimeAsync(config.orchestrator.drain_timeout_ms + 100);

      await stopPromise;

      // Session close was attempted
      expect(mockSession.close).toHaveBeenCalled();
      // State should be cleared
      expect(state.claimed.size).toBe(0);
      expect(state.running.size).toBe(0);
    });

    it("clears all state on stop", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      const state = orchestrator.getState();
      state.claimed.add("ISSUE-1");
      state.retryAttempts.set("ISSUE-1", 3);

      await orchestrator.stop();

      expect(state.claimed.size).toBe(0);
      expect(state.running.size).toBe(0);
      expect(state.retryTimers.size).toBe(0);
      expect(state.retryAttempts.size).toBe(0);
    });
  });

  describe("isRunning()", () => {
    it("returns false before start", () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      expect(orchestrator.isRunning()).toBe(false);
    });

    it("returns true after start, false after stop", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();
      expect(orchestrator.isRunning()).toBe(true);

      await orchestrator.stop();
      expect(orchestrator.isRunning()).toBe(false);
    });
  });

  describe("getState()", () => {
    it("returns the current orchestrator state", async () => {
      const orchestrator = new Orchestrator({
        tracker,
        workspaceManager,
        config,
        promptTemplate: "Fix: {{issue.title}}",
        logger,
      });

      await orchestrator.start();

      const state = orchestrator.getState();
      expect(state).toBeDefined();
      expect(state.claimed).toBeInstanceOf(Set);
      expect(state.running).toBeInstanceOf(Map);
      expect(state.retryTimers).toBeInstanceOf(Map);
      expect(state.retryAttempts).toBeInstanceOf(Map);
    });
  });
});
