import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDatabase,
  closeDatabase,
  type AppDatabase,
} from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createRunRepository,
  type RunRepository,
} from "../../src/storage/repositories/runs.js";
import {
  UsageLimitRecovery,
  createUsageLimitRecovery,
  formatUsageLimitPausedComment,
  formatUsageLimitRestartedComment,
  formatUsageLimitFailedComment,
  type UsageLimitRecoveryConfig,
} from "../../src/orchestrator/usage-limit-recovery.js";
import {
  UsageLimitDetector,
  UsageLimitError,
  type DetectionResult,
} from "../../src/agent/usage-limit-detector.js";
import { createState, type OrchestratorState } from "../../src/orchestrator/state.js";
import type { TrackerAdapter } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/logger.js";
import { runEvents } from "../../src/logging/events.js";

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
  } as unknown as Logger;
}

function makeTracker(): TrackerAdapter & { postComment: ReturnType<typeof vi.fn> } {
  return {
    fetchIssues: vi.fn().mockResolvedValue([]),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrackerAdapter & { postComment: ReturnType<typeof vi.fn> };
}

function makeConfig(overrides?: Partial<ForgectlConfig>): ForgectlConfig {
  return {
    agent: {
      type: "claude-code",
      model: "",
      max_turns: 50,
      timeout: "30m",
      flags: [],
      usage_limit: {
        enabled: true,
        cooldown_minutes: 60,
        probe_enabled: true,
        probe_interval_minutes: 15,
        max_resumes: 3,
        detection_patterns: ["usage limit", "rate limit"],
        hang_timeout_ms: 300000,
      },
    },
    container: { image: undefined, dockerfile: undefined, network: { mode: undefined, allow: undefined }, resources: { memory: "4g", cpus: 2 } },
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: [] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: { message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true }, author: { name: "forgectl", email: "forge@localhost" }, sign: false },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    orchestrator: { enabled: false, max_concurrent_agents: 3, poll_interval_ms: 30000, stall_timeout_ms: 600000, max_retries: 5, max_retry_backoff_ms: 300000, drain_timeout_ms: 30000, continuation_delay_ms: 1000, in_progress_label: "in-progress", child_slots: 0, enable_triage: false, triage_max_complexity: 7 },
    storage: { db_path: "~/.forgectl/forgectl.db" },
    board: { state_dir: "~/.forgectl/board", scheduler_tick_seconds: 30, max_concurrent_card_runs: 2 },
    schedules: [],
    tracker: { kind: "linear", token: "test", team_ids: ["team-1"], active_states: ["open"], terminal_states: ["closed"], poll_interval_ms: 60000, auto_close: false, comments_enabled: true, comment_events: ["completed", "failed"] },
    ...overrides,
  } as unknown as ForgectlConfig;
}

function makeRecoveryConfig(overrides?: Partial<UsageLimitRecoveryConfig>): UsageLimitRecoveryConfig {
  return {
    cooldownMinutes: 60,
    probeEnabled: true,
    probeIntervalMinutes: 15,
    maxResumes: 3,
    ...overrides,
  };
}

