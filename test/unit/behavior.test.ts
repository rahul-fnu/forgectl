import { describe, it, expect } from "vitest";
import {
  extractToolUsage,
  extractFailurePatterns,
  detectTokenWaste,
  getStuckPoints,
} from "../../src/analysis/behavior.js";
import type { EventRow } from "../../src/storage/repositories/events.js";
import type { CostSummary } from "../../src/storage/repositories/costs.js";

function makeEvent(overrides: Partial<EventRow> & { type: string }): EventRow {
  return {
    id: 1,
    runId: "run-1",
    timestamp: "2026-03-27T10:00:00Z",
    data: null,
    ...overrides,
  };
}

describe("extractToolUsage", () => {
  it("returns empty report for no events", () => {
    const result = extractToolUsage([]);
    expect(result.totalCalls).toBe(0);
    expect(result.byTool).toEqual([]);
  });

  it("counts tracked tool calls", () => {
    const events: EventRow[] = [
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "tool_use", data: { tool: "Write" } }),
      makeEvent({ type: "tool_use", data: { tool: "Bash" } }),
      makeEvent({ type: "tool_use", data: { tool: "Edit" } }),
      makeEvent({ type: "tool_use", data: { tool: "Grep" } }),
      makeEvent({ type: "tool_use", data: { tool: "Glob" } }),
    ];
    const result = extractToolUsage(events);
    expect(result.totalCalls).toBe(7);
    expect(result.byTool.find((t) => t.tool === "Read")!.count).toBe(2);
    expect(result.byTool.find((t) => t.tool === "Write")!.count).toBe(1);
    expect(result.byTool[0].tool).toBe("Read");
  });

  it("ignores non-tracked tools and non-tool events", () => {
    const events: EventRow[] = [
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "tool_use", data: { tool: "CustomTool" } }),
      makeEvent({ type: "started", data: {} }),
    ];
    const result = extractToolUsage(events);
    expect(result.totalCalls).toBe(1);
    expect(result.byTool).toHaveLength(1);
  });

  it("computes percentages correctly", () => {
    const events: EventRow[] = [
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "tool_use", data: { tool: "Bash" } }),
      makeEvent({ type: "tool_use", data: { tool: "Bash" } }),
    ];
    const result = extractToolUsage(events);
    expect(result.totalCalls).toBe(4);
    expect(result.byTool.find((t) => t.tool === "Read")!.pct).toBe(0.5);
    expect(result.byTool.find((t) => t.tool === "Bash")!.pct).toBe(0.5);
  });
});

describe("extractFailurePatterns", () => {
  it("returns empty for no failures", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started", data: {} }),
      makeEvent({ type: "completed", data: {} }),
    ];
    expect(extractFailurePatterns(events)).toEqual([]);
  });

  it("aggregates failure signatures across runs", () => {
    const events: EventRow[] = [
      makeEvent({ type: "failed", runId: "run-1", data: { error: "timeout" } }),
      makeEvent({ type: "failed", runId: "run-2", data: { error: "timeout" } }),
      makeEvent({ type: "failed", runId: "run-3", data: { error: "oom" } }),
    ];
    const result = extractFailurePatterns(events);
    expect(result).toHaveLength(2);
    expect(result[0].signature).toBe("failed:timeout");
    expect(result[0].count).toBe(2);
    expect(result[0].runIds).toEqual(expect.arrayContaining(["run-1", "run-2"]));
    expect(result[1].signature).toBe("failed:oom");
    expect(result[1].count).toBe(1);
  });

  it("captures validation step failures", () => {
    const events: EventRow[] = [
      makeEvent({
        type: "validation_step",
        data: { step: "lint", passed: false },
      }),
      makeEvent({
        type: "validation_step",
        data: { step: "lint", passed: false },
      }),
      makeEvent({
        type: "validation_step",
        data: { step: "test", passed: true },
      }),
    ];
    const result = extractFailurePatterns(events);
    expect(result).toHaveLength(1);
    expect(result[0].signature).toBe("validation:lint");
    expect(result[0].count).toBe(2);
  });

  it("uses reason field as fallback for error", () => {
    const events: EventRow[] = [
      makeEvent({ type: "failed", data: { reason: "crash" } }),
    ];
    const result = extractFailurePatterns(events);
    expect(result[0].signature).toBe("failed:crash");
  });
});

