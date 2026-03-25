import { describe, it, expect } from "vitest";
import { checkCostCeiling, BudgetExceededError } from "../../src/agent/budget.js";

describe("checkCostCeiling", () => {
  it("passes when under cost limit", () => {
    const result = checkCostCeiling(
      { inputTokens: 1000, outputTokens: 500, costUsd: 0.50 },
      { maxCostUsd: 1.00 },
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBeCloseTo(50, 0);
  });

  it("fails when cost exceeds maxCostUsd", () => {
    const result = checkCostCeiling(
      { inputTokens: 100000, outputTokens: 50000, costUsd: 5.00 },
      { maxCostUsd: 1.00 },
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("Cost");
    expect(result.reason).toContain("exceeds ceiling");
    expect(result.percentUsed).toBe(500);
  });

  it("fails when tokens exceed maxTokens", () => {
    const result = checkCostCeiling(
      { inputTokens: 8000, outputTokens: 4000, costUsd: 0.01 },
      { maxTokens: 10000 },
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("Token usage");
    expect(result.reason).toContain("exceeds ceiling");
    expect(result.percentUsed).toBe(120);
  });

  it("triggers 80% warning at correct threshold", () => {
    const result = checkCostCeiling(
      { inputTokens: 1000, outputTokens: 500, costUsd: 0.85 },
      { maxCostUsd: 1.00 },
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBeGreaterThanOrEqual(80);
  });

  it("does not trigger 80% warning when well under limit", () => {
    const result = checkCostCeiling(
      { inputTokens: 100, outputTokens: 50, costUsd: 0.10 },
      { maxCostUsd: 1.00 },
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBeLessThan(80);
  });

  it("works with only maxCostUsd set", () => {
    const result = checkCostCeiling(
      { inputTokens: 100000, outputTokens: 50000, costUsd: 0.50 },
      { maxCostUsd: 1.00 },
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBeCloseTo(50, 0);
  });

  it("works with only maxTokens set", () => {
    const result = checkCostCeiling(
      { inputTokens: 3000, outputTokens: 2000, costUsd: 10.00 },
      { maxTokens: 10000 },
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBeCloseTo(50, 0);
  });

  it("returns 0 percentUsed when no limits are set", () => {
    const result = checkCostCeiling(
      { inputTokens: 100000, outputTokens: 50000, costUsd: 100.00 },
      {},
    );
    expect(result.exceeded).toBe(false);
    expect(result.percentUsed).toBe(0);
  });

  it("checks cost before tokens (cost exceeded first)", () => {
    const result = checkCostCeiling(
      { inputTokens: 500, outputTokens: 500, costUsd: 2.00 },
      { maxCostUsd: 1.00, maxTokens: 100000 },
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("Cost");
  });

  it("reports token exceeded when cost is fine but tokens are over", () => {
    const result = checkCostCeiling(
      { inputTokens: 8000, outputTokens: 4000, costUsd: 0.01 },
      { maxCostUsd: 1.00, maxTokens: 10000 },
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("Token usage");
  });
});

describe("BudgetExceededError", () => {
  it("has correct properties", () => {
    const err = new BudgetExceededError("per_run", 5.0, 1.0);
    expect(err.name).toBe("BudgetExceededError");
    expect(err.kind).toBe("per_run");
    expect(err.currentCost).toBe(5.0);
    expect(err.limit).toBe(1.0);
    expect(err.message).toContain("Budget exceeded");
  });
});
