import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { createEventRepository, type EventRepository } from "../../src/storage/repositories/events.js";
import { createAnalyticsRepository, type AnalyticsRepository } from "../../src/storage/repositories/analytics.js";

describe("storage/repositories/analytics", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;
  let costRepo: CostRepository;
  let eventRepo: EventRepository;
  let analyticsRepo: AnalyticsRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-analytics-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
    costRepo = createCostRepository(db);
    eventRepo = createEventRepository(db);
    analyticsRepo = createAnalyticsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertSampleData() {
    runRepo.insert({ id: "run-1", task: "task 1", workflow: "code", submittedAt: "2026-03-20T10:00:00Z" });
    runRepo.updateStatus("run-1", { status: "completed", startedAt: "2026-03-20T10:00:00Z", completedAt: "2026-03-20T10:30:00Z" });

    runRepo.insert({ id: "run-2", task: "task 2", workflow: "code", submittedAt: "2026-03-20T11:00:00Z" });
    runRepo.updateStatus("run-2", { status: "failed", startedAt: "2026-03-20T11:00:00Z", completedAt: "2026-03-20T11:10:00Z" });

    runRepo.insert({ id: "run-3", task: "task 3", workflow: "research", submittedAt: "2026-03-21T09:00:00Z" });
    runRepo.updateStatus("run-3", { status: "completed", startedAt: "2026-03-21T09:00:00Z", completedAt: "2026-03-21T10:00:00Z" });

    costRepo.insert({ runId: "run-1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.01, timestamp: "2026-03-20T10:15:00Z" });
    costRepo.insert({ runId: "run-1", agentType: "claude-code", inputTokens: 2000, outputTokens: 1000, costUsd: 0.02, timestamp: "2026-03-20T10:25:00Z" });
    costRepo.insert({ runId: "run-2", agentType: "claude-code", inputTokens: 500, outputTokens: 200, costUsd: 0.005, timestamp: "2026-03-20T11:05:00Z" });
    costRepo.insert({ runId: "run-3", agentType: "claude-code", inputTokens: 3000, outputTokens: 1500, costUsd: 0.04, timestamp: "2026-03-21T09:30:00Z" });

    eventRepo.insert({ runId: "run-2", type: "validation_fail_lint", timestamp: "2026-03-20T11:05:00Z", data: { step: "lint" } });
    eventRepo.insert({ runId: "run-2", type: "validation_fail_lint", timestamp: "2026-03-20T11:07:00Z", data: { step: "lint" } });
    eventRepo.insert({ runId: "run-2", type: "validation_fail_test", timestamp: "2026-03-20T11:09:00Z", data: { step: "test" } });
  }

  describe("getSummary()", () => {
    it("returns correct aggregated summary", () => {
      insertSampleData();
      const summary = analyticsRepo.getSummary();

      expect(summary.totalRuns).toBe(3);
      expect(summary.successRate).toBeCloseTo(66.67, 1);
      expect(summary.avgDuration).toBeGreaterThan(0);
      expect(summary.totalCost).toBeCloseTo(0.075, 4);
      expect(summary.avgCost).toBeCloseTo(0.025, 4);
      expect(summary.runsByStatus).toEqual({ completed: 2, failed: 1 });
      expect(summary.costByDay).toHaveLength(2);
      expect(summary.topFailingSteps.length).toBeGreaterThan(0);
    });

    it("returns zeros for empty database", () => {
      const summary = analyticsRepo.getSummary();
      expect(summary.totalRuns).toBe(0);
      expect(summary.successRate).toBe(0);
      expect(summary.totalCost).toBe(0);
      expect(summary.runsByStatus).toEqual({});
      expect(summary.costByDay).toEqual([]);
      expect(summary.topFailingSteps).toEqual([]);
    });

    it("filters by workflow", () => {
      insertSampleData();
      const summary = analyticsRepo.getSummary({ workflow: "code" });
      expect(summary.totalRuns).toBe(2);
    });

    it("filters by status", () => {
      insertSampleData();
      const summary = analyticsRepo.getSummary({ status: "completed" });
      expect(summary.totalRuns).toBe(2);
      expect(summary.successRate).toBe(100);
    });

    it("filters by time range", () => {
      insertSampleData();
      const summary = analyticsRepo.getSummary({ since: "2026-03-21T00:00:00Z" });
      expect(summary.totalRuns).toBe(1);
    });
  });

  describe("getSuccessRateByComplexity()", () => {
    it("returns success rate grouped by complexity score", () => {
      runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z" });
      runRepo.updateStatus("r1", { status: "completed" });
      runRepo.setComplexityAssessment("r1", { complexityScore: 3 });

      runRepo.insert({ id: "r2", task: "t2", submittedAt: "2026-03-20T10:00:00Z" });
      runRepo.updateStatus("r2", { status: "failed" });
      runRepo.setComplexityAssessment("r2", { complexityScore: 3 });

      runRepo.insert({ id: "r3", task: "t3", submittedAt: "2026-03-20T10:00:00Z" });
      runRepo.updateStatus("r3", { status: "completed" });
      runRepo.setComplexityAssessment("r3", { complexityScore: 7 });

      const results = analyticsRepo.getSuccessRateByComplexity();
      expect(results).toHaveLength(2);

      const score3 = results.find((r) => r.complexityScore === 3)!;
      expect(score3.totalRuns).toBe(2);
      expect(score3.successCount).toBe(1);
      expect(score3.successRate).toBe(50);

      const score7 = results.find((r) => r.complexityScore === 7)!;
      expect(score7.totalRuns).toBe(1);
      expect(score7.successRate).toBe(100);
    });

    it("returns empty array when no runs have complexity", () => {
      insertSampleData();
      const results = analyticsRepo.getSuccessRateByComplexity();
      expect(results).toEqual([]);
    });
  });

  describe("getValidationFailureHotspots()", () => {
    it("returns failure hotspots from events", () => {
      insertSampleData();
      const hotspots = analyticsRepo.getValidationFailureHotspots();

      expect(hotspots).toHaveLength(2);
      expect(hotspots[0].step).toBe("validation_fail_lint");
      expect(hotspots[0].failureCount).toBe(2);
      expect(hotspots[0].affectedRuns).toBe(1);
      expect(hotspots[1].step).toBe("validation_fail_test");
      expect(hotspots[1].failureCount).toBe(1);
    });

    it("returns empty array with no failures", () => {
      const hotspots = analyticsRepo.getValidationFailureHotspots();
      expect(hotspots).toEqual([]);
    });
  });

  describe("getCostTrend()", () => {
    it("returns daily cost trend", () => {
      insertSampleData();
      const trend = analyticsRepo.getCostTrend(30);

      expect(trend.length).toBeGreaterThanOrEqual(1);
      for (const point of trend) {
        expect(point.day).toBeDefined();
        expect(point.totalCost).toBeGreaterThan(0);
        expect(point.runCount).toBeGreaterThan(0);
      }
    });

    it("returns empty array when no costs", () => {
      const trend = analyticsRepo.getCostTrend(7);
      expect(trend).toEqual([]);
    });
  });

  describe("getSlowRuns()", () => {
    it("returns runs sorted by duration descending", () => {
      insertSampleData();
      const slow = analyticsRepo.getSlowRuns(10);

      expect(slow).toHaveLength(3);
      expect(slow[0].durationSeconds).toBeGreaterThanOrEqual(slow[1].durationSeconds);
      expect(slow[1].durationSeconds).toBeGreaterThanOrEqual(slow[2].durationSeconds);
      expect(slow[0].id).toBe("run-3"); // 1 hour
      expect(slow[0].durationSeconds).toBeCloseTo(3600, 0);
    });

    it("respects limit", () => {
      insertSampleData();
      const slow = analyticsRepo.getSlowRuns(1);
      expect(slow).toHaveLength(1);
    });

    it("returns empty array when no completed runs", () => {
      const slow = analyticsRepo.getSlowRuns(10);
      expect(slow).toEqual([]);
    });
  });
});
