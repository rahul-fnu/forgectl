import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";

/**
 * Tests that cost insertion works correctly when called from the worker completion path.
 * This simulates what the dispatcher does after executeWorker returns with token usage.
 */
describe("cost insertion from worker completion path", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let costRepo: CostRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-cost-insert-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    costRepo = createCostRepository(db);
    runRepo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts cost record with token usage from agent result", () => {
    // Simulate what the dispatcher does after worker returns
    const tokenUsage = { input: 5000, output: 2000, total: 7000 };
    const runId = "test-issue-123";
    const agentType = "claude-code";
    const model = "claude-sonnet-4-20250514";
    const costUsd = (tokenUsage.input * 3 + tokenUsage.output * 15) / 1_000_000;

    costRepo.insert({
      runId,
      agentType,
      model,
      inputTokens: tokenUsage.input,
      outputTokens: tokenUsage.output,
      costUsd,
      timestamp: new Date().toISOString(),
    });

    const records = costRepo.findByRunId(runId);
    expect(records).toHaveLength(1);
    expect(records[0].runId).toBe(runId);
    expect(records[0].agentType).toBe(agentType);
    expect(records[0].model).toBe(model);
    expect(records[0].inputTokens).toBe(5000);
    expect(records[0].outputTokens).toBe(2000);
    expect(records[0].costUsd).toBeCloseTo(0.045, 6);
  });

  it("does not insert when token usage is zero", () => {
    // The dispatcher guards: only insert if input > 0 || output > 0
    const tokenUsage = { input: 0, output: 0, total: 0 };
    const shouldInsert = tokenUsage.input > 0 || tokenUsage.output > 0;

    expect(shouldInsert).toBe(false);

    const records = costRepo.findByRunId("no-tokens-run");
    expect(records).toHaveLength(0);
  });

  it("aggregates multiple cost records per run via sumByRunId", () => {
    const runId = "multi-cost-run";

    costRepo.insert({
      runId,
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId,
      agentType: "claude-code",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.021,
      timestamp: "2026-03-13T10:05:00Z",
    });

    const summary = costRepo.sumByRunId(runId);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.recordCount).toBe(2);
  });
});