function makeDetection(overrides?: Partial<DetectionResult>): DetectionResult {
  return {
    detected: true,
    reason: "pattern_match",
    matchedPattern: "rate limit",
    rawOutput: "Error: rate limit exceeded",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("UsageLimitRecovery", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;
  let logger: Logger;
  let tracker: ReturnType<typeof makeTracker>;
  let state: OrchestratorState;
  let config: ForgectlConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-ulr-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
    logger = makeLogger();
    tracker = makeTracker();
    state = createState();
    config = makeConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertRun(id: string, status: string) {
    runRepo.insert({ id, task: "test task", submittedAt: new Date().toISOString() });
    if (status !== "queued") {
      runRepo.updateStatus(id, { status });
    }
  }

  function addWorkerToState(issueId: string, identifier: string) {
    state.claimed.add(issueId);
    state.running.set(issueId, {
      issueId,
      identifier,
      issue: { id: issueId, identifier, title: "Test", description: "", status: "open", labels: [], blocked_by: [], priority: null, created_at: new Date().toISOString(), metadata: {} } as any,
      session: null,
      cleanup: { tempDirs: [], secretCleanups: [] },
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      attempt: 1,
      slotWeight: 1,
    });
  }

  describe("handleUsageLimitHit", () => {
    it("pauses all running tasks and starts cooldown", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());
      insertRun("issue-1", "running");
      insertRun("issue-2", "running");
      addWorkerToState("issue-1", "PROJ-1");
      addWorkerToState("issue-2", "PROJ-2");

      const detection = makeDetection();
      await recovery.handleUsageLimitHit(detection, "issue-1", state, tracker, config, runRepo);

      // Both should be removed from running
      expect(state.running.size).toBe(0);

      // Both should be in paused state in DB
      const run1 = runRepo.findById("issue-1")!;
      expect(run1.status).toBe("waiting_for_input");
      expect(run1.pauseReason).toBe("usage_limit");

      const run2 = runRepo.findById("issue-2")!;
      expect(run2.status).toBe("waiting_for_input");
      expect(run2.pauseReason).toBe("usage_limit");

      // Should be in cooldown
      expect(recovery.isInCooldown()).toBe(true);
      expect(recovery.pausedCount()).toBe(2);

      // Should have posted comments for both
      expect(tracker.postComment).toHaveBeenCalledTimes(2);
    });

    it("emits flight recorder events for detection and pause", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());
      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      const events: Array<{ type: string }> = [];
      const handler = (e: { type: string }) => events.push(e);
      runEvents.on("run", handler);

      const detection = makeDetection();
      await recovery.handleUsageLimitHit(detection, "issue-1", state, tracker, config, runRepo);

      runEvents.removeListener("run", handler);

      const types = events.map((e) => e.type);
      expect(types).toContain("usage_limit_detected");
      expect(types).toContain("usage_limit_paused");
    });

    it("marks task as failed when max resumes reached", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig({ maxResumes: 2 }));
      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      // First hit: resume count 0 → paused
      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);
      expect(runRepo.findById("issue-1")!.status).toBe("waiting_for_input");

      // Simulate restart: put back into running
      runRepo.updateStatus("issue-1", { status: "running" });
      addWorkerToState("issue-1", "PROJ-1");

      // Second hit: resume count 1 → paused
      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);
      expect(runRepo.findById("issue-1")!.status).toBe("waiting_for_input");

      // Simulate restart again
      runRepo.updateStatus("issue-1", { status: "running" });
      addWorkerToState("issue-1", "PROJ-1");

      // Third hit: resume count 2 >= maxResumes(2) → FAILED
      const events: Array<{ type: string }> = [];
      const handler = (e: { type: string }) => events.push(e);
      runEvents.on("run", handler);

      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);

      runEvents.removeListener("run", handler);

      expect(runRepo.findById("issue-1")!.status).toBe("failed");
      expect(recovery.pausedCount()).toBe(0);
      expect(events.map((e) => e.type)).toContain("usage_limit_failed");
    });
  });

  describe("restoreFromDatabase", () => {
    it("restores paused tasks and cooldown from database", () => {
      insertRun("issue-1", "running");
      const cooldownUntil = Date.now() + 3600000;
      runRepo.updateStatus("issue-1", {
        status: "waiting_for_input",
        pauseReason: "usage_limit",
        pauseContext: { resumeCount: 1, cooldownUntil, pausedAt: Date.now() },
      });

      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());
      recovery.restoreFromDatabase(runRepo);

      expect(recovery.pausedCount()).toBe(1);
      expect(recovery.getResumeCount("issue-1")).toBe(1);
      expect(recovery.isInCooldown()).toBe(true);
    });

    it("ignores non-usage-limit pauses", () => {
      insertRun("issue-1", "running");
      runRepo.updateStatus("issue-1", {
        status: "waiting_for_input",
        pauseReason: "needs-approval",
        pauseContext: { reason: "needs-approval", phase: "validation" },
      });

      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());
      recovery.restoreFromDatabase(runRepo);

      expect(recovery.pausedCount()).toBe(0);
    });
  });

  describe("concurrent task handling", () => {
    it("kills all concurrent tasks when one hits the limit", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());

      insertRun("issue-1", "running");
      insertRun("issue-2", "running");
      insertRun("issue-3", "running");
      addWorkerToState("issue-1", "PROJ-1");
      addWorkerToState("issue-2", "PROJ-2");
      addWorkerToState("issue-3", "PROJ-3");

      // Issue-2 triggers the limit
      await recovery.handleUsageLimitHit(makeDetection(), "issue-2", state, tracker, config, runRepo);

      // All three should be paused
      expect(state.running.size).toBe(0);
      expect(runRepo.findById("issue-1")!.status).toBe("waiting_for_input");
      expect(runRepo.findById("issue-2")!.status).toBe("waiting_for_input");
      expect(runRepo.findById("issue-3")!.status).toBe("waiting_for_input");

      // Comments posted for all three
      expect(tracker.postComment).toHaveBeenCalledTimes(3);
    });
  });

  describe("probe and restart", () => {
    it("schedules probe after cooldown and restarts tasks", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig({
        cooldownMinutes: 1,
        probeIntervalMinutes: 1,
      }));

      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);
      expect(recovery.pausedCount()).toBe(1);

      // Advance time past cooldown
      vi.advanceTimersByTime(60_000 + 1000);

      // Allow promise microtasks to resolve
      await vi.runAllTimersAsync();

      // Task should be restarted (released from claimed)
      expect(recovery.pausedCount()).toBe(0);
      expect(state.claimed.has("issue-1")).toBe(false);

      // DB should show queued
      expect(runRepo.findById("issue-1")!.status).toBe("queued");
    });

    it("emits probe and restart events", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig({
        cooldownMinutes: 1,
        probeIntervalMinutes: 1,
      }));

      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      const events: Array<{ type: string }> = [];
      const handler = (e: { type: string }) => events.push(e);
      runEvents.on("run", handler);

      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);
      await vi.runAllTimersAsync();

      runEvents.removeListener("run", handler);

      const types = events.map((e) => e.type);
      expect(types).toContain("usage_limit_cooldown");
      expect(types).toContain("usage_limit_probe");
      expect(types).toContain("usage_limit_restarted");
    });

    it("posts Linear comment on restart", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig({
        cooldownMinutes: 1,
        probeIntervalMinutes: 1,
      }));

      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, config, runRepo);
      tracker.postComment.mockClear();

      await vi.runAllTimersAsync();

      // Should post restart comment
      expect(tracker.postComment).toHaveBeenCalledTimes(1);
      const comment = tracker.postComment.mock.calls[0][1] as string;
      expect(comment).toContain("restarted");
    });
  });

  describe("config-based disable", () => {
    it("createUsageLimitRecovery returns null when detection disabled", () => {
      const disabledConfig = makeConfig({
        agent: {
          ...makeConfig().agent,
          usage_limit: {
            ...makeConfig().agent.usage_limit,
            enabled: false,
          },
        },
      } as any);
      const result = createUsageLimitRecovery(disabledConfig, logger);
      expect(result).toBeNull();
    });

    it("createUsageLimitRecovery returns instance when enabled", () => {
      const result = createUsageLimitRecovery(config, logger);
      expect(result).toBeInstanceOf(UsageLimitRecovery);
    });
  });

  describe("comments disabled", () => {
    it("does not post comments when tracker comments are disabled", async () => {
      const recovery = new UsageLimitRecovery(logger, makeRecoveryConfig());
      const noCommentsConfig = makeConfig({
        tracker: { ...config.tracker!, comments_enabled: false },
      } as any);

      insertRun("issue-1", "running");
      addWorkerToState("issue-1", "PROJ-1");

      await recovery.handleUsageLimitHit(makeDetection(), "issue-1", state, tracker, noCommentsConfig, runRepo);

      expect(tracker.postComment).not.toHaveBeenCalled();
    });
  });
});

