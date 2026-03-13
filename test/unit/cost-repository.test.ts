import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";

describe("storage/repositories/costs", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let costRepo: CostRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-cost-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    costRepo = createCostRepository(db);
    runRepo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates a cost record and returns it", () => {
    const row = costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      timestamp: "2026-03-13T10:00:00Z",
    });
    expect(row).toBeDefined();
    expect(row.runId).toBe("run-1");
    expect(row.agentType).toBe("claude-code");
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(500);
    expect(row.costUsd).toBe(0.0105);
    expect(row.timestamp).toBe("2026-03-13T10:00:00Z");
  });

  it("insert() works without model", () => {
    const row = costRepo.insert({
      runId: "run-2",
      agentType: "codex",
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.005,
      timestamp: "2026-03-13T10:00:00Z",
    });
    expect(row.model).toBeNull();
  });

  it("findByRunId() returns all cost records for a run", () => {
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.02,
      timestamp: "2026-03-13T10:05:00Z",
    });
    costRepo.insert({
      runId: "run-2",
      agentType: "codex",
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.005,
      timestamp: "2026-03-13T10:00:00Z",
    });

    const results = costRepo.findByRunId("run-1");
    expect(results).toHaveLength(2);
    expect(results[0].runId).toBe("run-1");
    expect(results[1].runId).toBe("run-1");
  });

  it("sumByRunId() aggregates cost records for a run", () => {
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.02,
      timestamp: "2026-03-13T10:05:00Z",
    });

    const summary = costRepo.sumByRunId("run-1");
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(summary.recordCount).toBe(2);
  });

  it("sumByRunId() returns zeros for nonexistent run", () => {
    const summary = costRepo.sumByRunId("nonexistent");
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.recordCount).toBe(0);
  });

  it("sumByWorkflow() aggregates cost records across runs with same workflow", () => {
    // Create runs with workflows
    runRepo.insert({
      id: "run-1",
      task: "task 1",
      workflow: "code",
      submittedAt: "2026-03-13T10:00:00Z",
    });
    runRepo.insert({
      id: "run-2",
      task: "task 2",
      workflow: "code",
      submittedAt: "2026-03-13T10:00:00Z",
    });
    runRepo.insert({
      id: "run-3",
      task: "task 3",
      workflow: "research",
      submittedAt: "2026-03-13T10:00:00Z",
    });

    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-2",
      agentType: "claude-code",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.02,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-3",
      agentType: "claude-code",
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.005,
      timestamp: "2026-03-13T10:00:00Z",
    });

    const codeSummary = costRepo.sumByWorkflow("code");
    expect(codeSummary.totalInputTokens).toBe(3000);
    expect(codeSummary.totalOutputTokens).toBe(1500);
    expect(codeSummary.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(codeSummary.recordCount).toBe(2);

    const researchSummary = costRepo.sumByWorkflow("research");
    expect(researchSummary.totalInputTokens).toBe(500);
    expect(researchSummary.recordCount).toBe(1);
  });

  it("sumSince() aggregates cost records after a timestamp", () => {
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: "2026-03-12T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-2",
      agentType: "claude-code",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.02,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-3",
      agentType: "claude-code",
      inputTokens: 3000,
      outputTokens: 1500,
      costUsd: 0.03,
      timestamp: "2026-03-13T15:00:00Z",
    });

    const summary = costRepo.sumSince("2026-03-13T00:00:00Z");
    expect(summary.totalInputTokens).toBe(5000);
    expect(summary.totalOutputTokens).toBe(2500);
    expect(summary.totalCostUsd).toBeCloseTo(0.05, 6);
    expect(summary.recordCount).toBe(2);
  });

  it("sumAll() aggregates all cost records", () => {
    costRepo.insert({
      runId: "run-1",
      agentType: "claude-code",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: "2026-03-13T10:00:00Z",
    });
    costRepo.insert({
      runId: "run-2",
      agentType: "codex",
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.02,
      timestamp: "2026-03-13T10:00:00Z",
    });

    const summary = costRepo.sumAll();
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(summary.recordCount).toBe(2);
  });
});
