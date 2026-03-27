import { describe, it, expect } from "vitest";
import { formatSSEEvent, parseSSEData } from "../../src/cli/logs.js";
import type { RunEvent } from "../../src/logging/events.js";

function makeRunEvent(overrides: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent {
  return {
    runId: "run-abc",
    timestamp: "2026-03-10T12:00:00Z",
    data: {},
    ...overrides,
  };
}

describe("formatSSEEvent", () => {
  it("formats started event with green marker", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "started" }));
    expect(result).toContain("Run started");
  });

  it("formats completed event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "completed" }));
    expect(result).toContain("Run completed");
  });

  it("formats failed event with error message", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "failed", data: { error: "timeout exceeded" } }));
    expect(result).toContain("Run failed");
    expect(result).toContain("timeout exceeded");
  });

  it("formats failed event without error", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "failed", data: {} }));
    expect(result).toContain("Run failed");
  });

  it("formats phase event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "phase", data: { phase: "validation" } }));
    expect(result).toContain("Phase: validation");
  });

  it("formats prompt event with char count", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "prompt", data: { length: 2500 } }));
    expect(result).toContain("Prompt sent");
    expect(result).toContain("2,500 chars");
  });

  it("formats agent_response with stdout", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "agent_response", data: { stdout: "Build succeeded" } }));
    expect(result).toContain("Agent stdout: Build succeeded");
  });

  it("formats agent_response with stderr", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "agent_response", data: { stderr: "Warning: deprecated" } }));
    expect(result).toContain("Agent stderr: Warning: deprecated");
  });

  it("formats agent_response with status only", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "agent_response", data: { status: "completed" } }));
    expect(result).toContain("Agent response: completed");
  });

  it("formats validation_step passed", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "validation_step", data: { name: "typecheck", passed: true } }));
    expect(result).toContain("typecheck: passed");
  });

  it("formats validation_step failed with error", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "validation_step", data: { name: "lint", passed: false, error: "2 errors" } }));
    expect(result).toContain("lint: failed");
    expect(result).toContain("2 errors");
  });

  it("formats validation overall result", () => {
    const passed = formatSSEEvent(makeRunEvent({ type: "validation", data: { passed: true } }));
    expect(passed).toContain("Validation passed");

    const failed = formatSSEEvent(makeRunEvent({ type: "validation", data: { passed: false } }));
    expect(failed).toContain("Validation failed");
  });

  it("formats retry event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "retry", data: { attempt: 2, reason: "lint failed" } }));
    expect(result).toContain("Retry attempt 2");
    expect(result).toContain("lint failed");
  });

  it("formats output event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "output", data: { mode: "git", branch: "forgectl/run-abc" } }));
    expect(result).toContain("Output collected");
    expect(result).toContain("git");
    expect(result).toContain("forgectl/run-abc");
  });

  it("formats cost event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "cost", data: { total: 15000 } }));
    expect(result).toContain("15,000 tokens");
  });

  it("formats snapshot event", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "snapshot", data: { stepName: "after-build" } }));
    expect(result).toContain("Snapshot: after-build");
  });

  it("formats unknown event types gracefully", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "dispatch" as RunEvent["type"], data: { target: "agent-1" } }));
    expect(result).toContain("[dispatch]");
  });

  it("includes timestamp in output", () => {
    const result = formatSSEEvent(makeRunEvent({ type: "started", timestamp: "2026-03-10T14:30:00Z" }));
    // Should contain a time string (format depends on locale, but should have numbers)
    expect(result).toMatch(/\d+:\d+/);
  });
});

describe("parseSSEData", () => {
  it("parses a single SSE data line", () => {
    const chunk = 'data: {"runId":"run-1","type":"started","timestamp":"2026-03-10T00:00:00Z","data":{}}\n';
    const events = parseSSEData(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("started");
    expect(events[0].runId).toBe("run-1");
  });

  it("parses multiple SSE data lines", () => {
    const chunk = [
      'data: {"runId":"run-1","type":"started","timestamp":"2026-03-10T00:00:00Z","data":{}}',
      'data: {"runId":"run-1","type":"completed","timestamp":"2026-03-10T00:05:00Z","data":{}}',
      "",
    ].join("\n");
    const events = parseSSEData(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("started");
    expect(events[1].type).toBe("completed");
  });

  it("skips malformed data lines", () => {
    const chunk = "data: not-json\ndata: {}\n";
    const events = parseSSEData(chunk);
    // The first line is invalid JSON, second is valid but not a RunEvent shape
    expect(events).toHaveLength(1);
  });

  it("skips non-data lines", () => {
    const chunk = 'event: message\ndata: {"runId":"r","type":"started","timestamp":"t","data":{}}\nid: 1\n';
    const events = parseSSEData(chunk);
    expect(events).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseSSEData("")).toHaveLength(0);
    expect(parseSSEData("\n\n")).toHaveLength(0);
  });
});
