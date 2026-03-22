import { describe, it, expect } from "vitest";
import { analyzeOutcomes, type AnalysisReport } from "../../src/analysis/outcome-analyzer.js";
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
    ...overrides,
  };
}

describe("analyzeOutcomes", () => {
  it("returns empty report for no rows", () => {
    const report = analyzeOutcomes([], {});
    expect(report.totalRuns).toBe(0);
    expect(report.rubberStampRate).toBe(0);
    expect(report.topFailureModes).toEqual([]);
    expect(report.riskyModules).toEqual([]);
    expect(report.turnEstimationBias).toBe(0);
    expect(report.recommendations).toEqual([]);
  });

  it("computes rubber stamp rate correctly", () => {
    const rows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "2", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "3", humanReviewResult: "rejected" }),
      makeRow({ id: "4", humanReviewResult: null }), // not reviewed
    ];
    const report = analyzeOutcomes(rows, {});
    // 2 rubber stamps out of 3 reviewed = 0.6667
    expect(report.rubberStampRate).toBeCloseTo(0.6667, 3);
  });

  it("computes failure mode distribution", () => {
    const rows = [
      makeRow({ id: "1", failureMode: "LOOP", status: "failure" }),
      makeRow({ id: "2", failureMode: "LOOP", status: "failure" }),
      makeRow({ id: "3", failureMode: "MISSING_CONTEXT", status: "failure" }),
      makeRow({ id: "4", failureMode: null, status: "success" }),
    ];
    const report = analyzeOutcomes(rows, {});
    expect(report.topFailureModes).toHaveLength(2);
    expect(report.topFailureModes[0].mode).toBe("LOOP");
    expect(report.topFailureModes[0].count).toBe(2);
    expect(report.topFailureModes[0].pct).toBe(0.5);
    expect(report.topFailureModes[1].mode).toBe("MISSING_CONTEXT");
    expect(report.topFailureModes[1].count).toBe(1);
    expect(report.topFailureModes[1].pct).toBe(0.25);
  });

  it("identifies risky modules", () => {
    const rows = [
      makeRow({
        id: "1",
        status: "failure",
        failureMode: "LOOP",
        lintIterations: 5,
        modulesTouched: JSON.stringify(["src/auth", "src/config"]),
      }),
      makeRow({
        id: "2",
        status: "success",
        lintIterations: 1,
        modulesTouched: JSON.stringify(["src/auth"]),
      }),
      makeRow({
        id: "3",
        status: "success",
        lintIterations: 0,
        modulesTouched: JSON.stringify(["src/config"]),
      }),
    ];
    const report = analyzeOutcomes(rows, {});

    const authModule = report.riskyModules.find(m => m.module === "src/auth");
    expect(authModule).toBeDefined();
    // src/auth: 1 failure out of 2 runs = 50%
    expect(authModule!.failureRate).toBe(0.5);
    // src/auth: (5 + 1) / 2 = 3
    expect(authModule!.avgRetries).toBe(3);

    const configModule = report.riskyModules.find(m => m.module === "src/config");
    expect(configModule).toBeDefined();
    // src/config: 1 failure out of 2 = 50%
    expect(configModule!.failureRate).toBe(0.5);
    // src/config: (5 + 0) / 2 = 2.5
    expect(configModule!.avgRetries).toBe(2.5);
  });

  it("computes turn estimation bias (average turns)", () => {
    const rows = [
      makeRow({ id: "1", totalTurns: 10 }),
      makeRow({ id: "2", totalTurns: 20 }),
      makeRow({ id: "3", totalTurns: null }), // excluded
    ];
    const report = analyzeOutcomes(rows, {});
    expect(report.turnEstimationBias).toBe(15);
  });

  it("filters by --since duration", () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const rows = [
      makeRow({ id: "1", completedAt: twoDaysAgo, status: "success" }),
      makeRow({ id: "2", completedAt: tenDaysAgo, status: "failure" }),
    ];

    const report = analyzeOutcomes(rows, { since: "7d" });
    expect(report.totalRuns).toBe(1);
  });

  it("filters by --module", () => {
    const rows = [
      makeRow({ id: "1", modulesTouched: JSON.stringify(["src/auth", "src/config"]) }),
      makeRow({ id: "2", modulesTouched: JSON.stringify(["src/output"]) }),
      makeRow({ id: "3", modulesTouched: null }),
    ];

    const report = analyzeOutcomes(rows, { module: "src/auth" });
    expect(report.totalRuns).toBe(1);
  });

  it("filters by module with prefix matching", () => {
    const rows = [
      makeRow({ id: "1", modulesTouched: JSON.stringify(["src/auth/login"]) }),
      makeRow({ id: "2", modulesTouched: JSON.stringify(["src/output"]) }),
    ];

    const report = analyzeOutcomes(rows, { module: "src/auth" });
    expect(report.totalRuns).toBe(1);
  });

  it("extracts review comment categories", () => {
    const reviewJson = JSON.stringify({
      comments: [
        { file: "a.ts", line: 1, severity: "MUST_FIX", category: "error-handling", comment: "fix" },
        { file: "b.ts", line: 2, severity: "NIT", category: "naming", comment: "rename" },
        { file: "c.ts", line: 3, severity: "SHOULD_FIX", category: "error-handling", comment: "catch" },
      ],
      summary: { must_fix: 1, should_fix: 1, nit: 1, overall: "needs work" },
    });

    const rows = [
      makeRow({ id: "1", reviewCommentsJson: reviewJson }),
    ];

    const report = analyzeOutcomes(rows, {});
    // Should generate recommendation about top categories
    const catRec = report.recommendations.find(r => r.includes("review comment categories"));
    expect(catRec).toBeDefined();
    expect(catRec).toContain("error-handling");
  });

  it("generates LOOP recommendation when rate is high", () => {
    const rows = [
      makeRow({ id: "1", failureMode: "LOOP", status: "failure" }),
      makeRow({ id: "2", failureMode: "LOOP", status: "failure" }),
      makeRow({ id: "3", status: "success" }),
    ];

    const report = analyzeOutcomes(rows, {});
    const loopRec = report.recommendations.find(r => r.includes("LOOP"));
    expect(loopRec).toBeDefined();
  });

  it("generates high retry module recommendation", () => {
    const rows = [
      makeRow({ id: "1", lintIterations: 5, modulesTouched: JSON.stringify(["src/auth"]), status: "failure", failureMode: "LOOP" }),
      makeRow({ id: "2", lintIterations: 4, modulesTouched: JSON.stringify(["src/auth"]), status: "failure", failureMode: "LOOP" }),
    ];

    const report = analyzeOutcomes(rows, {});
    const retryRec = report.recommendations.find(r => r.includes("high retry"));
    expect(retryRec).toBeDefined();
    expect(retryRec).toContain("src/auth");
  });

  it("generates rubber stamp recommendation when rate is high", () => {
    const rows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "2", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "3", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "4", humanReviewResult: "rubber_stamp" }),
      makeRow({ id: "5", humanReviewResult: "rejected" }),
    ];

    const report = analyzeOutcomes(rows, {});
    const rec = report.recommendations.find(r => r.includes("Rubber stamp rate"));
    expect(rec).toBeDefined();
    expect(rec).toContain("reducing review overhead");
  });

  it("computes period from timestamps", () => {
    const rows = [
      makeRow({ id: "1", completedAt: "2026-03-20T10:00:00Z" }),
      makeRow({ id: "2", completedAt: "2026-03-22T10:00:00Z" }),
      makeRow({ id: "3", startedAt: "2026-03-19T10:00:00Z" }),
    ];

    const report = analyzeOutcomes(rows, {});
    expect(report.period.from).toBe("2026-03-19T10:00:00Z");
    expect(report.period.to).toBe("2026-03-22T10:00:00Z");
  });

  it("handles malformed JSON in modulesTouched gracefully", () => {
    const rows = [
      makeRow({ id: "1", modulesTouched: "not-json" }),
      makeRow({ id: "2", modulesTouched: JSON.stringify(["src/auth"]) }),
    ];

    const report = analyzeOutcomes(rows, { module: "src/auth" });
    expect(report.totalRuns).toBe(1);
  });

  it("handles malformed reviewCommentsJson gracefully", () => {
    const rows = [
      makeRow({ id: "1", reviewCommentsJson: "not-json" }),
    ];

    // Should not throw
    const report = analyzeOutcomes(rows, {});
    expect(report.totalRuns).toBe(1);
  });
});
