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
  pauseRun,
  resumeRun,
  type PauseContext,
} from "../../src/durability/pause.js";

describe("durability/pause", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-pause-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertRun(id: string, status: string) {
    const row = runRepo.insert({
      id,
      task: "test task",
      submittedAt: new Date().toISOString(),
    });
    if (status !== "queued") {
      runRepo.updateStatus(id, { status });
    }
    return row;
  }

  describe("pauseRun", () => {
    it("transitions a running run to waiting_for_input with context", () => {
      insertRun("run-1", "running");
      const ctx: PauseContext = {
        reason: "needs-approval",
        phase: "validation",
        question: "Should we deploy?",
        serializedState: { step: 3 },
      };
      pauseRun(runRepo, "run-1", ctx);
      const row = runRepo.findById("run-1")!;
      expect(row.status).toBe("waiting_for_input");
      expect(row.pauseReason).toBe("needs-approval");
      expect(row.pauseContext).toEqual(ctx);
    });

    it("throws if run is not in running status", () => {
      insertRun("run-2", "queued");
      expect(() =>
        pauseRun(runRepo, "run-2", { reason: "test", phase: "init" }),
      ).toThrow("expected running");
    });

    it("throws if run does not exist", () => {
      expect(() =>
        pauseRun(runRepo, "nonexistent", { reason: "test", phase: "init" }),
      ).toThrow("not found");
    });
  });

  describe("resumeRun", () => {
    it("transitions waiting_for_input back to running and clears pause context", () => {
      insertRun("run-3", "running");
      pauseRun(runRepo, "run-3", {
        reason: "needs-input",
        phase: "execution",
        question: "What environment?",
      });
      const result = resumeRun(runRepo, "run-3", "production");
      expect(result.runId).toBe("run-3");
      expect(result.humanInput).toBe("production");
      expect(result.pauseContext.reason).toBe("needs-input");
      expect(result.pauseContext.question).toBe("What environment?");

      const row = runRepo.findById("run-3")!;
      expect(row.status).toBe("running");
      expect(row.pauseReason).toBeNull();
      expect(row.pauseContext).toBeNull();
    });

    it("throws if run does not exist", () => {
      expect(() => resumeRun(runRepo, "no-such-run", "input")).toThrow(
        "not found",
      );
    });

    it("throws if run is not waiting_for_input", () => {
      insertRun("run-4", "completed");
      expect(() => resumeRun(runRepo, "run-4", "input")).toThrow(
        "not waiting_for_input",
      );
    });

    it("throws if run is in running status (not paused)", () => {
      insertRun("run-5", "running");
      expect(() => resumeRun(runRepo, "run-5", "input")).toThrow(
        "not waiting_for_input",
      );
    });
  });
});
