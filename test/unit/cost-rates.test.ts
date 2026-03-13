import { describe, it, expect } from "vitest";
import { getModelRate, calculateCost } from "../../src/agent/cost-rates.js";

describe("agent/cost-rates", () => {
  describe("getModelRate", () => {
    it("returns rate for a known model", () => {
      const rate = getModelRate("claude-sonnet-4-20250514");
      expect(rate.inputPerToken).toBe(3 / 1_000_000);
      expect(rate.outputPerToken).toBe(15 / 1_000_000);
    });

    it("falls back to agent type when model is unknown", () => {
      const rate = getModelRate("unknown-model-v2", "claude-code");
      expect(rate.inputPerToken).toBe(3 / 1_000_000);
      expect(rate.outputPerToken).toBe(15 / 1_000_000);
    });

    it("returns fallback rate when neither model nor agent type is known", () => {
      const rate = getModelRate(undefined);
      expect(rate.inputPerToken).toBeGreaterThan(0);
      expect(rate.outputPerToken).toBeGreaterThan(0);
    });

    it("uses user overrides when provided", () => {
      const overrides = {
        "custom-model": { inputPerToken: 1 / 1_000_000, outputPerToken: 2 / 1_000_000 },
      };
      const rate = getModelRate("custom-model", undefined, overrides);
      expect(rate.inputPerToken).toBe(1 / 1_000_000);
      expect(rate.outputPerToken).toBe(2 / 1_000_000);
    });

    it("prefers user overrides over default rates", () => {
      const overrides = {
        "claude-sonnet-4-20250514": { inputPerToken: 99 / 1_000_000, outputPerToken: 99 / 1_000_000 },
      };
      const rate = getModelRate("claude-sonnet-4-20250514", undefined, overrides);
      expect(rate.inputPerToken).toBe(99 / 1_000_000);
    });
  });

  describe("calculateCost", () => {
    it("calculates cost correctly", () => {
      const rate = { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 };
      const cost = calculateCost(1_000_000, 100_000, rate);
      // 1M * $3/M + 100K * $15/M = $3 + $1.5 = $4.5
      expect(cost).toBeCloseTo(4.5, 6);
    });

    it("returns 0 for zero tokens", () => {
      const rate = { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 };
      expect(calculateCost(0, 0, rate)).toBe(0);
    });
  });
});
