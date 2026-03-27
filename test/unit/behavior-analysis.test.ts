import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { analyzeToolUsage, analyzeFailurePatterns, analyzeTokenWaste } from "../../src/analysis/outcome-analyzer.js";
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

describe("analyzeToolUsage", () => {
  it("returns empty report for no rows", () => {
    const report = analyzeToolUsage([]);
    expect(report.totalRuns).toBe(0);
    expect(report.totalTurns).toBe(0);
    expect(report.totalLintIterations).toBe(0);
    expect(report.totalFilesChanged).toBe(0);
    expect(report.totalTestsAdded).toBe(0);
    expect(report.toolBreakdown).toEqual([]);
  });

  it("aggregates turns, iterations, files, and tests", () => {
    const rows = [
      makeRow({ id: "1", totalTurns: 5, lintIterations: 2, filesChanged: 3, testsAdded: 1 }),
      makeRow({ id: "2", totalTurns: 10, lintIterations: null, filesChanged: 5, testsAdded: 2 }),
    ];
    const report = analyzeToolUsage(rows);
    expect(report.totalRuns).toBe(2);
    expect(report.totalTurns).toBe(15);
    expect(report.totalLintIterations).toBe(2);
    expect(report.totalFilesChanged).toBe(8);
    expect(report.totalTestsAdded).toBe(3);
  });

  it("extracts tool usage from rawEventsJson", () => {
    const events = JSON.stringify([
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Edit" } },
      { type: "other", data: {} },
    ]);
    const rows = [makeRow({ id: "1", rawEventsJson: events })];
    const report = analyzeToolUsage(rows);
    expect(report.toolBreakdown).toHaveLength(2);
    expect(report.toolBreakdown[0]).toEqual({ tool: "Read", count: 2 });
    expect(report.toolBreakdown[1]).toEqual({ tool: "Edit", count: 1 });
  });

  it("handles malformed rawEventsJson", () => {
    const rows = [makeRow({ id: "1", rawEventsJson: "not-json" })];
    const report = analyzeToolUsage(rows);
    expect(report.toolBreakdown).toEqual([]);
  });

  it("sorts tool breakdown by count descending", () => {
    const events = JSON.stringify([
      { type: "tool_use", data: { tool: "Write" } },
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Edit" } },
      { type: "tool_use", data: { tool: "Edit" } },
    ]);
    const rows = [makeRow({ id: "1", rawEventsJson: events })];
    const report = analyzeToolUsage(rows);
    expect(report.toolBreakdown[0].tool).toBe("Read");
    expect(report.toolBreakdown[1].tool).toBe("Edit");
    expect(report.toolBreakdown[2].tool).toBe("Write");
  });
});

describe("analyzeFailurePatterns", () => {
  it("returns empty report for no rows", () => {
    const report = analyzeFailurePatterns([]);
    expect(report.totalRuns).toBe(0);
    expect(report.failedRuns).toBe(0);
    expect(report.topFailureModes).toEqual([]);
    expect(report.stuckPoints).toEqual([]);
  });

  it("identifies failure modes", () => {
    const rows = [
      makeRow({ id: "1", status: "failure", failureMode: "LOOP" }),
      makeRow({ id: "2", status: "failure", failureMode: "LOOP" }),
      makeRow({ id: "3", status: "failure", failureMode: "MISSING_CONTEXT" }),
      makeRow({ id: "4", status: "success" }),
    ];
    const report = analyzeFailurePatterns(rows);
    expect(report.failedRuns).toBe(3);
    expect(report.topFailureModes[0].mode).toBe("LOOP");
    expect(report.topFailureModes[0].count).toBe(2);
  });

  it("identifies stuck points (high turns or retries)", () => {
    const rows = [
      makeRow({ id: "r1", status: "failure", failureMode: "LOOP", totalTurns: 20, lintIterations: 5 }),
      makeRow({ id: "r2", status: "failure", failureMode: "TIMEOUT", totalTurns: 3, lintIterations: 1 }),
      makeRow({ id: "r3", status: "failure", failureMode: "VALIDATION_FAILED", totalTurns: 5, lintIterations: 4 }),
    ];
    const report = analyzeFailurePatterns(rows);
    expect(report.stuckPoints.length).toBe(2);
    expect(report.stuckPoints[0].runId).toBe("r1");
    expect(report.stuckPoints[0].turns).toBe(20);
    expect(report.stuckPoints[1].runId).toBe("r3");
  });

  it("limits stuck points to 20", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({ id: `r${i}`, status: "failure", failureMode: "LOOP", totalTurns: 15, lintIterations: 5 }),
    );
    const report = analyzeFailurePatterns(rows);
    expect(report.stuckPoints.length).toBe(20);
  });
});

