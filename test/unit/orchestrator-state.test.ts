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
      state.running.set("issue-1", {} as WorkerInfo);
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

  it("availableSlots returns max - running.size", () => {
    const sm = new SlotManager(3);
    const running = new Map<string, WorkerInfo>();
    running.set("a", {} as WorkerInfo);
    running.set("b", {} as WorkerInfo);
    expect(sm.availableSlots(running)).toBe(1);
  });

  it("hasAvailableSlots returns false when running.size >= max", () => {
    const sm = new SlotManager(2);
    const running = new Map<string, WorkerInfo>();
    running.set("a", {} as WorkerInfo);
    running.set("b", {} as WorkerInfo);
    expect(sm.hasAvailableSlots(running)).toBe(false);
  });

  it("availableSlots returns 0 when at capacity", () => {
    const sm = new SlotManager(1);
    const running = new Map<string, WorkerInfo>();
    running.set("a", {} as WorkerInfo);
    expect(sm.availableSlots(running)).toBe(0);
  });

  it("hasAvailableSlots returns true when slots available", () => {
    const sm = new SlotManager(3);
    const running = new Map<string, WorkerInfo>();
    running.set("a", {} as WorkerInfo);
    expect(sm.hasAvailableSlots(running)).toBe(true);
  });
});
