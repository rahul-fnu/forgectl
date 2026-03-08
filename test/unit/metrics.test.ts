import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";
import { SlotManager, type WorkerInfo } from "../../src/orchestrator/state.js";

describe("MetricsCollector", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe("recordDispatch", () => {
    it("creates an active entry with status running", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      const entry = metrics.getIssueMetrics("issue-1");
      expect(entry).toBeDefined();
      expect(entry!.issueId).toBe("issue-1");
      expect(entry!.identifier).toBe("GH-1");
      expect(entry!.status).toBe("running");
      expect(entry!.attempts).toBe(1);
      expect(entry!.tokens).toEqual({ input: 0, output: 0, total: 0 });
      expect(entry!.runtimeMs).toBe(0);
    });

    it("increments dispatched total", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordDispatch("issue-2", "GH-2");
      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.dispatched).toBe(2);
    });
  });

  describe("recordCompletion", () => {
    it("moves entry from active to completed", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordCompletion("issue-1", { input: 100, output: 200, total: 300 }, 5000, "completed");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.active).toHaveLength(0);
      expect(snapshot.completed).toHaveLength(1);
      expect(snapshot.completed[0].status).toBe("completed");
      expect(snapshot.completed[0].tokens).toEqual({ input: 100, output: 200, total: 300 });
      expect(snapshot.completed[0].runtimeMs).toBe(5000);
    });

    it("updates aggregate totals on completion", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordCompletion("issue-1", { input: 100, output: 200, total: 300 }, 5000, "completed");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.completed).toBe(1);
      expect(snapshot.totals.failed).toBe(0);
      expect(snapshot.totals.tokens).toEqual({ input: 100, output: 200, total: 300 });
    });

    it("updates aggregate totals on failure", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordCompletion("issue-1", { input: 50, output: 50, total: 100 }, 2000, "failed");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.completed).toBe(0);
      expect(snapshot.totals.failed).toBe(1);
      expect(snapshot.totals.tokens).toEqual({ input: 50, output: 50, total: 100 });
    });

    it("is a no-op for non-existent issueId", () => {
      metrics.recordCompletion("nonexistent", { input: 100, output: 200, total: 300 }, 5000, "completed");
      const snapshot = metrics.getSnapshot();
      expect(snapshot.active).toHaveLength(0);
      expect(snapshot.completed).toHaveLength(0);
      expect(snapshot.totals.completed).toBe(0);
    });
  });

  describe("bounded buffer eviction", () => {
    it("evicts oldest completed entry when buffer exceeds maxCompleted", () => {
      const smallMetrics = new MetricsCollector(2);

      smallMetrics.recordDispatch("a", "GH-A");
      smallMetrics.recordCompletion("a", { input: 1, output: 1, total: 2 }, 100, "completed");

      smallMetrics.recordDispatch("b", "GH-B");
      smallMetrics.recordCompletion("b", { input: 2, output: 2, total: 4 }, 200, "completed");

      smallMetrics.recordDispatch("c", "GH-C");
      smallMetrics.recordCompletion("c", { input: 3, output: 3, total: 6 }, 300, "completed");

      const snapshot = smallMetrics.getSnapshot();
      expect(snapshot.completed).toHaveLength(2);
      // Oldest ("a") should have been evicted
      expect(snapshot.completed[0].issueId).toBe("b");
      expect(snapshot.completed[1].issueId).toBe("c");
    });
  });

  describe("recordRetry", () => {
    it("increments attempts on active entry", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordRetry("issue-1");
      const entry = metrics.getIssueMetrics("issue-1");
      expect(entry!.attempts).toBe(2);
    });

    it("updates lastAttemptAt on retry", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      const before = metrics.getIssueMetrics("issue-1")!.lastAttemptAt;
      metrics.recordRetry("issue-1");
      const after = metrics.getIssueMetrics("issue-1")!.lastAttemptAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe("getSnapshot", () => {
    it("returns correct shape with uptimeMs > 0", () => {
      const snapshot = metrics.getSnapshot();
      expect(snapshot.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.active).toEqual([]);
      expect(snapshot.completed).toEqual([]);
      expect(snapshot.totals).toEqual({
        dispatched: 0,
        completed: 0,
        failed: 0,
        tokens: { input: 0, output: 0, total: 0 },
      });
    });
  });

  describe("getIssueMetrics", () => {
    it("finds active issues", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      expect(metrics.getIssueMetrics("issue-1")).toBeDefined();
    });

    it("finds completed issues", () => {
      metrics.recordDispatch("issue-1", "GH-1");
      metrics.recordCompletion("issue-1", { input: 10, output: 20, total: 30 }, 1000, "completed");
      expect(metrics.getIssueMetrics("issue-1")).toBeDefined();
      expect(metrics.getIssueMetrics("issue-1")!.status).toBe("completed");
    });

    it("returns undefined for unknown issueId", () => {
      expect(metrics.getIssueMetrics("unknown")).toBeUndefined();
    });
  });

  describe("aggregate totals after multiple operations", () => {
    it("accumulates tokens across multiple completions", () => {
      metrics.recordDispatch("a", "GH-A");
      metrics.recordCompletion("a", { input: 100, output: 200, total: 300 }, 1000, "completed");

      metrics.recordDispatch("b", "GH-B");
      metrics.recordCompletion("b", { input: 50, output: 75, total: 125 }, 2000, "failed");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.dispatched).toBe(2);
      expect(snapshot.totals.completed).toBe(1);
      expect(snapshot.totals.failed).toBe(1);
      expect(snapshot.totals.tokens).toEqual({ input: 150, output: 275, total: 425 });
    });
  });

  describe("getSlotUtilization", () => {
    it("returns active count and max from SlotManager", () => {
      const slotManager = new SlotManager(5);
      const running = new Map<string, WorkerInfo>();
      running.set("a", {} as WorkerInfo);
      running.set("b", {} as WorkerInfo);

      const util = metrics.getSlotUtilization(running, slotManager);
      expect(util).toEqual({ active: 2, max: 5 });
    });

    it("returns zero active when no workers running", () => {
      const slotManager = new SlotManager(3);
      const running = new Map<string, WorkerInfo>();

      const util = metrics.getSlotUtilization(running, slotManager);
      expect(util).toEqual({ active: 0, max: 3 });
    });
  });
});