describe("detectTokenWaste", () => {
  const baseCosts: CostSummary = {
    totalInputTokens: 8000,
    totalOutputTokens: 2000,
    totalCostUsd: 0.05,
    recordCount: 1,
  };

  it("returns zero waste with no retries", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started" }),
      makeEvent({ type: "completed" }),
    ];
    const result = detectTokenWaste(events, baseCosts);
    expect(result.totalTokens).toBe(10000);
    expect(result.wastedTokens).toBe(0);
    expect(result.wasteRatio).toBe(0);
    expect(result.revertedSegments).toBe(0);
  });

  it("calculates waste proportional to retry events", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started" }),
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "retry" }),
      makeEvent({ type: "tool_use", data: { tool: "Read" } }),
      makeEvent({ type: "completed" }),
    ];
    const result = detectTokenWaste(events, baseCosts);
    expect(result.totalTokens).toBe(10000);
    expect(result.wastedTokens).toBe(2000); // 1 retry out of 5 events = 20%
    expect(result.wasteRatio).toBe(0.2);
  });

  it("counts loop_detected as reverted segments", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started" }),
      makeEvent({ type: "loop_detected" }),
      makeEvent({ type: "loop_detected" }),
      makeEvent({ type: "completed" }),
    ];
    const result = detectTokenWaste(events, baseCosts);
    expect(result.revertedSegments).toBe(2);
  });

  it("handles empty events", () => {
    const result = detectTokenWaste([], baseCosts);
    expect(result.totalTokens).toBe(10000);
    expect(result.wastedTokens).toBe(0);
    expect(result.wasteRatio).toBe(0);
  });
});

describe("getStuckPoints", () => {
  it("returns empty for fewer than 2 events", () => {
    expect(getStuckPoints([])).toEqual([]);
    expect(getStuckPoints([makeEvent({ type: "started" })])).toEqual([]);
  });

  it("finds disproportionate time gaps", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started", timestamp: "2026-03-27T10:00:00Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:01Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:02Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:03Z" }),
      // big gap: 30 seconds
      makeEvent({ type: "retry", timestamp: "2026-03-27T10:00:33Z" }),
      makeEvent({ type: "completed", timestamp: "2026-03-27T10:00:34Z" }),
    ];
    const result = getStuckPoints(events);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].type).toBe("retry");
    expect(result[0].durationMs).toBe(30000);
  });

  it("returns empty when all gaps are uniform", () => {
    const events: EventRow[] = [
      makeEvent({ type: "started", timestamp: "2026-03-27T10:00:00Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:01Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:02Z" }),
      makeEvent({ type: "completed", timestamp: "2026-03-27T10:00:03Z" }),
    ];
    const result = getStuckPoints(events);
    expect(result).toEqual([]);
  });

  it("sorts stuck points by duration descending", () => {
    // 12 events: ten 1s gaps, then a 30s gap and a 60s gap
    // avg gap = (10*1 + 30 + 60) / 11 = 100/11 ≈ 9.09s, threshold = ~27s
    // Both 30s and 60s exceed threshold
    const events: EventRow[] = [
      makeEvent({ type: "started", timestamp: "2026-03-27T10:00:00Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:01Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:02Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:03Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:04Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:05Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:06Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:07Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:08Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:09Z" }),
      makeEvent({ type: "tool_use", timestamp: "2026-03-27T10:00:10Z" }),
      makeEvent({ type: "retry", timestamp: "2026-03-27T10:00:40Z" }),
      makeEvent({ type: "retry", timestamp: "2026-03-27T10:01:40Z" }),
    ];
    const result = getStuckPoints(events);
    expect(result.length).toBe(2);
    expect(result[0].durationMs).toBe(60000);
    expect(result[1].durationMs).toBe(30000);
  });
});
