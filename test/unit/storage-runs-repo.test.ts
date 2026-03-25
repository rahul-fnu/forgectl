import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";

describe("storage/repositories/runs", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: RunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-run-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createRunRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates a run and returns it with all fields", () => {
    const row = repo.insert({
      id: "run-1",
      task: "build the widget",
      workflow: "code",
      options: { task: "build the widget", workflow: "code" },
      status: "queued",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    expect(row).toBeDefined();
    expect(row.id).toBe("run-1");
    expect(row.task).toBe("build the widget");
    expect(row.workflow).toBe("code");
    expect(row.status).toBe("queued");
    expect(row.submittedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("findById() returns the inserted run", () => {
    repo.insert({
      id: "run-2",
      task: "test task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    const found = repo.findById("run-2");
    expect(found).toBeDefined();
    expect(found!.id).toBe("run-2");
    expect(found!.task).toBe("test task");
  });

  it("findById() returns undefined for nonexistent id", () => {
    const found = repo.findById("does-not-exist");
    expect(found).toBeUndefined();
  });

  it("updateStatus() changes status and sets completedAt", () => {
    repo.insert({
      id: "run-3",
      task: "some task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus("run-3", {
      status: "completed",
      completedAt: "2026-01-01T01:00:00Z",
    });
    const updated = repo.findById("run-3");
    expect(updated!.status).toBe("completed");
    expect(updated!.completedAt).toBe("2026-01-01T01:00:00Z");
  });

  it("updateStatus() sets startedAt and result", () => {
    repo.insert({
      id: "run-4",
      task: "some task",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus("run-4", {
      status: "running",
      startedAt: "2026-01-01T00:30:00Z",
    });
    const running = repo.findById("run-4");
    expect(running!.status).toBe("running");
    expect(running!.startedAt).toBe("2026-01-01T00:30:00Z");

    const resultData = { success: true, durationMs: 100 };
    repo.updateStatus("run-4", {
      status: "completed",
      completedAt: "2026-01-01T01:00:00Z",
      result: resultData,
    });
    const done = repo.findById("run-4");
    expect(done!.status).toBe("completed");
    expect(done!.result).toEqual(resultData);
  });

  it("updateStatus() sets error on failure", () => {
    repo.insert({
      id: "run-5",
      task: "will fail",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus("run-5", {
      status: "failed",
      completedAt: "2026-01-01T01:00:00Z",
      error: "something went wrong",
    });
    const failed = repo.findById("run-5");
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("something went wrong");
  });

  it("list() returns all runs", () => {
    repo.insert({ id: "r1", task: "t1", submittedAt: "2026-01-01T00:00:00Z" });
    repo.insert({ id: "r2", task: "t2", submittedAt: "2026-01-01T00:01:00Z" });
    repo.insert({ id: "r3", task: "t3", submittedAt: "2026-01-01T00:02:00Z" });
    const all = repo.list();
    expect(all).toHaveLength(3);
    expect(all.map(r => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("findByStatus() returns runs matching a given status", () => {
    repo.insert({ id: "r1", task: "t1", status: "queued", submittedAt: "2026-01-01T00:00:00Z" });
    repo.insert({ id: "r2", task: "t2", status: "queued", submittedAt: "2026-01-01T00:01:00Z" });
    repo.insert({ id: "r3", task: "t3", status: "running", submittedAt: "2026-01-01T00:02:00Z" });
    const queued = repo.findByStatus("queued");
    expect(queued).toHaveLength(2);
    expect(queued.map(r => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("options JSON round-trips correctly", () => {
    const opts = { task: "build", workflow: "code", verbose: true, input: ["a.txt"] };
    repo.insert({ id: "r-json", task: "build", options: opts, submittedAt: "2026-01-01T00:00:00Z" });
    const found = repo.findById("r-json");
    expect(found!.options).toEqual(opts);
  });

  it("result JSON round-trips correctly", () => {
    repo.insert({ id: "r-res", task: "build", submittedAt: "2026-01-01T00:00:00Z" });
    const result = { success: true, validation: { passed: true }, durationMs: 500 };
    repo.updateStatus("r-res", { status: "completed", result, completedAt: "2026-01-01T01:00:00Z" });
    const found = repo.findById("r-res");
    expect(found!.result).toEqual(result);
  });

  it("insert() defaults status to queued", () => {
    const row = repo.insert({ id: "r-def", task: "t", submittedAt: "2026-01-01T00:00:00Z" });
    expect(row.status).toBe("queued");
  });

  it("setComplexityAssessment() stores score and JSON assessment", () => {
    repo.insert({ id: "r-cx", task: "complex task", submittedAt: "2026-01-01T00:00:00Z" });
    const assessment = {
      complexityScore: 8,
      estimatedFiles: 15,
      estimatedEffort: "complex",
      riskFactors: ["cross-cutting", "migration"],
      recommendation: "split",
    };
    repo.setComplexityAssessment("r-cx", assessment);
    const found = repo.findById("r-cx");
    expect(found!.complexityScore).toBe(8);
    expect(found!.complexityAssessment).toEqual(assessment);
  });

  it("complexityScore and complexityAssessment default to null", () => {
    const row = repo.insert({ id: "r-nocx", task: "simple task", submittedAt: "2026-01-01T00:00:00Z" });
    expect(row.complexityScore).toBeNull();
    expect(row.complexityAssessment).toBeNull();
  });
});
