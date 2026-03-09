import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/storage/database.js";

describe("storage/database", () => {
  const temps: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "forgectl-db-test-"));
    temps.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of temps) {
      rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it("creates a .db file at the specified path", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    closeDatabase(db);
  });

  it("enables WAL journal mode", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    const result = db.$client.pragma("journal_mode");
    expect(result).toEqual([{ journal_mode: "wal" }]);
    closeDatabase(db);
  });

  it("enables foreign keys", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    const result = db.$client.pragma("foreign_keys");
    expect(result).toEqual([{ foreign_keys: 1 }]);
    closeDatabase(db);
  });

  it("sets busy_timeout to 5000", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    const result = db.$client.pragma("busy_timeout");
    expect(result).toEqual([{ timeout: 5000 }]);
    closeDatabase(db);
  });

  it("uses default path when no path provided", () => {
    // We can't easily test the actual default path without side effects,
    // so we verify createDatabase works without arguments by using a temp HOME
    const dir = makeTempDir();
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const db = createDatabase();
      const expectedPath = join(dir, ".forgectl", "forgectl.db");
      expect(existsSync(expectedPath)).toBe(true);
      closeDatabase(db);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("closeDatabase closes the connection without error", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    expect(() => closeDatabase(db)).not.toThrow();
  });

  it("drizzle instance has schema attached", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = createDatabase(dbPath);
    // The query property should have the schema tables accessible
    expect(db.query.runs).toBeDefined();
    expect(db.query.pipelineRuns).toBeDefined();
    closeDatabase(db);
  });
});
