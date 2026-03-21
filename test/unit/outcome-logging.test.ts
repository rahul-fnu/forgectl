import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createOutcomeRepository,
  type OutcomeRepository,
} from "../../src/storage/repositories/outcomes.js";

describe("storage/repositories/outcomes", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-outcome-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    outcomeRepo = createOutcomeRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates an outcome record", () => {
    outcomeRepo.insert({
      id: "run-1",
      taskId: "42",
      startedAt: "2026-03-21T10:00:00Z",
      completedAt: "2026-03-21T10:05:00Z",
      status: "success",
      totalTurns: 5,
    });

    const row = outcomeRepo.findById("run-1");
    expect(row).toBeDefined();
    expect(row!.id).toBe("run-1");
    expect(row!.taskId).toBe("42");
    expect(row!.startedAt).toBe("2026-03-21T10:00:00Z");
    expect(row!.completedAt).toBe("2026-03-21T10:05:00Z");
    expect(row!.status).toBe("success");
    expect(row!.totalTurns).toBe(5);
  });

  it("insert() handles null optional fields", () => {
    outcomeRepo.insert({
      id: "run-2",
      status: "failure",
    });

    const row = outcomeRepo.findById("run-2");
    expect(row).toBeDefined();
    expect(row!.taskId).toBeNull();
    expect(row!.startedAt).toBeNull();
    expect(row!.completedAt).toBeNull();
    expect(row!.totalTurns).toBeNull();
    expect(row!.lintIterations).toBeNull();
    expect(row!.reviewRounds).toBeNull();
    expect(row!.reviewCommentsJson).toBeNull();
    expect(row!.failureMode).toBeNull();
    expect(row!.failureDetail).toBeNull();
    expect(row!.humanReviewResult).toBeNull();
    expect(row!.humanReviewComments).toBeNull();
    expect(row!.modulesTouched).toBeNull();
    expect(row!.filesChanged).toBeNull();
    expect(row!.testsAdded).toBeNull();
    expect(row!.rawEventsJson).toBeNull();
  });

  it("findById() returns undefined for nonexistent id", () => {
    const row = outcomeRepo.findById("nonexistent");
    expect(row).toBeUndefined();
  });

  it("findByStatus() returns matching rows", () => {
    outcomeRepo.insert({ id: "run-1", status: "success" });
    outcomeRepo.insert({ id: "run-2", status: "failure" });
    outcomeRepo.insert({ id: "run-3", status: "success" });

    const successes = outcomeRepo.findByStatus("success");
    expect(successes).toHaveLength(2);
    expect(successes.map((r) => r.id).sort()).toEqual(["run-1", "run-3"]);

    const failures = outcomeRepo.findByStatus("failure");
    expect(failures).toHaveLength(1);
    expect(failures[0].id).toBe("run-2");
  });

  it("findByStatus() returns empty array for no matches", () => {
    outcomeRepo.insert({ id: "run-1", status: "success" });
    const results = outcomeRepo.findByStatus("nonexistent");
    expect(results).toEqual([]);
  });

  it("findAll() returns all rows", () => {
    outcomeRepo.insert({ id: "run-1", status: "success" });
    outcomeRepo.insert({ id: "run-2", status: "failure" });

    const all = outcomeRepo.findAll();
    expect(all).toHaveLength(2);
  });

  it("findAll() returns empty array when no rows", () => {
    const all = outcomeRepo.findAll();
    expect(all).toEqual([]);
  });

  it("update() modifies existing fields", () => {
    outcomeRepo.insert({
      id: "run-1",
      status: "success",
      totalTurns: 5,
    });

    outcomeRepo.update("run-1", {
      status: "failure",
      failureMode: "validation",
      failureDetail: "lint failed",
    });

    const row = outcomeRepo.findById("run-1");
    expect(row!.status).toBe("failure");
    expect(row!.failureMode).toBe("validation");
    expect(row!.failureDetail).toBe("lint failed");
    // Unchanged field should remain
    expect(row!.totalTurns).toBe(5);
  });

  it("update() with empty params is a no-op", () => {
    outcomeRepo.insert({ id: "run-1", status: "success" });
    outcomeRepo.update("run-1", {});
    const row = outcomeRepo.findById("run-1");
    expect(row!.status).toBe("success");
  });

  it("handles JSON fields correctly (modulesTouched)", () => {
    const modules = JSON.stringify(["src/auth", "src/config"]);
    outcomeRepo.insert({
      id: "run-1",
      status: "success",
      modulesTouched: modules,
    });

    const row = outcomeRepo.findById("run-1");
    expect(row!.modulesTouched).toBe(modules);
    const parsed = JSON.parse(row!.modulesTouched!);
    expect(parsed).toEqual(["src/auth", "src/config"]);
  });

  it("handles JSON fields correctly (reviewCommentsJson)", () => {
    const comments = JSON.stringify([
      { reviewer: "bot", comment: "LGTM" },
      { reviewer: "human", comment: "Fix the type" },
    ]);
    outcomeRepo.insert({
      id: "run-1",
      status: "success",
      reviewCommentsJson: comments,
    });

    const row = outcomeRepo.findById("run-1");
    const parsed = JSON.parse(row!.reviewCommentsJson!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].reviewer).toBe("bot");
  });

  it("handles JSON fields correctly (rawEventsJson)", () => {
    const events = JSON.stringify([
      { type: "dispatch", timestamp: "2026-03-21T10:00:00Z", data: {} },
      { type: "completion", timestamp: "2026-03-21T10:05:00Z", data: { status: "success" } },
    ]);
    outcomeRepo.insert({
      id: "run-1",
      status: "success",
      rawEventsJson: events,
    });

    const row = outcomeRepo.findById("run-1");
    const parsed = JSON.parse(row!.rawEventsJson!);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].type).toBe("completion");
  });

  it("stores all numeric fields correctly", () => {
    outcomeRepo.insert({
      id: "run-1",
      status: "success",
      totalTurns: 12,
      lintIterations: 3,
      reviewRounds: 2,
      humanReviewComments: 5,
      filesChanged: 8,
      testsAdded: 4,
    });

    const row = outcomeRepo.findById("run-1");
    expect(row!.totalTurns).toBe(12);
    expect(row!.lintIterations).toBe(3);
    expect(row!.reviewRounds).toBe(2);
    expect(row!.humanReviewComments).toBe(5);
    expect(row!.filesChanged).toBe(8);
    expect(row!.testsAdded).toBe(4);
  });

  it("stores failure detail fields correctly", () => {
    outcomeRepo.insert({
      id: "run-1",
      status: "failure",
      failureMode: "validation",
      failureDetail: "TypeScript compilation error on line 42",
      humanReviewResult: "rejected",
    });

    const row = outcomeRepo.findById("run-1");
    expect(row!.failureMode).toBe("validation");
    expect(row!.failureDetail).toBe("TypeScript compilation error on line 42");
    expect(row!.humanReviewResult).toBe("rejected");
  });
});
