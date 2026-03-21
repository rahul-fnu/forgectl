import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRetryRepository, type RetryRepository } from "../../src/storage/repositories/retries.js";
import { createState } from "../../src/orchestrator/state.js";
import { restoreRetryState, cleanupRetryRecords } from "../../src/orchestrator/retry.js";

describe("storage/repositories/retries", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let retryRepo: RetryRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-retry-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    retryRepo = createRetryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates a retry record and returns it", () => {
    const row = retryRepo.insert({
      runId: "issue-1",
      attempt: 1,
      nextRetryAt: "2026-03-13T10:00:30Z",
      backoffMs: 10000,
      failureReason: "Agent timed out",
    });
    expect(row.runId).toBe("issue-1");
    expect(row.attempt).toBe(1);
    expect(row.nextRetryAt).toBe("2026-03-13T10:00:30Z");
    expect(row.backoffMs).toBe(10000);
    expect(row.failureReason).toBe("Agent timed out");
  });

  it("insert() works without optional fields", () => {
    const row = retryRepo.insert({
      runId: "issue-2",
      attempt: 1,
    });
    expect(row.runId).toBe("issue-2");
    expect(row.nextRetryAt).toBeNull();
    expect(row.backoffMs).toBeNull();
    expect(row.failureReason).toBeNull();
  });

  it("findByRunId() returns all retry records for a run", () => {
    retryRepo.insert({ runId: "issue-1", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-1", attempt: 2, backoffMs: 20000 });
    retryRepo.insert({ runId: "issue-2", attempt: 1, backoffMs: 10000 });

    const results = retryRepo.findByRunId("issue-1");
    expect(results).toHaveLength(2);
    expect(results[0].runId).toBe("issue-1");
    expect(results[1].runId).toBe("issue-1");
  });

  it("findByRunId() returns empty array for nonexistent run", () => {
    const results = retryRepo.findByRunId("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("latestAttempt() returns the highest attempt number for a run", () => {
    retryRepo.insert({ runId: "issue-1", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-1", attempt: 2, backoffMs: 20000 });
    retryRepo.insert({ runId: "issue-1", attempt: 3, backoffMs: 40000 });

    expect(retryRepo.latestAttempt("issue-1")).toBe(3);
  });

  it("latestAttempt() returns 0 for nonexistent run", () => {
    expect(retryRepo.latestAttempt("nonexistent")).toBe(0);
  });

  it("deleteByRunId() removes all retry records for a run", () => {
    retryRepo.insert({ runId: "issue-1", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-1", attempt: 2, backoffMs: 20000 });
    retryRepo.insert({ runId: "issue-2", attempt: 1, backoffMs: 10000 });

    retryRepo.deleteByRunId("issue-1");

    expect(retryRepo.findByRunId("issue-1")).toHaveLength(0);
    expect(retryRepo.findByRunId("issue-2")).toHaveLength(1);
  });
});

describe("retry state persistence and recovery", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let retryRepo: RetryRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-retry-recovery-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    retryRepo = createRetryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restoreRetryState() loads attempt counts from SQLite into in-memory state", () => {
    // Simulate previous daemon run writing retry records
    retryRepo.insert({ runId: "issue-A", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-A", attempt: 2, backoffMs: 20000 });
    retryRepo.insert({ runId: "issue-B", attempt: 1, backoffMs: 10000 });

    // Create fresh in-memory state (simulates daemon restart)
    const state = createState();
    expect(state.retryAttempts.size).toBe(0);

    // Restore from SQLite
    const restored = restoreRetryState(state, retryRepo, ["issue-A", "issue-B", "issue-C"]);

    expect(restored).toEqual(["issue-A", "issue-B"]);
    expect(state.retryAttempts.get("issue-A")).toBe(2);
    expect(state.retryAttempts.get("issue-B")).toBe(1);
    expect(state.retryAttempts.has("issue-C")).toBe(false);
  });

  it("attempt counts survive simulated restart", () => {
    // First "daemon run": record retries
    retryRepo.insert({ runId: "issue-X", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-X", attempt: 2, backoffMs: 20000 });

    // Verify data is in SQLite
    expect(retryRepo.latestAttempt("issue-X")).toBe(2);

    // Second "daemon run": fresh state, restore from SQLite
    const freshState = createState();
    restoreRetryState(freshState, retryRepo, ["issue-X"]);

    expect(freshState.retryAttempts.get("issue-X")).toBe(2);
  });

  it("cleanupRetryRecords() removes records from SQLite", () => {
    retryRepo.insert({ runId: "issue-done", attempt: 1, backoffMs: 10000 });
    retryRepo.insert({ runId: "issue-done", attempt: 2, backoffMs: 20000 });

    cleanupRetryRecords("issue-done", retryRepo);

    expect(retryRepo.findByRunId("issue-done")).toHaveLength(0);
    expect(retryRepo.latestAttempt("issue-done")).toBe(0);
  });

  it("cleanupRetryRecords() is safe with undefined repo", () => {
    // Should not throw
    cleanupRetryRecords("issue-1", undefined);
  });
});
