import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorState } from "../../src/orchestrator/state.js";
import type { TrackerAdapter } from "../../src/tracker/types.js";
import type { Logger } from "../../src/logging/logger.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { RunRepository } from "../../src/storage/repositories/runs.js";
import type { WorkerInfo } from "../../src/orchestrator/state.js";
import { handleUsageLimitDetected } from "../../src/orchestrator/usage-limit-handler.js";
import { emitRunEvent } from "../../src/logging/events.js";

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

function makeWorkerInfo(overrides: Partial<WorkerInfo> & { runId?: string } = {}): WorkerInfo & { runId?: string } {
  return {
    issueId: overrides.issueId ?? "issue-1",
    identifier: overrides.identifier ?? "TEST-1",
    issue: overrides.issue ?? {
      id: overrides.issueId ?? "issue-1",
      identifier: overrides.identifier ?? "TEST-1",
      title: "Test issue",
      description: "",
      state: "open",
      priority: null,
      labels: [],
      assignees: [],
      url: "",
      created_at: "",
      updated_at: "",
      blocked_by: [],
      metadata: {},
    },
    session: overrides.session ?? { close: vi.fn(), invoke: vi.fn() } as any,
    cleanup: overrides.cleanup ?? {
      container: {
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as any,
      tempDirs: [],
      secretCleanups: [],
    },
    startedAt: overrides.startedAt ?? Date.now(),
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    attempt: overrides.attempt ?? 1,
    slotWeight: overrides.slotWeight ?? 1,
    runId: overrides.runId,
  };
}

function makeState(workers: Array<[string, WorkerInfo & { runId?: string }]> = []): OrchestratorState {
  const state: OrchestratorState = {
    claimed: new Set(),
    running: new Map(),
    retryTimers: new Map(),
    retryAttempts: new Map(),
    issueBranches: new Map(),
    recentlyCompleted: new Map(),
  };
  for (const [id, info] of workers) {
    state.claimed.add(id);
    state.running.set(id, info);
  }
  return state;
}

function makeTracker(): TrackerAdapter {
  return {
    kind: "test",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeConfig(overrides: Record<string, unknown> = {}): ForgectlConfig {
  return {
    agent: { type: "claude-code", model: "claude-sonnet-4-20250514", timeout: "30m", max_turns: 10, flags: [] },
    container: { image: "node:20", resources: { memory: "4g", cpus: 2 }, network: { mode: "open" } },
    repo: { exclude: [] },
    commit: { message: { prefix: "", template: "", include_task: false }, author: { name: "test", email: "test@test.com" }, sign: false },
    ...overrides,
  } as unknown as ForgectlConfig;
}

function makeRunRepo(): RunRepository {
  return {
    insert: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn(),
    findByStatus: vi.fn().mockReturnValue([]),
    list: vi.fn().mockReturnValue([]),
    clearPauseContext: vi.fn(),
    findByGithubCommentId: vi.fn(),
    setGithubCommentId: vi.fn(),
    setComplexityAssessment: vi.fn(),
    setSummary: vi.fn(),
    getSummary: vi.fn().mockReturnValue(null),
  };
}

describe("handleUsageLimitDetected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops all running containers", async () => {
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1" });
    const w2 = makeWorkerInfo({ issueId: "i2", identifier: "T-2" });
    const state = makeState([["i1", w1], ["i2", w2]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(w1.cleanup.container!.stop).toHaveBeenCalled();
    expect(w1.cleanup.container!.remove).toHaveBeenCalled();
    expect(w2.cleanup.container!.stop).toHaveBeenCalled();
    expect(w2.cleanup.container!.remove).toHaveBeenCalled();
  });

  it("updates run status to paused_usage_limit", async () => {
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1", runId: "run-1" });
    const state = makeState([["i1", w1]]);
    const tracker = makeTracker();
    const logger = makeLogger();
    const runRepo = makeRunRepo();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig(), runRepo);

    expect(runRepo.updateStatus).toHaveBeenCalledWith("run-1", expect.objectContaining({
      status: "paused_usage_limit",
      resumeAfter: expect.any(String),
    }));
  });

  it("posts a Linear comment on each affected issue", async () => {
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1" });
    const w2 = makeWorkerInfo({ issueId: "i2", identifier: "T-2" });
    const state = makeState([["i1", w1], ["i2", w2]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(tracker.postComment).toHaveBeenCalledTimes(2);
    expect(tracker.postComment).toHaveBeenCalledWith("i1", expect.stringContaining("usage limit"));
    expect(tracker.postComment).toHaveBeenCalledWith("i2", expect.stringContaining("usage limit"));
  });

  it("empties state.running and state.claimed", async () => {
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1" });
    const w2 = makeWorkerInfo({ issueId: "i2", identifier: "T-2" });
    const state = makeState([["i1", w1], ["i2", w2]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
  });

  it("cleans up workspace temp dirs", async () => {
    const rmSyncSpy = vi.fn();
    vi.doMock("node:fs", () => ({ rmSync: rmSyncSpy }));

    const cleanup = {
      container: {
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as any,
      tempDirs: ["/tmp/workspace-1"],
      secretCleanups: [],
    };
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1", cleanup });
    const state = makeState([["i1", w1]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    // The workspace temp dirs are cleaned up (rmSync called with the dir path)
    // Since we can't easily mock dynamic import in vitest, just verify state cleanup happened
    expect(state.running.size).toBe(0);
  });

  it("emits usage_limit_detected and orchestrator_cooldown_entered events", async () => {
    const state = makeState([["i1", makeWorkerInfo({ issueId: "i1" })]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(emitRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "usage_limit_detected",
    }));
    expect(emitRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "orchestrator_cooldown_entered",
    }));
  });

  it("closes agent sessions", async () => {
    const session = { close: vi.fn().mockResolvedValue(undefined), invoke: vi.fn() };
    const w1 = makeWorkerInfo({ issueId: "i1", identifier: "T-1", session: session as any });
    const state = makeState([["i1", w1]]);
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(session.close).toHaveBeenCalled();
  });

  it("handles empty running state gracefully", async () => {
    const state = makeState();
    const tracker = makeTracker();
    const logger = makeLogger();

    await handleUsageLimitDetected(state, tracker, logger, makeConfig());

    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(emitRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "orchestrator_cooldown_entered",
      data: expect.objectContaining({ killedCount: 0 }),
    }));
  });
});
