import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository } from "../../src/storage/repositories/runs.js";
import { createCostRepository } from "../../src/storage/repositories/costs.js";
import { createAnalyticsRepository } from "../../src/storage/repositories/analytics.js";
import { createOutcomeRepository } from "../../src/storage/repositories/outcomes.js";

describe("stats CLI formatting", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-stats-cli-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getSummary returns valid JSON shape for --json output", () => {
    const runRepo = createRunRepository(db);
    const costRepo = createCostRepository(db);
    const analyticsRepo = createAnalyticsRepository(db);

    runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z", status: "completed" });
    runRepo.insert({ id: "r2", task: "t2", submittedAt: "2026-03-20T11:00:00Z", status: "failed" });
    costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.05, timestamp: "2026-03-20T10:00:00Z" });

    const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
    const json = JSON.stringify(summary);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("runCount");
    expect(parsed).toHaveProperty("successRate");
    expect(parsed).toHaveProperty("totalCostUsd");
    expect(parsed).toHaveProperty("avgCostUsd");
    expect(parsed).toHaveProperty("avgDurationMs");
    expect(parsed).toHaveProperty("topFailures");
    expect(typeof parsed.runCount).toBe("number");
    expect(typeof parsed.successRate).toBe("number");
    expect(typeof parsed.totalCostUsd).toBe("number");
    expect(Array.isArray(parsed.topFailures)).toBe(true);
  });

  it("full --json output includes all analytics sections", () => {
    const runRepo = createRunRepository(db);
    const costRepo = createCostRepository(db);
    const analyticsRepo = createAnalyticsRepository(db);
    const outcomeRepo = createOutcomeRepository(db);

    runRepo.insert({ id: "r1", task: "t1", workflow: "code", submittedAt: "2026-03-20T10:00:00Z", status: "completed", startedAt: "2026-03-20T10:00:00Z", completedAt: "2026-03-20T10:05:00Z" });
    costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.05, timestamp: "2026-03-20T10:00:00Z" });
    outcomeRepo.insert({ id: "o1", status: "completed", totalTurns: 2, lintIterations: 1, reviewRounds: 0, startedAt: "2026-03-20T10:00:00Z" });

    const sinceISO = "2026-03-20T00:00:00Z";
    const result = {
      summary: analyticsRepo.getSummary(sinceISO),
      costTrend: analyticsRepo.getCostTrend(sinceISO),
      retryPatterns: analyticsRepo.getRetryPatterns(sinceISO),
      failureHotspots: analyticsRepo.getFailureHotspots(sinceISO),
      workflowPerformance: analyticsRepo.getPerformanceByWorkflow(sinceISO),
    };

    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("costTrend");
    expect(parsed).toHaveProperty("retryPatterns");
    expect(parsed).toHaveProperty("failureHotspots");
    expect(parsed).toHaveProperty("workflowPerformance");
    expect(parsed.retryPatterns).toHaveProperty("totalOutcomes");
    expect(parsed.retryPatterns).toHaveProperty("retryRate");
    expect(Array.isArray(parsed.workflowPerformance)).toBe(true);
  });

  it("summary values are correct for mixed run statuses", () => {
    const runRepo = createRunRepository(db);
    const costRepo = createCostRepository(db);
    const analyticsRepo = createAnalyticsRepository(db);

    runRepo.insert({ id: "r1", task: "t1", submittedAt: "2026-03-20T10:00:00Z", status: "completed" });
    runRepo.insert({ id: "r2", task: "t2", submittedAt: "2026-03-20T11:00:00Z", status: "completed" });
    runRepo.insert({ id: "r3", task: "t3", submittedAt: "2026-03-20T12:00:00Z", status: "failed" });
    runRepo.insert({ id: "r4", task: "t4", submittedAt: "2026-03-20T13:00:00Z", status: "completed" });
    costRepo.insert({ runId: "r1", agentType: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 0.10, timestamp: "2026-03-20T10:00:00Z" });
    costRepo.insert({ runId: "r2", agentType: "claude-code", inputTokens: 2000, outputTokens: 1000, costUsd: 0.20, timestamp: "2026-03-20T11:00:00Z" });

    const summary = analyticsRepo.getSummary("2026-03-20T00:00:00Z");
    expect(summary.runCount).toBe(4);
    expect(summary.successCount).toBe(3);
    expect(summary.failureCount).toBe(1);
    expect(summary.successRate).toBe(0.75);
    expect(summary.totalCostUsd).toBeCloseTo(0.30, 4);
    expect(summary.avgCostUsd).toBeCloseTo(0.075, 4);
  });
});