describe("UsageLimitError", () => {
  it("carries detection result", () => {
    const detection: DetectionResult = {
      detected: true,
      reason: "pattern_match",
      matchedPattern: "rate limit",
      timestamp: new Date().toISOString(),
    };
    const error = new UsageLimitError(detection);
    expect(error.name).toBe("UsageLimitError");
    expect(error.detection).toBe(detection);
    expect(error.message).toContain("rate limit");
  });
});

describe("Linear comment formatters", () => {
  const detection: DetectionResult = {
    detected: true,
    reason: "pattern_match",
    matchedPattern: "rate limit",
    timestamp: new Date().toISOString(),
  };

  it("formatUsageLimitPausedComment includes all relevant info", () => {
    const comment = formatUsageLimitPausedComment("PROJ-1", detection, 1, 3, 60);
    expect(comment).toContain("PROJ-1");
    expect(comment).toContain("paused");
    expect(comment).toContain("rate limit");
    expect(comment).toContain("1/3");
    expect(comment).toContain("60 minutes");
  });

  it("formatUsageLimitRestartedComment includes resume count", () => {
    const comment = formatUsageLimitRestartedComment("PROJ-1", 1, 3);
    expect(comment).toContain("PROJ-1");
    expect(comment).toContain("restarted");
    expect(comment).toContain("1/3");
  });

  it("formatUsageLimitFailedComment includes max resumes info", () => {
    const comment = formatUsageLimitFailedComment("PROJ-1", 3, 3);
    expect(comment).toContain("PROJ-1");
    expect(comment).toContain("failed");
    expect(comment).toContain("3/3");
    expect(comment).toContain("max resumes exhausted");
  });
});
