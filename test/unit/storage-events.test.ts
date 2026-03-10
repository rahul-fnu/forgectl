import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createEventRepository,
  type EventRepository,
} from "../../src/storage/repositories/events.js";

describe("storage/repositories/events", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: EventRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-event-repo-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createEventRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert() persists an event row and returns it", () => {
    const row = repo.insert({
      runId: "run-1",
      type: "started",
      timestamp: "2026-01-01T00:00:00Z",
      data: { agent: "claude" },
    });
    expect(row).toBeDefined();
    expect(row.id).toBeTypeOf("number");
    expect(row.runId).toBe("run-1");
    expect(row.type).toBe("started");
    expect(row.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(row.data).toEqual({ agent: "claude" });
  });

  it("findByRunId() returns all events for a run", () => {
    repo.insert({ runId: "run-1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: {} });
    repo.insert({ runId: "run-1", type: "completed", timestamp: "2026-01-01T00:01:00Z", data: {} });
    repo.insert({ runId: "run-2", type: "started", timestamp: "2026-01-01T00:00:00Z", data: {} });

    const events = repo.findByRunId("run-1");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["started", "completed"]);
  });

  it("findByRunIdAndType() filters by both runId and type", () => {
    repo.insert({ runId: "run-1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: {} });
    repo.insert({ runId: "run-1", type: "validation", timestamp: "2026-01-01T00:01:00Z", data: { step: 1 } });
    repo.insert({ runId: "run-1", type: "validation", timestamp: "2026-01-01T00:02:00Z", data: { step: 2 } });
    repo.insert({ runId: "run-2", type: "validation", timestamp: "2026-01-01T00:00:00Z", data: {} });

    const validations = repo.findByRunIdAndType("run-1", "validation");
    expect(validations).toHaveLength(2);
    expect(validations.every((e) => e.type === "validation")).toBe(true);
    expect(validations.every((e) => e.runId === "run-1")).toBe(true);
  });

  it("insert() with null data stores null, not 'null' string", () => {
    const row = repo.insert({
      runId: "run-1",
      type: "started",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(row.data).toBeNull();
  });

  it("insert() with undefined data stores null", () => {
    const row = repo.insert({
      runId: "run-1",
      type: "started",
      timestamp: "2026-01-01T00:00:00Z",
      data: undefined,
    });
    expect(row.data).toBeNull();
  });

  it("data JSON round-trips correctly", () => {
    const complexData = {
      nested: { deep: true },
      array: [1, 2, 3],
      message: "hello world",
    };
    repo.insert({
      runId: "run-1",
      type: "output",
      timestamp: "2026-01-01T00:00:00Z",
      data: complexData,
    });
    const events = repo.findByRunId("run-1");
    expect(events[0].data).toEqual(complexData);
  });

  it("findByRunId() returns empty array when no events exist", () => {
    const events = repo.findByRunId("nonexistent");
    expect(events).toEqual([]);
  });

  it("findByRunIdAndType() returns empty array when no matching events", () => {
    repo.insert({ runId: "run-1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: {} });
    const events = repo.findByRunIdAndType("run-1", "completed");
    expect(events).toEqual([]);
  });
});
