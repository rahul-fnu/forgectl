import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDatabase,
  closeDatabase,
  type AppDatabase,
} from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createLockRepository,
  type LockRepository,
} from "../../src/storage/repositories/locks.js";
import {
  createRunRepository,
  type RunRepository,
} from "../../src/storage/repositories/runs.js";
import {
  acquireLock,
  releaseLock,
  releaseAllStaleLocks,
} from "../../src/durability/locks.js";

describe("storage/repositories/locks", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: LockRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-lock-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createLockRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates a lock and returns the row", () => {
    const lock = repo.insert({
      lockType: "issue",
      lockKey: "owner/repo#42",
      ownerId: "run-1",
      daemonPid: 12345,
    });
    expect(lock).toBeDefined();
    expect(lock.lockType).toBe("issue");
    expect(lock.lockKey).toBe("owner/repo#42");
    expect(lock.ownerId).toBe("run-1");
    expect(lock.daemonPid).toBe(12345);
    expect(lock.acquiredAt).toBeTruthy();
  });

  it("insert() throws/returns false for duplicate lock_type+lock_key", () => {
    repo.insert({
      lockType: "issue",
      lockKey: "owner/repo#42",
      ownerId: "run-1",
      daemonPid: 12345,
    });
    // Second insert with same lockType+lockKey should fail
    expect(() =>
      repo.insert({
        lockType: "issue",
        lockKey: "owner/repo#42",
        ownerId: "run-2",
        daemonPid: 12345,
      })
    ).toThrow();
  });

  it("allows same lockKey with different lockType", () => {
    repo.insert({
      lockType: "issue",
      lockKey: "same-key",
      ownerId: "run-1",
      daemonPid: 12345,
    });
    const lock2 = repo.insert({
      lockType: "workspace",
      lockKey: "same-key",
      ownerId: "run-2",
      daemonPid: 12345,
    });
    expect(lock2).toBeDefined();
    expect(lock2.lockType).toBe("workspace");
  });

  it("findByDaemonPid() returns all locks owned by a given PID", () => {
    repo.insert({
      lockType: "issue",
      lockKey: "key-1",
      ownerId: "run-1",
      daemonPid: 111,
    });
    repo.insert({
      lockType: "workspace",
      lockKey: "key-2",
      ownerId: "run-2",
      daemonPid: 111,
    });
    repo.insert({
      lockType: "issue",
      lockKey: "key-3",
      ownerId: "run-3",
      daemonPid: 222,
    });

    const pid111 = repo.findByDaemonPid(111);
    expect(pid111).toHaveLength(2);
    expect(pid111.map((l) => l.ownerId).sort()).toEqual(["run-1", "run-2"]);

    const pid222 = repo.findByDaemonPid(222);
    expect(pid222).toHaveLength(1);
    expect(pid222[0].ownerId).toBe("run-3");
  });

  it("deleteByOwner() removes only locks matching owner_id", () => {
    repo.insert({
      lockType: "issue",
      lockKey: "key-1",
      ownerId: "run-1",
      daemonPid: 111,
    });
    repo.insert({
      lockType: "workspace",
      lockKey: "key-2",
      ownerId: "run-1",
      daemonPid: 111,
    });
    repo.insert({
      lockType: "issue",
      lockKey: "key-3",
      ownerId: "run-2",
      daemonPid: 111,
    });

    repo.deleteByOwner("run-1");
    const remaining = repo.findByDaemonPid(111);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ownerId).toBe("run-2");
  });

  it("deleteAll() removes all locks", () => {
    repo.insert({
      lockType: "issue",
      lockKey: "key-1",
      ownerId: "run-1",
      daemonPid: 111,
    });
    repo.insert({
      lockType: "workspace",
      lockKey: "key-2",
      ownerId: "run-2",
      daemonPid: 222,
    });

    repo.deleteAll();
    const remaining = repo.findByDaemonPid(111);
    expect(remaining).toHaveLength(0);
    const remaining2 = repo.findByDaemonPid(222);
    expect(remaining2).toHaveLength(0);
  });
});

