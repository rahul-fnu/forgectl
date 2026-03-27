import { describe, it, expect } from "vitest";
import {
  detectAnomalies,
  DEFAULT_CONFIG,
  type RunCostInfo,
  type GapIssue,
} from "../../src/analysis/anomaly-detector.js";
import type { OutcomeRow } from "../../src/storage/repositories/outcomes.js";

function makeRow(overrides: Partial<OutcomeRow> & { id: string }): OutcomeRow {
  return {
    taskId: null,
    startedAt: null,
    completedAt: null,
    status: null,
    totalTurns: null,
    lintIterations: null,
    reviewRounds: null,
    reviewCommentsJson: null,
    failureMode: null,
    failureDetail: null,
    humanReviewResult: null,
    humanReviewComments: null,
    modulesTouched: null,
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

describe("anomaly-detector", () => {
  describe("disabled config", () => {
    it("returns empty when disabled", () => {
      const outcomes = [makeRow({ id: "1", status: "failure", failureMode: "LOOP" })];
      const result = detectAnomalies(outcomes, [], [], { enabled: false });
      expect(result).toEqual([]);
    });
  });

  describe("repeated validation failures", () => {
    it("detects repeated failure mode", () => {
      const outcomes = Array.from({ length: 6 }, (_, i) =>
        makeRow({ id: `r${i}`, status: "failure", failureMode: "LOOP" }),
      );
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "repeated_validation_failure");
      expect(found).toBeDefined();
      expect(found!.summary).toContain("LOOP");
      expect(found!.severity).toBe("critical");
    });

    it("detects repeated validation step failures from events", () => {
      const events = JSON.stringify([
        { type: "validation_step", data: { step: "lint" } },
      ]);
      const outcomes = Array.from({ length: 6 }, (_, i) =>
        makeRow({ id: `r${i}`, status: "failure", rawEventsJson: events }),
      );
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(
        a => a.type === "repeated_validation_failure" && a.summary.includes("lint"),
      );
      expect(found).toBeDefined();
    });

    it("does not trigger below threshold", () => {
      const outcomes = [
        makeRow({ id: "1", status: "failure", failureMode: "LOOP" }),
        makeRow({ id: "2", status: "failure", failureMode: "LOOP" }),
        makeRow({ id: "3", status: "success" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "repeated_validation_failure");
      expect(found).toBeUndefined();
    });

    it("respects custom threshold", () => {
      const outcomes = [
        makeRow({ id: "1", status: "failure", failureMode: "TIMEOUT" }),
        makeRow({ id: "2", status: "failure", failureMode: "TIMEOUT" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], [], {
        repeated_failure_threshold: 2,
      });
      const found = anomalies.find(a => a.type === "repeated_validation_failure");
      expect(found).toBeDefined();
    });
  });

  describe("cost spike", () => {
    it("detects cost spike above multiplier", () => {
      const costs: RunCostInfo[] = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.2 },
        { runId: "r3", costUsd: 0.8 },
        { runId: "r4", costUsd: 10.0 },
      ];
      const anomalies = detectAnomalies([], costs, []);
      const found = anomalies.find(a => a.type === "cost_spike");
      expect(found).toBeDefined();
      expect(found!.summary).toContain("r4");
      expect(found!.severity).toBe("critical");
    });

    it("does not trigger when cost is within range", () => {
      const costs: RunCostInfo[] = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.2 },
        { runId: "r3", costUsd: 2.5 },
      ];
      const anomalies = detectAnomalies([], costs, []);
      const found = anomalies.find(a => a.type === "cost_spike");
      expect(found).toBeUndefined();
    });

    it("handles single run (no spike possible)", () => {
      const costs: RunCostInfo[] = [{ runId: "r1", costUsd: 100.0 }];
      const anomalies = detectAnomalies([], costs, []);
      const found = anomalies.find(a => a.type === "cost_spike");
      expect(found).toBeUndefined();
    });

    it("respects custom multiplier", () => {
      const costs: RunCostInfo[] = [
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 1.0 },
        { runId: "r3", costUsd: 2.5 },
      ];
      const anomalies = detectAnomalies([], costs, [], {
        cost_spike_multiplier: 2,
      });
      const found = anomalies.find(a => a.type === "cost_spike");
      expect(found).toBeDefined();
    });
  });

  describe("success rate drop", () => {
    it("detects low success rate", () => {
      const outcomes = [
        ...Array.from({ length: 7 }, (_, i) =>
          makeRow({ id: `f${i}`, status: "failure" }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          makeRow({ id: `s${i}`, status: "success" }),
        ),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "success_rate_drop");
      expect(found).toBeDefined();
      expect(found!.summary).toContain("30%");
    });

    it("does not trigger when success rate is acceptable", () => {
      const outcomes = [
        ...Array.from({ length: 2 }, (_, i) =>
          makeRow({ id: `f${i}`, status: "failure" }),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          makeRow({ id: `s${i}`, status: "success" }),
        ),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "success_rate_drop");
      expect(found).toBeUndefined();
    });

    it("does not trigger with fewer than 5 runs", () => {
      const outcomes = [
        makeRow({ id: "1", status: "failure" }),
        makeRow({ id: "2", status: "failure" }),
        makeRow({ id: "3", status: "failure" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "success_rate_drop");
      expect(found).toBeUndefined();
    });

    it("critical severity when rate is very low", () => {
      const outcomes = Array.from({ length: 10 }, (_, i) =>
        makeRow({ id: `f${i}`, status: "failure" }),
      );
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "success_rate_drop");
      expect(found).toBeDefined();
      expect(found!.severity).toBe("critical");
    });
  });

  describe("systemic failure", () => {
    it("detects same failure signature across 3+ issues", () => {
      const outcomes = [
        makeRow({ id: "r1", taskId: "issue-1", failureMode: "LINT", failureDetail: "error TS2345" }),
        makeRow({ id: "r2", taskId: "issue-2", failureMode: "LINT", failureDetail: "error TS2345" }),
        makeRow({ id: "r3", taskId: "issue-3", failureMode: "LINT", failureDetail: "error TS2345" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "systemic_failure");
      expect(found).toBeDefined();
      expect(found!.summary).toContain("3");
    });

    it("does not trigger when fewer than 3 issues affected", () => {
      const outcomes = [
        makeRow({ id: "r1", taskId: "issue-1", failureMode: "LINT", failureDetail: "error TS2345" }),
        makeRow({ id: "r2", taskId: "issue-2", failureMode: "LINT", failureDetail: "error TS2345" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "systemic_failure");
      expect(found).toBeUndefined();
    });

    it("normalizes hashes and timestamps in failure details", () => {
      const outcomes = [
        makeRow({ id: "r1", taskId: "issue-1", failureMode: "BUILD", failureDetail: "error at abc123def456 line 42" }),
        makeRow({ id: "r2", taskId: "issue-2", failureMode: "BUILD", failureDetail: "error at fff999aaa111 line 99" }),
        makeRow({ id: "r3", taskId: "issue-3", failureMode: "BUILD", failureDetail: "error at 111222333444 line 10" }),
      ];
      const anomalies = detectAnomalies(outcomes, [], []);
      const found = anomalies.find(a => a.type === "systemic_failure");
      expect(found).toBeDefined();
    });
  });

  describe("coverage decay", () => {
    it("detects 5+ gap issues in a week", () => {
      const now = new Date();
      const gaps: GapIssue[] = Array.from({ length: 6 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(now.getTime() - i * 3600_000).toISOString(),
      }));
      const anomalies = detectAnomalies([], [], gaps);
      const found = anomalies.find(a => a.type === "coverage_decay");
      expect(found).toBeDefined();
      expect(found!.summary).toContain("6");
    });

    it("does not trigger with old gap issues", () => {
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600_000);
      const gaps: GapIssue[] = Array.from({ length: 10 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(twoWeeksAgo.getTime() - i * 3600_000).toISOString(),
      }));
      const anomalies = detectAnomalies([], [], gaps);
      const found = anomalies.find(a => a.type === "coverage_decay");
      expect(found).toBeUndefined();
    });

    it("does not trigger with fewer than 5 gap issues", () => {
      const now = new Date();
      const gaps: GapIssue[] = Array.from({ length: 4 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(now.getTime() - i * 3600_000).toISOString(),
      }));
      const anomalies = detectAnomalies([], [], gaps);
      const found = anomalies.find(a => a.type === "coverage_decay");
      expect(found).toBeUndefined();
    });

    it("critical severity with 10+ gaps", () => {
      const now = new Date();
      const gaps: GapIssue[] = Array.from({ length: 12 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(now.getTime() - i * 3600_000).toISOString(),
      }));
      const anomalies = detectAnomalies([], [], gaps);
      const found = anomalies.find(a => a.type === "coverage_decay");
      expect(found).toBeDefined();
      expect(found!.severity).toBe("critical");
    });
  });

  describe("multiple anomalies", () => {
    it("returns multiple anomalies when multiple conditions are met", () => {
      const outcomes = Array.from({ length: 10 }, (_, i) =>
        makeRow({
          id: `r${i}`,
          status: "failure",
          failureMode: "LOOP",
          taskId: `issue-${i}`,
        }),
      );
      const costs: RunCostInfo[] = [
        { runId: "r0", costUsd: 1.0 },
        { runId: "r1", costUsd: 1.0 },
        { runId: "r2", costUsd: 20.0 },
      ];
      const now = new Date();
      const gaps: GapIssue[] = Array.from({ length: 6 }, (_, i) => ({
        id: `gap-${i}`,
        createdAt: new Date(now.getTime() - i * 3600_000).toISOString(),
      }));

      const anomalies = detectAnomalies(outcomes, costs, gaps);
      const types = new Set(anomalies.map(a => a.type));
      expect(types.has("repeated_validation_failure")).toBe(true);
      expect(types.has("cost_spike")).toBe(true);
      expect(types.has("success_rate_drop")).toBe(true);
      expect(types.has("coverage_decay")).toBe(true);
    });
  });

  describe("anomaly structure", () => {
    it("returns well-formed anomaly objects", () => {
      const outcomes = Array.from({ length: 6 }, (_, i) =>
        makeRow({ id: `r${i}`, status: "failure", failureMode: "LOOP" }),
      );
      const anomalies = detectAnomalies(outcomes, [], []);
      for (const a of anomalies) {
        expect(a.type).toBeDefined();
        expect(a.severity).toMatch(/^(info|warning|critical)$/);
        expect(a.summary).toBeTruthy();
        expect(Array.isArray(a.evidence)).toBe(true);
        expect(a.suggestedAction).toBeTruthy();
      }
    });
  });
});
