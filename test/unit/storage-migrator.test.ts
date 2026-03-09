import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { runs, pipelineRuns } from "../../src/storage/schema.js";
import { eq } from "drizzle-orm";

describe("storage/migrator", () => {
  const temps: string[] = [];

  function makeTempDb() {
    const dir = mkdtempSync(join(tmpdir(), "forgectl-mig-test-"));
    temps.push(dir);
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    return { db, dir };
  }

  afterEach(() => {
    for (const dir of temps) {
      rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it("creates the runs table", () => {
    const { db } = makeTempDb();
    runMigrations(db);
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("runs");
    closeDatabase(db);
  });

  it("creates the pipeline_runs table", () => {
    const { db } = makeTempDb();
    runMigrations(db);
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_runs'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("pipeline_runs");
    closeDatabase(db);
  });

  it("is idempotent (calling twice does not error)", () => {
    const { db } = makeTempDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    closeDatabase(db);
  });

  it("can insert and select from runs table after migration", () => {
    const { db } = makeTempDb();
    runMigrations(db);

    db.insert(runs).values({
      id: "run-1",
      task: "test task",
      status: "queued",
      submittedAt: new Date().toISOString(),
    }).run();

    const result = db.select().from(runs).where(eq(runs.id, "run-1")).all();
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("test task");
    expect(result[0].status).toBe("queued");
    closeDatabase(db);
  });

  it("can insert and select from pipeline_runs table after migration", () => {
    const { db } = makeTempDb();
    runMigrations(db);

    db.insert(pipelineRuns).values({
      id: "pipe-1",
      pipelineDefinition: JSON.stringify({ name: "test" }),
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();

    const result = db.select().from(pipelineRuns).where(eq(pipelineRuns.id, "pipe-1")).all();
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("running");
    closeDatabase(db);
  });
});
