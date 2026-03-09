import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createPipelineRepository, type PipelineRepository } from "../../src/storage/repositories/pipelines.js";

describe("storage/repositories/pipelines", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: PipelineRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-pipe-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createPipelineRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() creates a pipeline run and returns it", () => {
    const def = { name: "test-pipeline", nodes: [{ id: "n1", task: "do stuff" }] };
    const row = repo.insert({
      id: "pipe-1",
      pipelineDefinition: def,
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(row).toBeDefined();
    expect(row.id).toBe("pipe-1");
    expect(row.status).toBe("running");
    expect(row.startedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("findById() returns the inserted pipeline run", () => {
    const def = { name: "p" };
    repo.insert({ id: "pipe-2", pipelineDefinition: def, startedAt: "2026-01-01T00:00:00Z" });
    const found = repo.findById("pipe-2");
    expect(found).toBeDefined();
    expect(found!.id).toBe("pipe-2");
  });

  it("findById() returns undefined for nonexistent id", () => {
    expect(repo.findById("nope")).toBeUndefined();
  });

  it("updateStatus() changes status and sets completedAt", () => {
    repo.insert({
      id: "pipe-3",
      pipelineDefinition: { name: "p" },
      startedAt: "2026-01-01T00:00:00Z",
    });
    repo.updateStatus("pipe-3", {
      status: "completed",
      completedAt: "2026-01-01T01:00:00Z",
    });
    const updated = repo.findById("pipe-3");
    expect(updated!.status).toBe("completed");
    expect(updated!.completedAt).toBe("2026-01-01T01:00:00Z");
  });

  it("updateNodeStates() updates JSON node states", () => {
    repo.insert({
      id: "pipe-4",
      pipelineDefinition: { name: "p" },
      startedAt: "2026-01-01T00:00:00Z",
    });
    const states = { n1: { status: "completed", result: { success: true } }, n2: { status: "running" } };
    repo.updateNodeStates("pipe-4", states);
    const found = repo.findById("pipe-4");
    expect(found!.nodeStates).toEqual(states);
  });

  it("list() returns all pipeline runs", () => {
    repo.insert({ id: "p1", pipelineDefinition: { name: "a" }, startedAt: "2026-01-01T00:00:00Z" });
    repo.insert({ id: "p2", pipelineDefinition: { name: "b" }, startedAt: "2026-01-01T00:01:00Z" });
    const all = repo.list();
    expect(all).toHaveLength(2);
    expect(all.map(r => r.id).sort()).toEqual(["p1", "p2"]);
  });

  it("pipelineDefinition JSON round-trips correctly", () => {
    const def = {
      name: "complex",
      description: "a complex pipeline",
      nodes: [
        { id: "n1", task: "first", depends_on: [] },
        { id: "n2", task: "second", depends_on: ["n1"] },
      ],
      defaults: { workflow: "code" },
    };
    repo.insert({ id: "pipe-json", pipelineDefinition: def, startedAt: "2026-01-01T00:00:00Z" });
    const found = repo.findById("pipe-json");
    expect(found!.pipelineDefinition).toEqual(def);
  });

  it("nodeStates JSON round-trips correctly", () => {
    repo.insert({ id: "pipe-ns", pipelineDefinition: { name: "p" }, startedAt: "2026-01-01T00:00:00Z" });
    const nodeStates = {
      build: { status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z" },
      test: { status: "running", startedAt: "2026-01-01T00:05:00Z" },
    };
    repo.updateNodeStates("pipe-ns", nodeStates);
    const found = repo.findById("pipe-ns");
    expect(found!.nodeStates).toEqual(nodeStates);
  });

  it("insert() defaults status to running", () => {
    const row = repo.insert({ id: "p-def", pipelineDefinition: { name: "p" }, startedAt: "2026-01-01T00:00:00Z" });
    expect(row.status).toBe("running");
  });
});
