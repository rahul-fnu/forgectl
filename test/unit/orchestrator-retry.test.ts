import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateBackoff,
  classifyFailure,
  scheduleRetry,
  cancelRetry,
  clearAllRetries,
} from "../../src/orchestrator/retry.js";
import { createState, type OrchestratorState } from "../../src/orchestrator/state.js";
import { z } from "zod";

describe("calculateBackoff", () => {
  it("attempt 1 returns 10000", () => {
    expect(calculateBackoff(1, 300000)).toBe(10000);
  });

  it("attempt 2 returns 20000", () => {
    expect(calculateBackoff(2, 300000)).toBe(20000);
  });

  it("attempt 3 returns 40000", () => {
    expect(calculateBackoff(3, 300000)).toBe(40000);
  });

  it("attempt 4 returns 80000", () => {
    expect(calculateBackoff(4, 300000)).toBe(80000);
  });

  it("attempt 5 returns 160000", () => {
    expect(calculateBackoff(5, 300000)).toBe(160000);
  });

  it("attempt 6 returns 300000 (capped at max)", () => {
    expect(calculateBackoff(6, 300000)).toBe(300000);
  });
});

describe("classifyFailure", () => {
  it('"completed" returns "continuation"', () => {
    expect(classifyFailure("completed")).toBe("continuation");
  });

  it('"failed" returns "error"', () => {
    expect(classifyFailure("failed")).toBe("error");
  });

  it('"timeout" returns "error"', () => {
    expect(classifyFailure("timeout")).toBe("error");
  });

  it('"user_input_required" returns "error"', () => {
    expect(classifyFailure("user_input_required")).toBe("error");
  });
});

describe("scheduleRetry", () => {
  let state: OrchestratorState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = createState();
  });

  afterEach(() => {
    clearAllRetries(state);
    vi.useRealTimers();
  });

  it("stores timer handle in state.retryTimers", () => {
    const callback = vi.fn();
    scheduleRetry("issue-1", 5000, callback, state);
    expect(state.retryTimers.has("issue-1")).toBe(true);
  });

  it("executes callback after delay", () => {
    const callback = vi.fn();
    scheduleRetry("issue-1", 5000, callback, state);
    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("replaces existing timer for same issue", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    scheduleRetry("issue-1", 5000, callback1, state);
    scheduleRetry("issue-1", 3000, callback2, state);
    vi.advanceTimersByTime(5000);
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledOnce();
  });
});

describe("cancelRetry", () => {
  let state: OrchestratorState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = createState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears timer and removes from retryTimers map", () => {
    const callback = vi.fn();
    scheduleRetry("issue-1", 5000, callback, state);
    cancelRetry("issue-1", state);
    expect(state.retryTimers.has("issue-1")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("is safe to call for non-existent issue", () => {
    expect(() => cancelRetry("no-such", state)).not.toThrow();
  });
});

describe("clearAllRetries", () => {
  let state: OrchestratorState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = createState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears all timers", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    scheduleRetry("issue-1", 5000, cb1, state);
    scheduleRetry("issue-2", 5000, cb2, state);
    clearAllRetries(state);
    expect(state.retryTimers.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});

describe("OrchestratorConfigSchema", () => {
  // Dynamically import to test schema integration
  it("parses with all defaults", async () => {
    const { OrchestratorConfigSchema } = await import("../../src/config/schema.js");
    const result = OrchestratorConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      max_concurrent_agents: 3,
      poll_interval_ms: 30000,
      stall_timeout_ms: 600000,
      max_retries: 5,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 1000,
      in_progress_label: "in-progress",
      child_slots: 0,
      enable_triage: false,
    });
  });

  it("is included in ConfigSchema with defaults", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const config = ConfigSchema.parse({});
    expect(config.orchestrator).toBeDefined();
    expect(config.orchestrator.enabled).toBe(false);
    expect(config.orchestrator.max_concurrent_agents).toBe(3);
  });
});