describe("storage/repositories/runs - pause context extensions", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-run-pause-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updateStatus accepts 'interrupted' status", () => {
    runRepo.insert({
      id: "run-int",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-int", { status: "interrupted" });
    const row = runRepo.findById("run-int");
    expect(row!.status).toBe("interrupted");
  });

  it("updateStatus accepts 'waiting_for_input' status", () => {
    runRepo.insert({
      id: "run-wfi",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-wfi", { status: "waiting_for_input" });
    const row = runRepo.findById("run-wfi");
    expect(row!.status).toBe("waiting_for_input");
  });

  it("updateStatus saves pauseReason and pauseContext", () => {
    runRepo.insert({
      id: "run-pause",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    const ctx = { step: "validation", attempt: 2 };
    runRepo.updateStatus("run-pause", {
      status: "waiting_for_input",
      pauseReason: "needs approval",
      pauseContext: ctx,
    });
    const row = runRepo.findById("run-pause");
    expect(row!.pauseReason).toBe("needs approval");
    expect(row!.pauseContext).toEqual(ctx);
  });

  it("findById returns pauseReason and pauseContext fields", () => {
    runRepo.insert({
      id: "run-pr",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    const row = runRepo.findById("run-pr");
    expect(row).toBeDefined();
    expect(row!.pauseReason).toBeNull();
    expect(row!.pauseContext).toBeNull();
  });

  it("clearPauseContext resets pause fields to null", () => {
    runRepo.insert({
      id: "run-clr",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-clr", {
      status: "waiting_for_input",
      pauseReason: "needs review",
      pauseContext: { data: true },
    });
    runRepo.clearPauseContext("run-clr");
    const row = runRepo.findById("run-clr");
    expect(row!.pauseReason).toBeNull();
    expect(row!.pauseContext).toBeNull();
  });
});

describe("durability/locks - acquire/release business logic", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let lockRepo: LockRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-lock-logic-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    lockRepo = createLockRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquireLock returns true when lock is available", () => {
    const result = acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "owner/repo#1",
      ownerId: "run-1",
      daemonPid: 1000,
    });
    expect(result).toBe(true);
  });

  it("acquireLock returns false when lock is already held", () => {
    acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "owner/repo#1",
      ownerId: "run-1",
      daemonPid: 1000,
    });
    const result = acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "owner/repo#1",
      ownerId: "run-2",
      daemonPid: 1000,
    });
    expect(result).toBe(false);
  });

  it("releaseLock removes the lock so re-acquire succeeds", () => {
    acquireLock(lockRepo, {
      lockType: "workspace",
      lockKey: "/tmp/ws1",
      ownerId: "run-1",
      daemonPid: 1000,
    });
    releaseLock(lockRepo, "workspace", "/tmp/ws1", "run-1");

    const result = acquireLock(lockRepo, {
      lockType: "workspace",
      lockKey: "/tmp/ws1",
      ownerId: "run-2",
      daemonPid: 1000,
    });
    expect(result).toBe(true);
  });

  it("releaseLock is idempotent (no-op if lock does not exist)", () => {
    // Should not throw
    expect(() =>
      releaseLock(lockRepo, "issue", "nonexistent", "run-99")
    ).not.toThrow();
  });

  it("releaseAllStaleLocks removes locks from different PIDs", () => {
    acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "key-1",
      ownerId: "run-1",
      daemonPid: 999, // old crashed daemon
    });
    acquireLock(lockRepo, {
      lockType: "workspace",
      lockKey: "key-2",
      ownerId: "run-2",
      daemonPid: 888, // another old daemon
    });
    acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "key-3",
      ownerId: "run-3",
      daemonPid: 1000, // current daemon
    });

    const released = releaseAllStaleLocks(lockRepo, 1000);
    expect(released).toBe(2);

    // Current PID lock should still be there
    const remaining = lockRepo.findByDaemonPid(1000);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ownerId).toBe("run-3");
  });

  it("releaseAllStaleLocks preserves locks owned by current PID", () => {
    acquireLock(lockRepo, {
      lockType: "issue",
      lockKey: "key-1",
      ownerId: "run-1",
      daemonPid: 1000,
    });
    acquireLock(lockRepo, {
      lockType: "workspace",
      lockKey: "key-2",
      ownerId: "run-2",
      daemonPid: 1000,
    });

    const released = releaseAllStaleLocks(lockRepo, 1000);
    expect(released).toBe(0);

    const remaining = lockRepo.findByDaemonPid(1000);
    expect(remaining).toHaveLength(2);
  });
});
