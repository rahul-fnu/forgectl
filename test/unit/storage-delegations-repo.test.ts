import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createDelegationRepository,
  type DelegationRepository,
} from "../../src/storage/repositories/delegations.js";

describe("storage/repositories/delegations", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: DelegationRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-delegation-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createDelegationRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() returns a DelegationRow with auto-increment id", () => {
    const row = repo.insert({
      parentRunId: "parent-run-1",
      taskSpec: { task: "do something", workflow: "code" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(row).toBeDefined();
    expect(typeof row.id).toBe("number");
    expect(row.id).toBeGreaterThan(0);
    expect(row.parentRunId).toBe("parent-run-1");
    expect(row.status).toBe("pending");
    expect(row.retryCount).toBe(0);
  });

  it("insert() assigns incrementing ids", () => {
    const row1 = repo.insert({
      parentRunId: "parent-run-1",
      taskSpec: { task: "task 1" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const row2 = repo.insert({
      parentRunId: "parent-run-1",
      taskSpec: { task: "task 2" },
      createdAt: "2026-01-01T00:01:00Z",
    });
    expect(row2.id).toBeGreaterThan(row1.id);
  });

  it("findById() returns undefined for non-existent id", () => {
    const found = repo.findById(9999);
    expect(found).toBeUndefined();
  });

  it("findById() returns the inserted delegation", () => {
    const inserted = repo.insert({
      parentRunId: "parent-run-2",
      childRunId: "child-run-2",
      taskSpec: { task: "find me" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const found = repo.findById(inserted.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inserted.id);
    expect(found!.parentRunId).toBe("parent-run-2");
    expect(found!.childRunId).toBe("child-run-2");
  });

  it("findByParentRunId() returns all delegations for a parent", () => {
    repo.insert({
      parentRunId: "parent-A",
      taskSpec: { task: "task 1" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    repo.insert({
      parentRunId: "parent-A",
      taskSpec: { task: "task 2" },
      createdAt: "2026-01-01T00:01:00Z",
    });
    repo.insert({
      parentRunId: "parent-B",
      taskSpec: { task: "task 3" },
      createdAt: "2026-01-01T00:02:00Z",
    });

    const results = repo.findByParentRunId("parent-A");
    expect(results).toHaveLength(2);
    expect(results.every(r => r.parentRunId === "parent-A")).toBe(true);
  });

  it("findByParentRunId() returns empty array when no delegations exist", () => {
    const results = repo.findByParentRunId("nonexistent-parent");
    expect(results).toEqual([]);
  });

  it("findByChildRunId() returns the delegation for a child", () => {
    repo.insert({
      parentRunId: "parent-1",
      childRunId: "child-xyz",
      taskSpec: { task: "find by child" },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const found = repo.findByChildRunId("child-xyz");
    expect(found).toBeDefined();
    expect(found!.childRunId).toBe("child-xyz");
    expect(found!.parentRunId).toBe("parent-1");
  });

  it("findByChildRunId() returns undefined for nonexistent child", () => {
    const found = repo.findByChildRunId("nonexistent-child");
    expect(found).toBeUndefined();
  });

  it("updateStatus() changes status", () => {
    const inserted = repo.insert({
      parentRunId: "parent-3",
      taskSpec: { task: "update me" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus(inserted.id, "running");
    const updated = repo.findById(inserted.id);
    expect(updated!.status).toBe("running");
  });

  it("updateStatus() sets result when provided", () => {
    const inserted = repo.insert({
      parentRunId: "parent-4",
      taskSpec: { task: "update with result" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const resultData = { success: true, output: "done" };
    repo.updateStatus(inserted.id, "completed", resultData);
    const updated = repo.findById(inserted.id);
    expect(updated!.status).toBe("completed");
    expect(updated!.result).toEqual(resultData);
    expect(updated!.completedAt).toBeDefined();
    expect(updated!.completedAt).not.toBeNull();
  });

  it("updateStatus() sets completedAt when status is 'failed'", () => {
    const inserted = repo.insert({
      parentRunId: "parent-5",
      taskSpec: { task: "will fail" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus(inserted.id, "failed");
    const updated = repo.findById(inserted.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.completedAt).toBeDefined();
    expect(updated!.completedAt).not.toBeNull();
  });

  it("countByParentAndStatus() returns correct count", () => {
    repo.insert({ parentRunId: "parent-6", taskSpec: { task: "t1" }, createdAt: "2026-01-01T00:00:00Z" });
    repo.insert({ parentRunId: "parent-6", taskSpec: { task: "t2" }, createdAt: "2026-01-01T00:01:00Z" });
    const inserted3 = repo.insert({ parentRunId: "parent-6", taskSpec: { task: "t3" }, createdAt: "2026-01-01T00:02:00Z" });
    repo.updateStatus(inserted3.id, "completed");

    const pendingCount = repo.countByParentAndStatus("parent-6", "pending");
    expect(pendingCount).toBe(2);

    const completedCount = repo.countByParentAndStatus("parent-6", "completed");
    expect(completedCount).toBe(1);
  });

  it("list() returns all rows", () => {
    repo.insert({ parentRunId: "p1", taskSpec: { task: "a" }, createdAt: "2026-01-01T00:00:00Z" });
    repo.insert({ parentRunId: "p2", taskSpec: { task: "b" }, createdAt: "2026-01-01T00:01:00Z" });
    repo.insert({ parentRunId: "p3", taskSpec: { task: "c" }, createdAt: "2026-01-01T00:02:00Z" });
    const all = repo.list();
    expect(all).toHaveLength(3);
  });

  it("taskSpec JSON round-trips correctly", () => {
    const spec = { task: "build widget", workflow: "code", args: ["--verbose"], nested: { key: "value" } };
    const inserted = repo.insert({
      parentRunId: "parent-json",
      taskSpec: spec,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const found = repo.findById(inserted.id);
    expect(found!.taskSpec).toEqual(spec);
  });

  it("result JSON round-trips correctly", () => {
    const inserted = repo.insert({
      parentRunId: "parent-result",
      taskSpec: { task: "do work" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const resultData = { success: true, validation: { passed: true }, durationMs: 500 };
    repo.updateStatus(inserted.id, "completed", resultData);
    const found = repo.findById(inserted.id);
    expect(found!.result).toEqual(resultData);
  });

  it("status defaults to 'pending'", () => {
    const row = repo.insert({
      parentRunId: "parent-default",
      taskSpec: { task: "check default" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(row.status).toBe("pending");
  });

  it("retryCount defaults to 0", () => {
    const row = repo.insert({
      parentRunId: "parent-retry",
      taskSpec: { task: "check retry default" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(row.retryCount).toBe(0);
  });
});

describe("storage/repositories/runs — new delegation columns", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-runs-delegation-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() without new fields succeeds and returns null defaults", async () => {
    const { createRunRepository } = await import("../../src/storage/repositories/runs.js");
    const repo = createRunRepository(db);
    const row = repo.insert({
      id: "run-no-delegation",
      task: "plain task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    expect(row.parentRunId).toBeNull();
    expect(row.role).toBeNull();
    expect(row.depth).toBe(0);
    expect(row.maxChildren).toBeNull();
    expect(row.childrenDispatched).toBe(0);
  });

  it("insert() with delegation fields stores and returns them", async () => {
    const { createRunRepository } = await import("../../src/storage/repositories/runs.js");
    const repo = createRunRepository(db);
    const row = repo.insert({
      id: "run-child",
      task: "child task",
      submittedAt: "2026-01-01T00:00:00Z",
      parentRunId: "run-parent",
      role: "child",
      depth: 1,
      maxChildren: 5,
      childrenDispatched: 0,
    });
    expect(row.parentRunId).toBe("run-parent");
    expect(row.role).toBe("child");
    expect(row.depth).toBe(1);
    expect(row.maxChildren).toBe(5);
    expect(row.childrenDispatched).toBe(0);
  });
});
