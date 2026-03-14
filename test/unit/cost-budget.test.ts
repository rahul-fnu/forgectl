import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { checkBudget, getBudgetStatus, BudgetExceededError } from "../../src/agent/budget.js";

describe("agent/budget", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let costRepo: CostRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-budget-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    costRepo = createCostRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("checkBudget", () => {
    it("does not throw when under per-run budget", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.01,
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        checkBudget(costRepo, "run-1", { max_cost_per_run: 1.00 });
      }).not.toThrow();
    });

    it("throws BudgetExceededError when over per-run budget", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 100000,
        outputTokens: 50000,
        costUsd: 5.00,
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        checkBudget(costRepo, "run-1", { max_cost_per_run: 1.00 });
      }).toThrow(BudgetExceededError);
    });

    it("throws BudgetExceededError with correct kind for per-run", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 100000,
        outputTokens: 50000,
        costUsd: 5.00,
        timestamp: new Date().toISOString(),
      });

      try {
        checkBudget(costRepo, "run-1", { max_cost_per_run: 1.00 });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        expect((err as BudgetExceededError).kind).toBe("per_run");
        expect((err as BudgetExceededError).currentCost).toBe(5.00);
        expect((err as BudgetExceededError).limit).toBe(1.00);
      }
    });

    it("throws BudgetExceededError when over per-day budget", () => {
      // Insert a cost record for today
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 100000,
        outputTokens: 50000,
        costUsd: 10.00,
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        checkBudget(costRepo, "run-2", { max_cost_per_day: 5.00 });
      }).toThrow(BudgetExceededError);
    });

    it("does not throw when no budget limits are set", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 100000,
        outputTokens: 50000,
        costUsd: 100.00,
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        checkBudget(costRepo, "run-1", {});
      }).not.toThrow();
    });

    it("does not throw for a fresh run with no costs", () => {
      expect(() => {
        checkBudget(costRepo, "fresh-run", { max_cost_per_run: 1.00, max_cost_per_day: 10.00 });
      }).not.toThrow();
    });
  });

  describe("getBudgetStatus", () => {
    it("returns status with no budget limits", () => {
      const status = getBudgetStatus(costRepo, "run-1", undefined);
      expect(status.runCostUsd).toBe(0);
      expect(status.maxPerRun).toBeNull();
      expect(status.maxPerDay).toBeNull();
      expect(status.withinBudget).toBe(true);
    });

    it("returns correct status when within budget", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.01,
        timestamp: new Date().toISOString(),
      });

      const status = getBudgetStatus(costRepo, "run-1", { max_cost_per_run: 1.00 });
      expect(status.runCostUsd).toBeCloseTo(0.01, 6);
      expect(status.maxPerRun).toBe(1.00);
      expect(status.withinBudget).toBe(true);
    });

    it("returns withinBudget=false when over budget", () => {
      costRepo.insert({
        runId: "run-1",
        agentType: "claude-code",
        inputTokens: 100000,
        outputTokens: 50000,
        costUsd: 5.00,
        timestamp: new Date().toISOString(),
      });

      const status = getBudgetStatus(costRepo, "run-1", { max_cost_per_run: 1.00 });
      expect(status.withinBudget).toBe(false);
    });
  });
});
