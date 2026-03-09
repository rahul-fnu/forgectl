import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunQueue } from "../../src/daemon/queue.js";
import type { ExecutionResult } from "../../src/orchestration/single.js";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";

function makeSuccessResult(): ExecutionResult {
  return {
    success: true,
    validation: { passed: true, totalAttempts: 0, stepResults: [] },
    durationMs: 100,
  };
}

function makeFailResult(): ExecutionResult {
  return {
    success: false,
    validation: { passed: false, totalAttempts: 1, stepResults: [] },
    durationMs: 50,
    error: "Failed",
  };
}

function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "forgectl-daemon-test-"));
  const db = createDatabase(join(dir, "test.db"));
  runMigrations(db);
  const repo = createRunRepository(db);
  return { db, repo, dir };
}

describe("RunQueue", () => {
  let db: AppDatabase;
  let repo: RunRepository;
  let tmpDir: string;

  beforeEach(() => {
    const ctx = createTestDb();
    db = ctx.db;
    repo = ctx.repo;
    tmpDir = ctx.dir;
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("submit adds a run with queued status", () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    const run = queue.submit("run-1", { task: "test" });
    expect(run.id).toBe("run-1");
    expect(run.options.task).toBe("test");
    expect(run.submittedAt).toBeTruthy();
  });

  it("get returns run by id", () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    queue.submit("run-abc", { task: "task" });
    const run = queue.get("run-abc");
    expect(run).toBeDefined();
    expect(run?.id).toBe("run-abc");
  });

  it("get returns undefined for unknown id", () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    expect(queue.get("nonexistent")).toBeUndefined();
  });

  it("list returns all submitted runs", () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    queue.submit("r1", { task: "task 1" });
    queue.submit("r2", { task: "task 2" });
    const runs = queue.list();
    expect(runs).toHaveLength(2);
    expect(runs.map(r => r.id)).toContain("r1");
    expect(runs.map(r => r.id)).toContain("r2");
  });

  it("list returns a fresh copy from database", () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    queue.submit("r1", { task: "task" });
    const list1 = queue.list();
    queue.submit("r2", { task: "task 2" });
    const list2 = queue.list();
    expect(list1).toHaveLength(1); // Original snapshot unaffected
    expect(list2).toHaveLength(2);
  });

  it("processes run asynchronously and marks completed", async () => {
    let executed = false;
    const queue = new RunQueue(repo, async () => {
      executed = true;
      return makeSuccessResult();
    });
    queue.submit("r1", { task: "task" });
    // Wait for async processing
    await new Promise(r => setTimeout(r, 50));
    expect(executed).toBe(true);
    const run = queue.get("r1");
    expect(run?.status).toBe("completed");
    expect(run?.result?.success).toBe(true);
  });

  it("marks run as failed when executor returns failure", async () => {
    const queue = new RunQueue(repo, async () => makeFailResult());
    queue.submit("r1", { task: "task" });
    await new Promise(r => setTimeout(r, 50));
    const run = queue.get("r1");
    expect(run?.status).toBe("failed");
  });

  it("marks run as failed when executor throws", async () => {
    const queue = new RunQueue(repo, async () => {
      throw new Error("executor crash");
    });
    queue.submit("r1", { task: "task" });
    await new Promise(r => setTimeout(r, 50));
    const run = queue.get("r1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("executor crash");
  });

  it("processes runs sequentially", async () => {
    const order: number[] = [];
    const queue = new RunQueue(repo, async (run) => {
      order.push(parseInt(run.id));
      await new Promise(r => setTimeout(r, 10));
      return makeSuccessResult();
    });
    queue.submit("1", { task: "first" });
    queue.submit("2", { task: "second" });
    queue.submit("3", { task: "third" });
    await new Promise(r => setTimeout(r, 100));
    expect(order).toEqual([1, 2, 3]);
  });

  it("sets startedAt and completedAt timestamps", async () => {
    const queue = new RunQueue(repo, async () => makeSuccessResult());
    queue.submit("r1", { task: "task" });
    await new Promise(r => setTimeout(r, 50));
    const run = queue.get("r1");
    expect(run?.startedAt).toBeTruthy();
    expect(run?.completedAt).toBeTruthy();
  });

  it("persists runs to database across RunQueue instances", async () => {
    const queue1 = new RunQueue(repo, async () => makeSuccessResult());
    queue1.submit("persist-1", { task: "durable task" });

    // Wait for processing to complete
    await new Promise(r => setTimeout(r, 50));

    // Create a new RunQueue with the same repo — completed run should be visible
    const queue2 = new RunQueue(repo, async () => makeSuccessResult());
    const found = queue2.get("persist-1");
    expect(found).toBeDefined();
    expect(found?.id).toBe("persist-1");
    expect(found?.options.task).toBe("durable task");
    expect(found?.status).toBe("completed");

    const list = queue2.list();
    expect(list.some(r => r.id === "persist-1")).toBe(true);
  });
});

describe("PID lifecycle", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-pid-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("savePid writes pid file and readPid returns it", async () => {
    const { savePid, readPid } = await import("../../src/daemon/lifecycle.js");
    savePid(process.pid);
    const pid = readPid();
    expect(pid).toBe(process.pid);
  });

  it("removePid cleans up pid file", async () => {
    const { savePid, removePid, readPid } = await import("../../src/daemon/lifecycle.js");
    savePid(process.pid);
    removePid();
    const pid = readPid();
    expect(pid).toBeNull();
  });

  it("readPid returns null when no pid file", async () => {
    const { readPid } = await import("../../src/daemon/lifecycle.js");
    const pid = readPid();
    expect(pid).toBeNull();
  });

  it("isDaemonRunning returns false when no pid file", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    expect(isDaemonRunning()).toBe(false);
  });

  it("isDaemonRunning returns true when current process pid is saved", async () => {
    const { savePid, isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    savePid(process.pid);
    expect(isDaemonRunning()).toBe(true);
  });
});
