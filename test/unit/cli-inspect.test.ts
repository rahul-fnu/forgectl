import { describe, it, expect } from "vitest";
import { formatTimeline, formatInspectHeader } from "../../src/cli/inspect.js";
import type { EventRow } from "../../src/storage/repositories/events.js";
import type { RunRow } from "../../src/storage/repositories/runs.js";

function makeEvent(overrides: Partial<EventRow> & { type: string; timestamp: string }): EventRow {
  return {
    id: 1,
    runId: "run-abc",
    data: null,
    ...overrides,
  };
}

function makeRun(overrides?: Partial<RunRow>): RunRow {
  return {
    id: "run-abc",
    task: "Fix the login bug",
    workflow: "code",
    status: "completed",
    options: null,
    submittedAt: "2026-03-10T00:00:00Z",
    startedAt: "2026-03-10T00:00:01Z",
    completedAt: "2026-03-10T00:05:00Z",
    result: null,
    error: null,
    ...overrides,
  };
}

describe("formatInspectHeader", () => {
  it("formats run header with all fields", () => {
    const run = makeRun();
    const header = formatInspectHeader(run);

    expect(header).toContain("Run: run-abc");
    expect(header).toContain("Task: Fix the login bug");
    expect(header).toContain("Workflow: code");
    expect(header).toContain("Status: completed");
    expect(header).toContain("Duration:");
  });

  it("shows N/A for missing workflow", () => {
    const run = makeRun({ workflow: null });
    const header = formatInspectHeader(run);
    expect(header).toContain("Workflow: N/A");
  });

  it("shows N/A duration when no startedAt", () => {
    const run = makeRun({ startedAt: null, completedAt: null });
    const header = formatInspectHeader(run);
    expect(header).toContain("Duration: N/A");
  });
});

describe("formatTimeline", () => {
  it("shows single event at 00:00", () => {
    const events: EventRow[] = [
      makeEvent({ id: 1, type: "started", timestamp: "2026-03-10T00:00:00Z", data: {} }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("00:00");
    expect(result).toContain("[started]");
  });

  it("calculates correct relative timestamps", () => {
    const events: EventRow[] = [
      makeEvent({ id: 1, type: "started", timestamp: "2026-03-10T00:00:00Z", data: {} }),
      makeEvent({ id: 2, type: "phase", timestamp: "2026-03-10T00:01:30Z", data: { phase: "build" } }),
      makeEvent({ id: 3, type: "completed", timestamp: "2026-03-10T00:05:00Z", data: {} }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("00:00");
    expect(result).toContain("01:30");
    expect(result).toContain("05:00");
  });

  it("formats phase event description", () => {
    const events: EventRow[] = [
      makeEvent({ id: 1, type: "phase", timestamp: "2026-03-10T00:00:00Z", data: { phase: "validation" } }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("validation");
  });

  it("formats validation_step event with pass/fail", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "validation_step",
        timestamp: "2026-03-10T00:00:00Z",
        data: { name: "typecheck", passed: true },
      }),
      makeEvent({
        id: 2,
        type: "validation_step",
        timestamp: "2026-03-10T00:00:05Z",
        data: { name: "lint", passed: false, error: "2 errors" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("typecheck");
    expect(result).toContain("passed");
    expect(result).toContain("lint");
    expect(result).toContain("failed");
  });

  it("formats cost event with token counts", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "cost",
        timestamp: "2026-03-10T00:00:00Z",
        data: { input: 1000, output: 500, total: 1500 },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("1,500 tokens");
  });

  it("formats prompt event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "prompt",
        timestamp: "2026-03-10T00:00:00Z",
        data: { length: 2500 },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("prompt");
  });

  it("formats agent_response event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "agent_response",
        timestamp: "2026-03-10T00:00:00Z",
        data: { status: "completed" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("agent_response");
    expect(result).toContain("completed");
  });

  it("formats retry event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "retry",
        timestamp: "2026-03-10T00:00:00Z",
        data: { attempt: 2, reason: "validation failed" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("retry");
    expect(result).toContain("attempt 2");
  });

  it("formats failed event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "failed",
        timestamp: "2026-03-10T00:00:00Z",
        data: { error: "timeout exceeded" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("failed");
    expect(result).toContain("timeout exceeded");
  });

  it("formats snapshot event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "snapshot",
        timestamp: "2026-03-10T00:00:00Z",
        data: { stepName: "after-build" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("snapshot");
    expect(result).toContain("after-build");
  });

  it("formats output event", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "output",
        timestamp: "2026-03-10T00:00:00Z",
        data: { mode: "git", branch: "forgectl/run-abc" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("output");
  });

  it("returns empty message for no events", () => {
    const result = formatTimeline([], "2026-03-10T00:00:00Z");
    expect(result).toContain("No events recorded");
  });

  it("handles unknown event types gracefully", () => {
    const events: EventRow[] = [
      makeEvent({
        id: 1,
        type: "custom_event",
        timestamp: "2026-03-10T00:00:00Z",
        data: { foo: "bar" },
      }),
    ];
    const result = formatTimeline(events, "2026-03-10T00:00:00Z");
    expect(result).toContain("[custom_event]");
  });
});
