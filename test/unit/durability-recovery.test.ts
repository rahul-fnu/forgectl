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
  createRunRepository,
  type RunRepository,
} from "../../src/storage/repositories/runs.js";
import {
  createSnapshotRepository,
  type SnapshotRepository,
} from "../../src/storage/repositories/snapshots.js";
import { saveCheckpoint } from "../../src/durability/checkpoint.js";
import {
  recoverInterruptedRuns,
  type RecoveryResult,
} from "../../src/durability/recovery.js";

describe("durability/recovery", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-recovery-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
    snapshotRepo = createSnapshotRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no interrupted runs exist", () => {
    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toEqual([]);
  });

  it("marks run with no snapshot as interrupted with 'no checkpoint' message", () => {
    runRepo.insert({
      id: "run-1",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-1", {
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
    });

    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBe("run-1");
    expect(results[0].action).toBe("marked_interrupted");
    expect(results[0].reason).toContain("before any checkpoint was saved");

    const row = runRepo.findById("run-1");
    expect(row!.status).toBe("interrupted");
    expect(row!.error).toContain("before any checkpoint was saved");
  });

  it("marks run with snapshot at 'prepare' as interrupted with phase info", () => {
    runRepo.insert({
      id: "run-2",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-2", {
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
    });
    saveCheckpoint(snapshotRepo, "run-2", "prepare");

    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toHaveLength(1);
    expect(results[0].reason).toContain("after prepare phase");

    const row = runRepo.findById("run-2");
    expect(row!.status).toBe("interrupted");
    expect(row!.error).toContain("after prepare phase");
  });

  it("marks run with snapshot at 'execute' as interrupted with phase info", () => {
    runRepo.insert({
      id: "run-3",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-3", {
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
    });
    saveCheckpoint(snapshotRepo, "run-3", "prepare");
    saveCheckpoint(snapshotRepo, "run-3", "execute");

    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toHaveLength(1);
    expect(results[0].reason).toContain("after execute phase");
  });

  it("only affects runs with 'running' status", () => {
    // queued run
    runRepo.insert({
      id: "run-queued",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });

    // completed run
    runRepo.insert({
      id: "run-done",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-done", {
      status: "completed",
      completedAt: "2026-01-01T00:01:00Z",
    });

    // failed run
    runRepo.insert({
      id: "run-fail",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-fail", {
      status: "failed",
      completedAt: "2026-01-01T00:01:00Z",
      error: "some error",
    });

    // running run (should be affected)
    runRepo.insert({
      id: "run-active",
      task: "task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    runRepo.updateStatus("run-active", {
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
    });

    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBe("run-active");

    // Verify other statuses unchanged
    expect(runRepo.findById("run-queued")!.status).toBe("queued");
    expect(runRepo.findById("run-done")!.status).toBe("completed");
    expect(runRepo.findById("run-fail")!.status).toBe("failed");
  });

  it("handles multiple interrupted runs", () => {
    for (let i = 1; i <= 3; i++) {
      runRepo.insert({
        id: `run-${i}`,
        task: "task",
        submittedAt: "2026-01-01T00:00:00Z",
      });
      runRepo.updateStatus(`run-${i}`, {
        status: "running",
        startedAt: "2026-01-01T00:00:01Z",
      });
    }
    saveCheckpoint(snapshotRepo, "run-2", "validate");

    const results = recoverInterruptedRuns(runRepo, snapshotRepo);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.action === "marked_interrupted")).toBe(true);
  });
});
