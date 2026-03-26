import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createCooldownRepository, type CooldownRepository } from "../../src/storage/repositories/cooldown.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
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

// Mock usage-limit probe
vi.mock("../../src/orchestrator/usage-limit-probe.js", () => ({
  probeUsageLimit: vi.fn().mockResolvedValue(false),
}));

import { tick, type TickDeps } from "../../src/orchestrator/scheduler.js";
import { dispatchIssue } from "../../src/orchestrator/dispatcher.js";
import { probeUsageLimit } from "../../src/orchestrator/usage-limit-probe.js";

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

function makeConfig() {
  return {
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
      child_slots: 0,
      enable_triage: false,
      triage_max_complexity: 7,
    },
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
    tracker: {
      kind: "github" as const,
      token: "fake",
      repo: "test/repo",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
      labels: undefined,
      comments_enabled: true,
      comment_events: ["completed", "failed"],
    },
    container: {},
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: [] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: { message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true }, author: { name: "forgectl", email: "forge@localhost" }, sign: false },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    storage: { db_path: "~/.forgectl/forgectl.db" },
    board: { state_dir: "~/.forgectl/board", scheduler_tick_seconds: 30, max_concurrent_card_runs: 2 },
    schedules: [],
  } as any;
}

describe("cooldown repository", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let cooldownRepo: CooldownRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-cooldown-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    cooldownRepo = createCooldownRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no cooldown state exists", () => {
    const state = cooldownRepo.getCooldownState();
    expect(state).toBeNull();
  });

  it("enters and persists cooldown to SQLite", () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    const state = cooldownRepo.getCooldownState();
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.resumeAt).toBe(resumeAt);
    expect(state!.probeCount).toBe(0);
    expect(state!.enteredAt).toBeTruthy();
  });

  it("exits cooldown", () => {
    cooldownRepo.enterCooldown(new Date().toISOString());
    cooldownRepo.exitCooldown();

    const state = cooldownRepo.getCooldownState();
    expect(state).not.toBeNull();
    expect(state!.active).toBe(false);
    expect(state!.resumeAt).toBeNull();
    expect(state!.enteredAt).toBeNull();
  });

  it("increments probe count", () => {
    cooldownRepo.enterCooldown(new Date().toISOString());
    cooldownRepo.incrementProbeCount();
    cooldownRepo.incrementProbeCount();

    const state = cooldownRepo.getCooldownState();
    expect(state!.probeCount).toBe(2);
  });

  it("re-entering cooldown resets probe count", () => {
    cooldownRepo.enterCooldown(new Date().toISOString());
    cooldownRepo.incrementProbeCount();
    cooldownRepo.incrementProbeCount();

    cooldownRepo.enterCooldown(new Date(Date.now() + 7200000).toISOString());
    const state = cooldownRepo.getCooldownState();
    expect(state!.probeCount).toBe(0);
  });
});

