import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createAnalyticsRepository, type AnalyticsRepository } from "../../src/storage/repositories/analytics.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { createOutcomeRepository, type OutcomeRepository } from "../../src/storage/repositories/outcomes.js";

describe("storage/repositories/analytics", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let analyticsRepo: AnalyticsRepository;
  let runRepo: RunRepository;
  let costRepo: CostRepository;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-analytics-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    analyticsRepo = createAnalyticsRepository(db);
    runRepo = createRunRepository(db);
    costRepo = createCostRepository(db);
    outcomeRepo = createOutcomeRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getSummary()", () => {
    it("returns zeros for empty database", () => {
      const summary = analyticsRepo.getSummary("2026-01-01T00:00:00Z");
      expect(summary.runCount).toBe(0);
      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(0);
      expect(summary.successRate).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.avgCostUsd).toBe(0);
      expect(summary.topFailures).toEqual([]);
    });

    it("calculates run count and success rate", () => {
      runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z", status: "completed" });
      runRepo.insert({ id: "r2", task: "t2", submittedAt: "2026-03-20T11:00:00Z", status: "completed" });
      runRepo.insert({ id: "r3", task: "t3", submittedAt: "2026-03-20T12:00:00Z", status: "failed" });

      const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
      expect(summary.runCount).toBe(3);
      expect(summary.successCount).toBe(2);
      expect(summary.failureCount).toBe(1);
      expect(summary.successRate).toBeCloseTo(0.6667, 3);
    });

    it("aggregates cost data", () => {
      runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z" });
      costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.05, timestamp: "2026-03-20T10:00:00Z" });
      costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 2000, outputTokens: 1000, costUsd: 0.10, timestamp: "2026-03-20T10:05:00Z" });

      const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
      expect(summary.totalCostUsd).toBeCloseTo(0.15, 4);
      expect(summary.avgCostUsd).toBeCloseTo(0.15, 4);
    });

    it("includes top failure modes from outcomes", () => {
      outcomeRepo.insert({ id: "o1", status: "failed", failureMode: "lint_failure", startedAt: "2026-03-20T10:00:00Z" });
      outcomeRepo.insert({ id: "o2", status: "failed", failureMode: "lint_failure", startedAt: "2026-03-20T11:00:00Z" });
      outcomeRepo.insert({ id: "o3", status: "failed", failureMode: "test_failure", startedAt: "2026-03-20T12:00:00Z" });

      const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
      expect(summary.topFailures.length).toBe(2);
      expect(summary.topFailures[0].mode).toBe("lint_failure");
      expect(summary.topFailures[0].count).toBe(2);
      expect(summary.topFailures[1].mode).toBe("test_failure");
      expect(summary.topFailures[1].count).toBe(1);
    });

    it("respects since filter", () => {
      runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-19T10:00:00Z", status: "completed" });
      runRepo.insert({ id: "r2", task: "t2", submittedAt: "2026-03-21T10:00:00Z", status: "completed" });

      const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
      expect(summary.runCount).toBe(1);
    });
  });

  describe("getCostTrend()", () => {
    it("returns empty array for no data", () => {
      const trend = analyticsRepo.getCostTrend("2026-03-20T00:00:00Z");
      expect(trend).toEqual([]);
    });

    it("groups costs by date", () => {
      costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.05, timestamp: "2026-03-20T10:00:00Z" });
      costRepo.insert({ runId: "r2", agentType: "claude-code", inputTokens: 2000, outputTokens: 1000, costUsd: 0.10, timestamp: "2026-03-20T15:00:00Z" });
      costRepo.insert({ runId: "r3", agentType: "claude-code", inputTokens: 500, outputTokens: 200, costUsd: 0.02, timestamp: "2026-03-21T10:00:00Z" });

      const trend = analyticsRepo.getCostTrend("2026-03-20T00:00:00Z");
      expect(trend.length).toBe(2);
      expect(trend[0].date).toBe("2026-03-20");
      expect(trend[0].totalCostUsd).toBeCloseTo(0.15, 4);
      expect(trend[0].runCount).toBe(2);
      expect(trend[1].date).toBe("2026-03-21");
      expect(trend[1].totalCostUsd).toBeCloseTo(0.02, 4);
      expect(trend[1].runCount).toBe(1);
    });
  });

  describe("getFailureHotspots()", () => {
    it("returns empty array for no data", () => {
      const hotspots = analyticsRepo.getFailureHotspots("2026-03-20T00:00:00Z");
      expect(hotspots).toEqual([]);
    });

    it("returns modules with failure counts", () => {
      outcomeRepo.insert({
        id: "o1",
        status: "failed",
        modulesTouched: JSON.stringify(["src/auth"]),
        startedAt: "2026-03-20T10:00:00Z",
      });
      outcomeRepo.insert({
        id: "o2",
        status: "completed",
        modulesTouched: JSON.stringify(["src/auth"]),
        startedAt: "2026-03-20T11:00:00Z",
      });

      const hotspots = analyticsRepo.getFailureHotspots("2026-03-20T00:00:00Z");
      expect(hotspots.length).toBeGreaterThan(0);
    });
  });

  describe("getRetryPatterns()", () => {
    it("returns zeros for empty database", () => {
      const patterns = analyticsRepo.getRetryPatterns("2026-03-20T00:00:00Z");
      expect(patterns.totalOutcomes).toBe(0);
      expect(patterns.avgTotalTurns).toBe(0);
      expect(patterns.avgLintIterations).toBe(0);
      expect(patterns.avgReviewRounds).toBe(0);
      expect(patterns.maxTotalTurns).toBe(0);
      expect(patterns.runsWithRetries).toBe(0);
      expect(patterns.retryRate).toBe(0);
    });

    it("calculates retry patterns from outcomes", () => {
      outcomeRepo.insert({ id: "o1", status: "completed", totalTurns: 3, lintIterations: 1, reviewRounds: 1, startedAt: "2026-03-20T10:00:00Z" });
      outcomeRepo.insert({ id: "o2", status: "completed", totalTurns: 1, lintIterations: 0, reviewRounds: 0, startedAt: "2026-03-20T11:00:00Z" });
      outcomeRepo.insert({ id: "o3", status: "failed", totalTurns: 5, lintIterations: 2, reviewRounds: 2, startedAt: "2026-03-20T12:00:00Z" });

      const patterns = analyticsRepo.getRetryPatterns("2026-03-20T00:00:00Z");
      expect(patterns.totalOutcomes).toBe(3);
      expect(patterns.avgTotalTurns).toBe(3);
      expect(patterns.avgLintIterations).toBe(1);
      expect(patterns.avgReviewRounds).toBe(1);
      expect(patterns.maxTotalTurns).toBe(5);
      expect(patterns.runsWithRetries).toBe(2);
      expect(patterns.retryRate).toBeCloseTo(0.6667, 3);
    });

    it("respects since filter", () => {
      outcomeRepo.insert({ id: "o1", status: "completed", totalTurns: 3, startedAt: "2026-03-19T10:00:00Z" });
      outcomeRepo.insert({ id: "o2", status: "completed", totalTurns: 1, startedAt: "2026-03-21T10:00:00Z" });

      const patterns = analyticsRepo.getRetryPatterns("2026-03-20T00:00:00Z");
      expect(patterns.totalOutcomes).toBe(1);
    });
  });

  describe("getPerformanceByWorkflow()", () => {
    it("returns empty array for no data", () => {
      const perf = analyticsRepo.getPerformanceByWorkflow("2026-03-20T00:00:00Z");
      expect(perf).toEqual([]);
    });

    it("groups performance by workflow", () => {
      runRepo.insert({ id: "r1", task: "t1", workflow: "code", submittedAt: "2026-03-20T10:00:00Z", status: "completed", startedAt: "2026-03-20T10:00:00Z", completedAt: "2026-03-20T10:05:00Z" });
      runRepo.insert({ id: "r2", task: "t2", workflow: "code", submittedAt: "2026-03-20T11:00:00Z", status: "failed", startedAt: "2026-03-20T11:00:00Z", completedAt: "2026-03-20T11:10:00Z" });
      runRepo.insert({ id: "r3", task: "t3", workflow: "research", submittedAt: "2026-03-20T12:00:00Z", status: "completed", startedAt: "2026-03-20T12:00:00Z", completedAt: "2026-03-20T12:02:00Z" });
      costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.10, timestamp: "2026-03-20T10:00:00Z" });
      costRepo.insert({ runId: "r2", agentType: "claude-code", inputTokens: 2000, outputTokens: 1000, costUsd: 0.20, timestamp: "2026-03-20T11:00:00Z" });
      costRepo.insert({ runId: "r3", agentType: "claude-code", inputTokens: 500, outputTokens: 200, costUsd: 0.03, timestamp: "2026-03-20T12:00:00Z" });

      const perf = analyticsRepo.getPerformanceByWorkflow("2026-03-20T00:00:00Z");
      expect(perf.length).toBe(2);

      const codePerf = perf.find((p) => p.workflow === "code")!;
      expect(codePerf.runCount).toBe(2);
      expect(codePerf.successCount).toBe(1);
      expect(codePerf.failureCount).toBe(1);
      expect(codePerf.successRate).toBe(0.5);
      expect(codePerf.totalCostUsd).toBeCloseTo(0.30, 4);
      expect(codePerf.avgCostUsd).toBeCloseTo(0.15, 4);

      const researchPerf = perf.find((p) => p.workflow === "research")!;
      expect(researchPerf.runCount).toBe(1);
      expect(researchPerf.successRate).toBe(1);
      expect(researchPerf.totalCostUsd).toBeCloseTo(0.03, 4);
    });

    it("excludes runs without workflow", () => {
      runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z", status: "completed" });
      runRepo.insert({ id: "r2", task: "t2", workflow: "code", submittedAt: "2026-03-20T11:00:00Z", status: "completed" });

      const perf = analyticsRepo.getPerformanceByWorkflow("2026-03-20T00:00:00Z");
      expect(perf.length).toBe(1);
      expect(perf[0].workflow).toBe("code");
    });
  });
});
