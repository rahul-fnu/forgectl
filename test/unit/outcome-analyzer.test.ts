import { describe, it, expect } from "vitest";
import { analyzeOutcomes, compareContextOutcomes, computeContextHitRate, buildCalibrationReport, computeCalibrationFromOutcomes, type AnalysisReport } from "../../src/analysis/outcome-analyzer.js";
import type { OutcomeRow } from "../../src/storage/repositories/outcomes.js";
import type { CalibrationRow } from "../../src/storage/repositories/review-findings.js";

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

describe("compareContextOutcomes", () => {
  it("splits rows by contextEnabled and computes group stats", () => {
    const rows = [
      makeRow({ id: "1", contextEnabled: 1, status: "success", totalTurns: 5, startedAt: "2026-03-20T10:00:00Z", completedAt: "2026-03-20T10:05:00Z" }),
      makeRow({ id: "2", contextEnabled: 1, status: "success", totalTurns: 3, startedAt: "2026-03-20T11:00:00Z", completedAt: "2026-03-20T11:02:00Z" }),
      makeRow({ id: "3", contextEnabled: 0, status: "success", totalTurns: 10, startedAt: "2026-03-20T12:00:00Z", completedAt: "2026-03-20T12:10:00Z" }),
      makeRow({ id: "4", contextEnabled: 0, status: "failure", totalTurns: 15, startedAt: "2026-03-20T13:00:00Z", completedAt: "2026-03-20T13:20:00Z" }),
    ];

    const report = compareContextOutcomes(rows, {});
    expect(report.withContext.runCount).toBe(2);
    expect(report.withoutContext.runCount).toBe(2);
    expect(report.withContext.avgTurns).toBe(4);
    expect(report.withoutContext.avgTurns).toBe(12.5);
    expect(report.withContext.successRate).toBe(1);
    expect(report.withoutContext.successRate).toBe(0.5);
  });

  it("returns empty stats when no rows", () => {
    const report = compareContextOutcomes([], {});
    expect(report.withContext.runCount).toBe(0);
    expect(report.withoutContext.runCount).toBe(0);
    expect(report.contextHitRate).toBe(0);
  });

  it("computes context hit rate from events", () => {
    const contextFiles = JSON.stringify(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const events = JSON.stringify([
      { type: "tool_use", data: { tool: "Read", file: "src/a.ts" } },
      { type: "tool_use", data: { tool: "Read", file: "src/b.ts" } },
      { type: "tool_use", data: { tool: "Read", file: "src/d.ts" } },
    ]);

    const rows = [
      makeRow({ id: "1", contextEnabled: 1, contextFilesJson: contextFiles, rawEventsJson: events }),
    ];

    const hitRate = computeContextHitRate(rows);
    // 2 out of 3 context files were read
    expect(hitRate).toBeCloseTo(0.6667, 3);
  });

  it("returns 0 hit rate when no context files", () => {
    const rows = [
      makeRow({ id: "1", contextEnabled: 0 }),
    ];
    expect(computeContextHitRate(rows)).toBe(0);
  });
});

describe("computeCalibrationFromOutcomes", () => {
  it("identifies false positives when human rubber-stamps MUST_FIX comments", () => {
    const reviewJson = JSON.stringify({
      comments: [
        { file: "src/storage/database.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "fix" },
        { file: "src/storage/schema.ts", line: 5, severity: "MUST_FIX", category: "naming", comment: "rename" },
      ],
      summary: { must_fix: 2, should_fix: 0, nit: 0, overall: "needs work" },
    });

    const rows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp", reviewCommentsJson: reviewJson }),
    ];

    const result = computeCalibrationFromOutcomes(rows);
    const storageStats = result.get("src/storage");
    expect(storageStats).toBeDefined();
    expect(storageStats!.total).toBe(2);
    expect(storageStats!.falsePositives).toBe(2);
  });

  it("does not count as false positive when human does major_rework", () => {
    const reviewJson = JSON.stringify({
      comments: [
        { file: "src/agent/invoke.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "fix" },
      ],
      summary: { must_fix: 1, should_fix: 0, nit: 0, overall: "needs work" },
    });

    const rows = [
      makeRow({ id: "1", humanReviewResult: "major_rework", reviewCommentsJson: reviewJson }),
    ];

    const result = computeCalibrationFromOutcomes(rows);
    const agentStats = result.get("src/agent");
    expect(agentStats).toBeDefined();
    expect(agentStats!.total).toBe(1);
    expect(agentStats!.falsePositives).toBe(0);
  });

  it("skips rows without review comments", () => {
    const rows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp", reviewCommentsJson: null }),
    ];

    const result = computeCalibrationFromOutcomes(rows);
    expect(result.size).toBe(0);
  });

  it("skips rows without MUST_FIX comments", () => {
    const reviewJson = JSON.stringify({
      comments: [
        { file: "src/agent/invoke.ts", line: 10, severity: "NIT", category: "style", comment: "style nit" },
      ],
      summary: { must_fix: 0, should_fix: 0, nit: 1, overall: "looks good" },
    });

    const rows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp", reviewCommentsJson: reviewJson }),
    ];

    const result = computeCalibrationFromOutcomes(rows);
    expect(result.size).toBe(0);
  });
});

