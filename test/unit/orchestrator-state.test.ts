import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createState,
  claimIssue,
  releaseIssue,
  SlotManager,
  type OrchestratorState,
  type WorkerInfo,
  type IssueState,
} from "../../src/orchestrator/state.js";

/** Helper to create a minimal WorkerInfo with slotWeight */
function makeWorkerInfo(slotWeight: number): WorkerInfo {
  return {
    issueId: "test",
    identifier: "TEST-1",
    issue: {} as any,
    session: null,
    cleanup: { tempDirs: [], secretCleanups: [] },
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    attempt: 1,
    slotWeight,
  };
}

describe("OrchestratorState", () => {
  let state: OrchestratorState;

  beforeEach(() => {
    state = createState();
  });

  describe("createState", () => {
    it("returns empty OrchestratorState", () => {
      expect(state.claimed).toBeInstanceOf(Set);
      expect(state.claimed.size).toBe(0);
      expect(state.running).toBeInstanceOf(Map);
      expect(state.running.size).toBe(0);
      expect(state.retryTimers).toBeInstanceOf(Map);
      expect(state.retryTimers.size).toBe(0);
      expect(state.retryAttempts).toBeInstanceOf(Map);
      expect(state.retryAttempts.size).toBe(0);
    });
  });

  describe("claimIssue", () => {
    it("adds to claimed Set and returns true on first call", () => {
      const result = claimIssue(state, "issue-1");
      expect(result).toBe(true);
      expect(state.claimed.has("issue-1")).toBe(true);
    });

    it("returns false on duplicate (already claimed)", () => {
      claimIssue(state, "issue-1");
      const result = claimIssue(state, "issue-1");
      expect(result).toBe(false);
    });

    it("allows claiming different issues", () => {
      expect(claimIssue(state, "issue-1")).toBe(true);
      expect(claimIssue(state, "issue-2")).toBe(true);
      expect(state.claimed.size).toBe(2);
    });
  });

  describe("releaseIssue", () => {
    it("removes from claimed Set", () => {
      claimIssue(state, "issue-1");
      releaseIssue(state, "issue-1");
      expect(state.claimed.has("issue-1")).toBe(false);
    });

    it("removes from running Map", () => {
      claimIssue(state, "issue-1");
      state.running.set("issue-1", makeWorkerInfo(1));
      releaseIssue(state, "issue-1");
      expect(state.running.has("issue-1")).toBe(false);
    });

    it("removes from retryAttempts Map", () => {
      claimIssue(state, "issue-1");
      state.retryAttempts.set("issue-1", 3);
      releaseIssue(state, "issue-1");
      expect(state.retryAttempts.has("issue-1")).toBe(false);
    });

    it("cancels retry timer for the issue", () => {
      vi.useFakeTimers();
      claimIssue(state, "issue-1");
      const timer = setTimeout(() => {}, 10000);
      state.retryTimers.set("issue-1", timer);

      releaseIssue(state, "issue-1");

      expect(state.retryTimers.has("issue-1")).toBe(false);
      vi.useRealTimers();
    });

    it("is safe to call for non-existent issue", () => {
      expect(() => releaseIssue(state, "no-such-issue")).not.toThrow();
    });
  });
});

describe("SlotManager", () => {
  it("constructor sets capacity", () => {
    const sm = new SlotManager(5);
    const running = new Map<string, WorkerInfo>();
    expect(sm.availableSlots(running)).toBe(5);
  });

  it("availableSlots sums slotWeight instead of counting workers", () => {
    const sm = new SlotManager(3);
    const running = new Map<string, WorkerInfo>();
    running.set("a", makeWorkerInfo(1));
    running.set("b", makeWorkerInfo(1));
    expect(sm.availableSlots(running)).toBe(1);
  });

  it("hasAvailableSlots returns false when weight sum >= max", () => {
    const sm = new SlotManager(2);
    const running = new Map<string, WorkerInfo>();
    running.set("a", makeWorkerInfo(1));
    running.set("b", makeWorkerInfo(1));
    expect(sm.hasAvailableSlots(running)).toBe(false);
  });

  it("availableSlots returns 0 when at capacity", () => {
    const sm = new SlotManager(1);
    const running = new Map<string, WorkerInfo>();
    running.set("a", makeWorkerInfo(1));
    expect(sm.availableSlots(running)).toBe(0);
  });

  it("hasAvailableSlots returns true when slots available", () => {
    const sm = new SlotManager(3);
    const running = new Map<string, WorkerInfo>();
    running.set("a", makeWorkerInfo(1));
    expect(sm.hasAvailableSlots(running)).toBe(true);
  });

  describe("weighted slot management", () => {
    it("team worker with weight 3 consumes 3 slots", () => {
      const sm = new SlotManager(5);
      const running = new Map<string, WorkerInfo>();
      running.set("team-a", makeWorkerInfo(3));
      expect(sm.availableSlots(running)).toBe(2);
    });

    it("mixed solo and team workers sum correctly", () => {
      const sm = new SlotManager(5);
      const running = new Map<string, WorkerInfo>();
      running.set("solo-a", makeWorkerInfo(1));
      running.set("team-b", makeWorkerInfo(3));
      expect(sm.availableSlots(running)).toBe(1); // 5 - (1+3) = 1
    });

    it("returns 0 when weight sum equals max", () => {
      const sm = new SlotManager(3);
      const running = new Map<string, WorkerInfo>();
      running.set("team-a", makeWorkerInfo(3));
      expect(sm.availableSlots(running)).toBe(0);
    });

    it("returns 0 when weight sum exceeds max (clamped by Math.max)", () => {
      const sm = new SlotManager(3);
      const running = new Map<string, WorkerInfo>();
      running.set("team-a", makeWorkerInfo(4));
      expect(sm.availableSlots(running)).toBe(0);
    });

    it("hasAvailableSlots returns false when weight sum >= max", () => {
      const sm = new SlotManager(3);
      const running = new Map<string, WorkerInfo>();
      running.set("team-a", makeWorkerInfo(3));
      expect(sm.hasAvailableSlots(running)).toBe(false);
    });

    it("backward compat: solo workers with weight 1 behave as before", () => {
      const sm = new SlotManager(3);
      const running = new Map<string, WorkerInfo>();
      running.set("a", makeWorkerInfo(1));
      running.set("b", makeWorkerInfo(1));
      // 2 solo workers at weight 1 each = 2 used, 1 available
      expect(sm.availableSlots(running)).toBe(1);
      expect(sm.hasAvailableSlots(running)).toBe(true);
    });
  });
});
