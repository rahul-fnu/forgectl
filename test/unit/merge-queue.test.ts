import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeQueue } from "../../src/orchestrator/merge-queue.js";

describe("MergeQueue", () => {
  // --- Initial state ---

  it("starts with pending=0 and isProcessing=false", () => {
    const queue = new MergeQueue(vi.fn());
    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  // --- Single item ---

  it("processes a single merge request", async () => {
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    const queue = new MergeQueue(mergeFn);

    const result = await queue.enqueue("branch-1", 1);

    expect(result.merged).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mergeFn).toHaveBeenCalledWith(1, "branch-1");
  });

  it("returns to idle state after processing single item", async () => {
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    const queue = new MergeQueue(mergeFn);

    await queue.enqueue("branch-1", 1);

    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  // --- Serialization ---

  it("serializes multiple merge requests in FIFO order", async () => {
    const order: number[] = [];
    const mergeFn = vi.fn().mockImplementation(async (prNumber: number) => {
      order.push(prNumber);
      await new Promise((r) => setTimeout(r, 10));
    });

    const queue = new MergeQueue(mergeFn);

    const [r1, r2, r3] = await Promise.all([
      queue.enqueue("branch-1", 1),
      queue.enqueue("branch-2", 2),
      queue.enqueue("branch-3", 3),
    ]);

    expect(r1.merged).toBe(true);
    expect(r2.merged).toBe(true);
    expect(r3.merged).toBe(true);
    expect(order).toEqual([1, 2, 3]);
  });

  it("never runs two merges concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const mergeFn = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });

    const queue = new MergeQueue(mergeFn);

    await Promise.all([
      queue.enqueue("b-1", 1),
      queue.enqueue("b-2", 2),
      queue.enqueue("b-3", 3),
      queue.enqueue("b-4", 4),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  // --- Error handling ---

  it("continues processing after a failed merge", async () => {
    const mergeFn = vi.fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce(undefined);

    const queue = new MergeQueue(mergeFn);

    const [r1, r2] = await Promise.all([
      queue.enqueue("branch-1", 1),
      queue.enqueue("branch-2", 2),
    ]);

    expect(r1.merged).toBe(false);
    expect(r1.error).toContain("conflict");
    expect(r2.merged).toBe(true);
    expect(r2.error).toBeUndefined();
  });

  it("handles non-Error thrown from mergeFn", async () => {
    const mergeFn = vi.fn().mockRejectedValueOnce("string error");

    const queue = new MergeQueue(mergeFn);
    const result = await queue.enqueue("branch-1", 1);

    expect(result.merged).toBe(false);
    expect(result.error).toBe("string error");
  });

  it("handles multiple consecutive failures", async () => {
    const mergeFn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce(undefined);

    const queue = new MergeQueue(mergeFn);

    const [r1, r2, r3] = await Promise.all([
      queue.enqueue("b-1", 1),
      queue.enqueue("b-2", 2),
      queue.enqueue("b-3", 3),
    ]);

    expect(r1.merged).toBe(false);
    expect(r2.merged).toBe(false);
    expect(r3.merged).toBe(true);
  });

  // --- Pending/processing state ---

  it("reports correct pending count while processing", async () => {
    let resolveFirst!: () => void;
    const firstMerge = new Promise<void>((r) => { resolveFirst = r; });
    const mergeFn = vi.fn().mockImplementation(async () => {
      await firstMerge;
    });

    const queue = new MergeQueue(mergeFn);

    const p1 = queue.enqueue("branch-1", 1);
    const p2 = queue.enqueue("branch-2", 2);
    const p3 = queue.enqueue("branch-3", 3);

    // branch-1 processing, branch-2 and branch-3 pending
    expect(queue.isProcessing).toBe(true);
    expect(queue.pending).toBe(2);

    resolveFirst();
    await Promise.all([p1, p2, p3]);

    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  // --- Reuse after drain ---

  it("can be reused after queue drains", async () => {
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    const queue = new MergeQueue(mergeFn);

    // First batch
    await queue.enqueue("b-1", 1);
    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);

    // Second batch
    const result = await queue.enqueue("b-2", 2);
    expect(result.merged).toBe(true);
    expect(mergeFn).toHaveBeenCalledTimes(2);
  });

  // --- Arguments passing ---

  it("passes correct branch and prNumber to mergeFn", async () => {
    const mergeFn = vi.fn().mockResolvedValue(undefined);
    const queue = new MergeQueue(mergeFn);

    await queue.enqueue("forge/issue-42/abc", 42);

    expect(mergeFn).toHaveBeenCalledWith(42, "forge/issue-42/abc");
  });
});
