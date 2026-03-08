import { describe, it, expect, vi } from "vitest";
import { Logger, type LogEntry } from "../../src/logging/logger.js";
import type { RunEvent } from "../../src/logging/events.js";
import { emitRunEvent } from "../../src/logging/events.js";

describe("LogEntry enrichment", () => {
  it("LogEntry accepts optional issueId, issueIdentifier, sessionId", () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      phase: "test",
      message: "test message",
      issueId: "issue-1",
      issueIdentifier: "GH-1",
      sessionId: "session-123",
    };

    expect(entry.issueId).toBe("issue-1");
    expect(entry.issueIdentifier).toBe("GH-1");
    expect(entry.sessionId).toBe("session-123");
  });

  it("LogEntry works without optional fields", () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      phase: "test",
      message: "test message",
    };

    expect(entry.issueId).toBeUndefined();
    expect(entry.issueIdentifier).toBeUndefined();
    expect(entry.sessionId).toBeUndefined();
  });
});

describe("Logger listener error swallowing", () => {
  it("swallows listener errors and continues to subsequent listeners", () => {
    const logger = new Logger(false);
    const results: string[] = [];

    logger.onEntry(() => {
      results.push("first");
    });

    logger.onEntry(() => {
      throw new Error("listener explosion");
    });

    logger.onEntry(() => {
      results.push("third");
    });

    // Suppress console output during test
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // This should not throw despite the second listener throwing
    expect(() => {
      logger.info("test", "hello");
    }).not.toThrow();

    // First and third listeners should have been called
    expect(results).toEqual(["first", "third"]);

    consoleSpy.mockRestore();
  });
});

describe("RunEvent orchestrator types", () => {
  it("accepts dispatch event type", () => {
    const event: RunEvent = {
      runId: "orch-1",
      type: "dispatch",
      timestamp: new Date().toISOString(),
      data: { issueId: "issue-1" },
    };
    expect(event.type).toBe("dispatch");
  });

  it("accepts reconcile event type", () => {
    const event: RunEvent = {
      runId: "orch-1",
      type: "reconcile",
      timestamp: new Date().toISOString(),
      data: {},
    };
    expect(event.type).toBe("reconcile");
  });

  it("accepts stall event type", () => {
    const event: RunEvent = {
      runId: "orch-1",
      type: "stall",
      timestamp: new Date().toISOString(),
      data: {},
    };
    expect(event.type).toBe("stall");
  });

  it("accepts orch_retry event type", () => {
    const event: RunEvent = {
      runId: "orch-1",
      type: "orch_retry",
      timestamp: new Date().toISOString(),
      data: {},
    };
    expect(event.type).toBe("orch_retry");
  });

  it("emitRunEvent works with orchestrator event types", () => {
    // Should not throw
    expect(() => {
      emitRunEvent({
        runId: "orch-1",
        type: "dispatch",
        timestamp: new Date().toISOString(),
        data: { issueId: "issue-1" },
      });
    }).not.toThrow();
  });
});
