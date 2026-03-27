import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ReactiveMetricsLoop,
  type MetricsLoopConfig,
  type MetricsLoopDeps,
  DEFAULT_METRICS_LOOP_CONFIG,
} from "../../src/analysis/metrics-loop.js";
import type { OutcomeRow, OutcomeRepository } from "../../src/storage/repositories/outcomes.js";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
import type { Logger } from "../../src/logging/logger.js";

function makeRow(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    id: "run-1",
    taskId: "task-1",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:10:00Z",
    status: "failure",
    totalTurns: 10,
    lintIterations: null,
    reviewRounds: null,
    reviewCommentsJson: null,
    failureMode: "typecheck",
    failureDetail: "Type error in src/orchestrator/worker.ts",
    humanReviewResult: null,
    humanReviewComments: null,
    modulesTouched: JSON.stringify(["src/orchestrator"]),
    filesChanged: null,
    testsAdded: null,
    rawEventsJson: null,
    contextEnabled: null,
    contextFilesJson: null,
    contextHitRate: null,
    recovered: null,
    ...overrides,
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

function makeTracker(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    kind: "linear",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue("ISSUE-999"),
    ...overrides,
  };
}

function makeOutcomeRepo(rows: OutcomeRow[]): OutcomeRepository {
  return {
    findAll: vi.fn().mockReturnValue(rows),
    findById: vi.fn(),
    findByStatus: vi.fn().mockReturnValue([]),
    insert: vi.fn(),
    update: vi.fn(),
  };
}