describe("scheduler cooldown integration", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let cooldownRepo: CooldownRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-sched-cooldown-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    cooldownRepo = createCooldownRepository(db);
    runRepo = createRunRepository(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<TickDeps> = {}): TickDeps {
    return {
      state: createState(),
      tracker: makeTracker(),
      workspaceManager: {} as unknown as WorkspaceManager,
      slotManager: new TwoTierSlotManager(3, 0),
      config: makeConfig(),
      promptTemplate: "test",
      logger: makeLogger(),
      metrics: new MetricsCollector(),
      runRepo,
      cooldownRepo,
      ...overrides,
    };
  }

  it("skips dispatch during active cooldown", async () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    const deps = makeDeps();
    // Set lastProbeAt to now so probe doesn't trigger
    deps.lastProbeAt = Date.now();
    await tick(deps);

    expect(dispatchIssue).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith("scheduler", expect.stringContaining("Scheduler in cooldown until"));
  });

  it("runs probe at correct interval during cooldown", async () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    const deps = makeDeps();
    // Set lastProbeAt to long ago so probe triggers
    deps.lastProbeAt = Date.now() - 20 * 60_000; // 20 min ago (> 15 min interval)

    await tick(deps);

    expect(probeUsageLimit).toHaveBeenCalled();
    expect(cooldownRepo.getCooldownState()!.probeCount).toBe(1);
  });

  it("probe success exits cooldown", async () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    vi.mocked(probeUsageLimit).mockResolvedValueOnce(true);

    const deps = makeDeps();
    deps.lastProbeAt = Date.now() - 20 * 60_000;

    await tick(deps);

    const state = cooldownRepo.getCooldownState();
    expect(state!.active).toBe(false);
  });

  it("maxResumes exceeded marks run as failed", async () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    // Insert a paused run with max resumes reached
    runRepo.insert({ id: "run-1", task: "test", submittedAt: new Date().toISOString() });
    runRepo.updateStatus("run-1", {
      status: "paused_usage_limit",
      pauseContext: { usageLimitPauseCount: 3 },
    });

    vi.mocked(probeUsageLimit).mockResolvedValueOnce(true);

    const deps = makeDeps();
    deps.lastProbeAt = Date.now() - 20 * 60_000;

    await tick(deps);

    const run = runRepo.findById("run-1");
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("usage_limit_max_resumes");
  });

  it("auto-restart dispatches paused runs one at a time", async () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    // Insert paused runs with low pause count (under max)
    runRepo.insert({ id: "run-a", task: "test a", submittedAt: new Date().toISOString() });
    runRepo.updateStatus("run-a", {
      status: "paused_usage_limit",
      pauseContext: { usageLimitPauseCount: 1 },
    });

    runRepo.insert({ id: "run-b", task: "test b", submittedAt: new Date().toISOString() });
    runRepo.updateStatus("run-b", {
      status: "paused_usage_limit",
      pauseContext: { usageLimitPauseCount: 1 },
    });

    vi.mocked(probeUsageLimit).mockResolvedValueOnce(true);

    const deps = makeDeps();
    deps.lastProbeAt = Date.now() - 20 * 60_000;

    // Mock setTimeout to avoid 30s delay in tests
    vi.useFakeTimers();
    const tickPromise = tick(deps);
    // Advance past the 30s delay
    await vi.advanceTimersByTimeAsync(31_000);
    await tickPromise;
    vi.useRealTimers();

    const runA = runRepo.findById("run-a");
    const runB = runRepo.findById("run-b");
    expect(runA!.status).toBe("todo");
    expect(runB!.status).toBe("todo");
  });

  it("daemon restart resumes cooldown state", () => {
    const resumeAt = new Date(Date.now() + 3600000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    // Simulate daemon restart — re-read state
    const state = cooldownRepo.getCooldownState();
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.resumeAt).toBe(resumeAt);
  });

  it("daemon restart with expired cooldown exits cooldown", () => {
    // Simulate cooldown that expired while daemon was down
    const resumeAt = new Date(Date.now() - 1000).toISOString();
    cooldownRepo.enterCooldown(resumeAt);

    // Insert a paused run
    runRepo.insert({ id: "run-expired", task: "test", submittedAt: new Date().toISOString() });
    runRepo.updateStatus("run-expired", { status: "paused_usage_limit" });

    // Simulate daemon startup recovery logic
    const state = cooldownRepo.getCooldownState();
    if (state?.active) {
      const resumeTime = state.resumeAt ? new Date(state.resumeAt).getTime() : 0;
      if (Date.now() >= resumeTime) {
        cooldownRepo.exitCooldown();
        const pausedRuns = runRepo.findByStatus("paused_usage_limit");
        for (const run of pausedRuns) {
          runRepo.updateStatus(run.id, { status: "todo" });
          runRepo.clearPauseContext(run.id);
        }
      }
    }

    const afterState = cooldownRepo.getCooldownState();
    expect(afterState!.active).toBe(false);

    const run = runRepo.findById("run-expired");
    expect(run!.status).toBe("todo");
  });
});