describe("buildCalibrationReport", () => {
  it("combines calibration rows with outcome data", () => {
    const calibrationRows: CalibrationRow[] = [
      { id: 1, module: "src/storage", totalComments: 10, overriddenComments: 4, falsePositiveRate: 0.4, lastUpdated: "2026-03-22T00:00:00Z" },
    ];

    const report = buildCalibrationReport(calibrationRows, []);
    expect(report.modules).toHaveLength(1);
    expect(report.modules[0].module).toBe("src/storage");
    expect(report.modules[0].totalComments).toBe(10);
    expect(report.modules[0].falsePositives).toBe(4);
    expect(report.modules[0].rate).toBeCloseTo(0.4);
    expect(report.overall.rate).toBeCloseTo(0.4);
  });

  it("warns when module false positive rate exceeds 30%", () => {
    const calibrationRows: CalibrationRow[] = [
      { id: 1, module: "src/storage", totalComments: 10, overriddenComments: 5, falsePositiveRate: 0.5, lastUpdated: "2026-03-22T00:00:00Z" },
    ];

    const report = buildCalibrationReport(calibrationRows, []);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
    expect(report.warnings[0]).toContain("src/storage");
    expect(report.warnings[0]).toContain("tuning");
  });

  it("does not warn when rate is below 30%", () => {
    const calibrationRows: CalibrationRow[] = [
      { id: 1, module: "src/agent", totalComments: 10, overriddenComments: 1, falsePositiveRate: 0.1, lastUpdated: "2026-03-22T00:00:00Z" },
    ];

    const report = buildCalibrationReport(calibrationRows, []);
    expect(report.warnings).toHaveLength(0);
  });

  it("merges outcome-derived calibration with stored calibration", () => {
    const calibrationRows: CalibrationRow[] = [
      { id: 1, module: "src/storage", totalComments: 5, overriddenComments: 2, falsePositiveRate: 0.4, lastUpdated: "2026-03-22T00:00:00Z" },
    ];

    const reviewJson = JSON.stringify({
      comments: [
        { file: "src/storage/database.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "fix" },
      ],
      summary: { must_fix: 1, should_fix: 0, nit: 0, overall: "needs work" },
    });

    const outcomeRows = [
      makeRow({ id: "1", humanReviewResult: "rubber_stamp", reviewCommentsJson: reviewJson }),
    ];

    const report = buildCalibrationReport(calibrationRows, outcomeRows);
    const storageModule = report.modules.find(m => m.module === "src/storage");
    expect(storageModule).toBeDefined();
    expect(storageModule!.totalComments).toBe(6);
    expect(storageModule!.falsePositives).toBe(3);
    expect(storageModule!.rate).toBeCloseTo(0.5);
  });

  it("returns empty report when no data", () => {
    const report = buildCalibrationReport([], []);
    expect(report.modules).toHaveLength(0);
    expect(report.overall.totalComments).toBe(0);
    expect(report.overall.rate).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });
});