describe("analyzeTokenWaste", () => {
  it("returns empty report for no rows", () => {
    const report = analyzeTokenWaste([], new Map());
    expect(report.totalRuns).toBe(0);
    expect(report.failedRuns).toBe(0);
    expect(report.totalTokens).toEqual({ input: 0, output: 0 });
    expect(report.wastedTokens).toEqual({ input: 0, output: 0 });
    expect(report.totalCostUsd).toBe(0);
    expect(report.wastedCostUsd).toBe(0);
  });

  it("computes total and wasted tokens from cost data", () => {
    const rows = [
      makeRow({ id: "r1", status: "failure" }),
      makeRow({ id: "r2", status: "success" }),
    ];
    const costs = new Map([
      ["r1", { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 }],
      ["r2", { inputTokens: 800, outputTokens: 400, costUsd: 0.03 }],
    ]);
    const report = analyzeTokenWaste(rows, costs);
    expect(report.totalTokens).toEqual({ input: 1800, output: 900 });
    expect(report.wastedTokens).toEqual({ input: 1000, output: 500 });
    expect(report.totalCostUsd).toBe(0.08);
    expect(report.wastedCostUsd).toBe(0.05);
  });

  it("identifies high-retry runs", () => {
    const rows = [
      makeRow({ id: "r1", status: "success", lintIterations: 5, totalTurns: 20 }),
      makeRow({ id: "r2", status: "success", lintIterations: 1, totalTurns: 3 }),
      makeRow({ id: "r3", status: "failure", lintIterations: 3, totalTurns: 10 }),
    ];
    const report = analyzeTokenWaste(rows, new Map());
    expect(report.highRetryRuns.length).toBe(2);
    expect(report.highRetryRuns[0].runId).toBe("r1");
    expect(report.highRetryRuns[0].lintIterations).toBe(5);
  });

  it("limits high-retry runs to 20", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({ id: `r${i}`, status: "success", lintIterations: 5 }),
    );
    const report = analyzeTokenWaste(rows, new Map());
    expect(report.highRetryRuns.length).toBe(20);
  });
});

describe("CLI formatting functions", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("analyzeToolUsage produces structured output suitable for CLI display", () => {
    const events = JSON.stringify([
      { type: "tool_use", data: { tool: "Read" } },
      { type: "tool_use", data: { tool: "Edit" } },
    ]);
    const rows = [makeRow({ id: "1", totalTurns: 5, filesChanged: 3, testsAdded: 1, rawEventsJson: events })];
    const report = analyzeToolUsage(rows);

    expect(report.totalRuns).toBe(1);
    expect(report.totalTurns).toBe(5);
    expect(report.toolBreakdown.length).toBe(2);
    expect(report.toolBreakdown.every(t => typeof t.tool === "string" && typeof t.count === "number")).toBe(true);
  });

  it("analyzeFailurePatterns stuckPoints have required fields for display", () => {
    const rows = [
      makeRow({ id: "r1", status: "failure", failureMode: "LOOP", failureDetail: "Stuck on lint", totalTurns: 15 }),
    ];
    const report = analyzeFailurePatterns(rows);
    expect(report.stuckPoints[0]).toEqual({
      runId: "r1",
      failureMode: "LOOP",
      detail: "Stuck on lint",
      turns: 15,
    });
  });

  it("analyzeTokenWaste report fields are suitable for formatted display", () => {
    const rows = [makeRow({ id: "r1", status: "failure" })];
    const costs = new Map([["r1", { inputTokens: 1000, outputTokens: 500, costUsd: 0.0512 }]]);
    const report = analyzeTokenWaste(rows, costs);

    expect(typeof report.totalCostUsd).toBe("number");
    expect(typeof report.wastedCostUsd).toBe("number");
    expect(report.totalCostUsd).toBe(0.0512);
  });
});