describe("ReactiveMetricsLoop", () => {
  describe("defaults", () => {
    it("has correct default config", () => {
      expect(DEFAULT_METRICS_LOOP_CONFIG.enabled).toBe(false);
      expect(DEFAULT_METRICS_LOOP_CONFIG.poll_interval_ms).toBe(300_000);
      expect(DEFAULT_METRICS_LOOP_CONFIG.max_issues_per_day).toBe(5);
    });
  });

  describe("lifecycle", () => {
    it("does not start when disabled", () => {
      const logger = makeLogger();
      const loop = new ReactiveMetricsLoop(
        { enabled: false },
        { outcomeRepo: makeOutcomeRepo([]), tracker: makeTracker(), logger },
      );
      loop.start();
      expect(loop.isRunning()).toBe(false);
      loop.stop();
    });

    it("starts and stops when enabled", () => {
      const logger = makeLogger();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, poll_interval_ms: 60_000 },
        { outcomeRepo: makeOutcomeRepo([]), tracker: makeTracker(), logger },
      );
      loop.start();
      expect(loop.isRunning()).toBe(true);
      loop.stop();
      expect(loop.isRunning()).toBe(false);
    });
  });

  describe("evaluate", () => {
    it("returns empty when no outcomes exist", async () => {
      const logger = makeLogger();
      const loop = new ReactiveMetricsLoop(
        { enabled: true },
        { outcomeRepo: makeOutcomeRepo([]), tracker: makeTracker(), logger },
      );
      const result = await loop.evaluate();
      expect(result.structuredAnomalies).toEqual([]);
      expect(result.createdIssues).toEqual([]);
    });

    it("detects repeated failures and creates reactive issues", async () => {
      const rows = [
        makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
        makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      ];
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10 },
        { outcomeRepo: makeOutcomeRepo(rows), tracker, logger },
      );

      const result = await loop.evaluate();
      expect(result.createdIssues.length).toBeGreaterThan(0);
      expect(tracker.createIssue).toHaveBeenCalled();
    });

    it("detects cost spike anomaly from structured detector", async () => {
      const rows = [
        makeRow({ id: "r1", status: "success", failureMode: null }),
      ];
      const costsByRun = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.0 },
        { runId: "r3", costUsd: 1.0 },
        { runId: "r4", costUsd: 20.0 },
      ];
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10 },
        {
          outcomeRepo: makeOutcomeRepo(rows),
          tracker,
          logger,
          costsByRun: () => costsByRun,
        },
      );

      const result = await loop.evaluate();
      const costAnomaly = result.structuredAnomalies.find(a => a.type === "cost_spike");
      expect(costAnomaly).toBeDefined();
    });

    it("detects success rate drop anomaly", async () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        makeRow({ id: `r${i}`, status: "failure", failureMode: null }),
      );
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10, repeated_failure_threshold: 20 },
        { outcomeRepo: makeOutcomeRepo(rows), tracker, logger },
      );

      const result = await loop.evaluate();
      const successDrop = result.structuredAnomalies.find(a => a.type === "success_rate_drop");
      expect(successDrop).toBeDefined();
    });

    it("creates structured anomaly issues via tracker", async () => {
      const rows = [
        makeRow({ id: "r1", status: "success", failureMode: null }),
      ];
      const costsByRun = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.0 },
        { runId: "r3", costUsd: 50.0 },
      ];
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10 },
        {
          outcomeRepo: makeOutcomeRepo(rows),
          tracker,
          logger,
          costsByRun: () => costsByRun,
        },
      );

      const result = await loop.evaluate();
      // Should have created issue for the cost spike anomaly
      const costAnomaly = result.structuredAnomalies.find(a => a.type === "cost_spike");
      expect(costAnomaly).toBeDefined();
      // tracker.createIssue should have been called for the anomaly
      const calls = (tracker.createIssue as ReturnType<typeof vi.fn>).mock.calls;
      const anomalyCall = calls.find((c: unknown[]) => (c[0] as string).includes("cost spike"));
      expect(anomalyCall).toBeDefined();
    });

    it("skips duplicate anomaly issues", async () => {
      const rows = [
        makeRow({ id: "r1", status: "success", failureMode: null }),
      ];
      const costsByRun = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.0 },
        { runId: "r3", costUsd: 50.0 },
      ];
      const existingIssue: TrackerIssue = {
        id: "existing-1",
        identifier: "EX-1",
        title: "[reactive] Investigate cost spike",
        description: "",
        state: "open",
        priority: null,
        labels: ["reactive-maintenance"],
        assignees: [],
        url: "",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        blocked_by: [],
        metadata: {},
      };
      const logger = makeLogger();
      const tracker = makeTracker({
        fetchIssuesByStates: vi.fn().mockResolvedValue([existingIssue]),
      });
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10 },
        {
          outcomeRepo: makeOutcomeRepo(rows),
          tracker,
          logger,
          costsByRun: () => costsByRun,
        },
      );

      await loop.evaluate();
      // The anomaly issue should be skipped as duplicate
      const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const skipMsg = infoMessages.find((c: unknown[]) => (c[1] as string).includes("Skipping duplicate"));
      expect(skipMsg).toBeDefined();
    });

    it("respects auto_create_issues=false", async () => {
      const rows = [
        makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
        makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      ];
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: false },
        { outcomeRepo: makeOutcomeRepo(rows), tracker, logger },
      );

      const result = await loop.evaluate();
      expect(result.createdIssues).toEqual([]);
      expect(tracker.createIssue).not.toHaveBeenCalled();
    });
  });

  describe("tick", () => {
    it("prevents concurrent ticks", async () => {
      const rows = [makeRow({ id: "r1", status: "success", failureMode: null })];
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true },
        { outcomeRepo: makeOutcomeRepo(rows), tracker, logger },
      );

      // Run two ticks in parallel
      const [r1, r2] = await Promise.all([loop.tick(), loop.tick()]);
      // One should have been skipped (empty result)
      const skipped = [r1, r2].filter(
        r => r.structuredAnomalies.length === 0 && r.createdIssues.length === 0,
      );
      expect(skipped.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("coverage decay", () => {
    it("detects coverage decay from gap issues", async () => {
      const rows = [makeRow({ id: "r1", status: "success", failureMode: null })];
      const now = new Date();
      const gaps = Array.from({ length: 6 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(now.getTime() - i * 3600_000).toISOString(),
      }));
      const logger = makeLogger();
      const tracker = makeTracker();
      const loop = new ReactiveMetricsLoop(
        { enabled: true, auto_create_issues: true, max_issues_per_day: 10 },
        {
          outcomeRepo: makeOutcomeRepo(rows),
          tracker,
          logger,
          gapIssues: () => gaps,
        },
      );

      const result = await loop.evaluate();
      const decay = result.structuredAnomalies.find(a => a.type === "coverage_decay");
      expect(decay).toBeDefined();
    });
  });
});
