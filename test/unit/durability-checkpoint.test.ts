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
  createSnapshotRepository,
  type SnapshotRepository,
} from "../../src/storage/repositories/snapshots.js";
import {
  saveCheckpoint,
  loadLatestCheckpoint,
  type CheckpointState,
} from "../../src/durability/checkpoint.js";

describe("durability/checkpoint", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-checkpoint-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    snapshotRepo = createSnapshotRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveCheckpoint creates snapshot with correct stepName and state", () => {
    saveCheckpoint(snapshotRepo, "run-1", "prepare");
    const snap = snapshotRepo.latest("run-1");
    expect(snap).toBeDefined();
    expect(snap!.stepName).toBe("after:prepare");
    const state = snap!.state as CheckpointState;
    expect(state.phase).toBe("prepare");
    expect(state.timestamp).toBeTruthy();
  });

  it("saveCheckpoint includes optional metadata", () => {
    saveCheckpoint(snapshotRepo, "run-1", "execute", { agentStatus: "success" });
    const snap = snapshotRepo.latest("run-1");
    const state = snap!.state as CheckpointState & { agentStatus: string };
    expect(state.phase).toBe("execute");
    expect(state.agentStatus).toBe("success");
  });

  it("loadLatestCheckpoint returns null for unknown runId", () => {
    const result = loadLatestCheckpoint(snapshotRepo, "nonexistent");
    expect(result).toBeNull();
  });

  it("loadLatestCheckpoint returns latest checkpoint state", () => {
    saveCheckpoint(snapshotRepo, "run-1", "prepare");
    const result = loadLatestCheckpoint(snapshotRepo, "run-1");
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("prepare");
    expect(result!.timestamp).toBeTruthy();
  });

  it("multiple checkpoints: latest returns most recent", () => {
    saveCheckpoint(snapshotRepo, "run-1", "prepare");
    saveCheckpoint(snapshotRepo, "run-1", "execute");
    saveCheckpoint(snapshotRepo, "run-1", "validate");

    const result = loadLatestCheckpoint(snapshotRepo, "run-1");
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("validate");
  });
});
