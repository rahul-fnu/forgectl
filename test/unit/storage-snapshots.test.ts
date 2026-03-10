import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createSnapshotRepository,
  type SnapshotRepository,
} from "../../src/storage/repositories/snapshots.js";

describe("storage/repositories/snapshots", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: SnapshotRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-snapshot-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createSnapshotRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() persists a snapshot row and returns it", () => {
    const row = repo.insert({
      runId: "run-1",
      stepName: "build",
      timestamp: "2026-01-01T00:00:00Z",
      state: { status: "running", step: 1 },
    });
    expect(row).toBeDefined();
    expect(row.id).toBeTypeOf("number");
    expect(row.runId).toBe("run-1");
    expect(row.stepName).toBe("build");
    expect(row.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(row.state).toEqual({ status: "running", step: 1 });
  });

  it("findByRunId() returns all snapshots for a run", () => {
    repo.insert({ runId: "run-1", stepName: "build", timestamp: "2026-01-01T00:00:00Z", state: { step: 1 } });
    repo.insert({ runId: "run-1", stepName: "test", timestamp: "2026-01-01T00:01:00Z", state: { step: 2 } });
    repo.insert({ runId: "run-2", stepName: "build", timestamp: "2026-01-01T00:00:00Z", state: {} });

    const snapshots = repo.findByRunId("run-1");
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.stepName)).toEqual(["build", "test"]);
  });

  it("latest() returns the most recent snapshot for a run", () => {
    repo.insert({ runId: "run-1", stepName: "build", timestamp: "2026-01-01T00:00:00Z", state: { step: 1 } });
    repo.insert({ runId: "run-1", stepName: "test", timestamp: "2026-01-01T00:01:00Z", state: { step: 2 } });
    repo.insert({ runId: "run-1", stepName: "deploy", timestamp: "2026-01-01T00:02:00Z", state: { step: 3 } });

    const latest = repo.latest("run-1");
    expect(latest).toBeDefined();
    expect(latest!.stepName).toBe("deploy");
    expect(latest!.state).toEqual({ step: 3 });
  });

  it("latest() returns undefined when no snapshots exist", () => {
    const latest = repo.latest("nonexistent");
    expect(latest).toBeUndefined();
  });

  it("state JSON round-trips correctly", () => {
    const complexState = {
      nested: { deep: { value: 42 } },
      array: ["a", "b"],
      running: true,
    };
    repo.insert({
      runId: "run-1",
      stepName: "complex",
      timestamp: "2026-01-01T00:00:00Z",
      state: complexState,
    });
    const snapshots = repo.findByRunId("run-1");
    expect(snapshots[0].state).toEqual(complexState);
  });

  it("findByRunId() returns empty array when no snapshots exist", () => {
    const snapshots = repo.findByRunId("nonexistent");
    expect(snapshots).toEqual([]);
  });
});
