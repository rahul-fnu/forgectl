import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createEventRepository, type EventRepository } from "../../src/storage/repositories/events.js";
import { createSnapshotRepository, type SnapshotRepository } from "../../src/storage/repositories/snapshots.js";
import { EventRecorder } from "../../src/logging/recorder.js";
import { emitRunEvent, runEvents } from "../../src/logging/events.js";

describe("logging/recorder", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let eventRepo: EventRepository;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-recorder-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    eventRepo = createEventRepository(db);
    snapshotRepo = createSnapshotRepository(db);
    // Remove all listeners to isolate tests
    runEvents.removeAllListeners();
  });

  afterEach(() => {
    runEvents.removeAllListeners();
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("subscribes to runEvents and persists emitted events to DB", () => {
    const recorder = new EventRecorder(eventRepo, snapshotRepo);

    emitRunEvent({
      runId: "run-1",
      type: "started",
      timestamp: "2026-01-01T00:00:00Z",
      data: { agent: "claude" },
    });

    const events = eventRepo.findByRunId("run-1");
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe("run-1");
    expect(events[0].type).toBe("started");
    expect(events[0].data).toEqual({ agent: "claude" });

    recorder.close();
  });

  it("close() removes the listener so no more events are persisted", () => {
    const recorder = new EventRecorder(eventRepo, snapshotRepo);

    emitRunEvent({
      runId: "run-1",
      type: "started",
      timestamp: "2026-01-01T00:00:00Z",
      data: {},
    });
    expect(eventRepo.findByRunId("run-1")).toHaveLength(1);

    recorder.close();

    emitRunEvent({
      runId: "run-1",
      type: "completed",
      timestamp: "2026-01-01T00:01:00Z",
      data: {},
    });
    // Should still be 1 since recorder was closed
    expect(eventRepo.findByRunId("run-1")).toHaveLength(1);
  });

  it("captureSnapshot persists a snapshot via snapshotRepo", () => {
    const recorder = new EventRecorder(eventRepo, snapshotRepo);

    recorder.captureSnapshot("run-1", "build", { status: "running", step: 1 });

    const snapshots = snapshotRepo.findByRunId("run-1");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].runId).toBe("run-1");
    expect(snapshots[0].stepName).toBe("build");
    expect(snapshots[0].state).toEqual({ status: "running", step: 1 });

    recorder.close();
  });

  it("swallows repo.insert errors without crashing the emitter", () => {
    const brokenRepo: EventRepository = {
      insert: () => {
        throw new Error("DB write failed");
      },
      findByRunId: () => [],
      findByRunIdAndType: () => [],
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recorder = new EventRecorder(brokenRepo, snapshotRepo);

    // This should NOT throw
    expect(() => {
      emitRunEvent({
        runId: "run-1",
        type: "started",
        timestamp: "2026-01-01T00:00:00Z",
        data: {},
      });
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    recorder.close();
  });

  it("works with new event types (prompt, agent_response, etc.)", () => {
    const recorder = new EventRecorder(eventRepo, snapshotRepo);

    emitRunEvent({
      runId: "run-1",
      type: "prompt",
      timestamp: "2026-01-01T00:00:00Z",
      data: { content: "build something" },
    });

    emitRunEvent({
      runId: "run-1",
      type: "agent_response",
      timestamp: "2026-01-01T00:01:00Z",
      data: { tokens: 500 },
    });

    const events = eventRepo.findByRunId("run-1");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("prompt");
    expect(events[1].type).toBe("agent_response");

    recorder.close();
  });

  it("persists multiple events in order", () => {
    const recorder = new EventRecorder(eventRepo, snapshotRepo);

    emitRunEvent({ runId: "run-1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: {} });
    emitRunEvent({ runId: "run-1", type: "validation", timestamp: "2026-01-01T00:01:00Z", data: { step: 1 } });
    emitRunEvent({ runId: "run-1", type: "completed", timestamp: "2026-01-01T00:02:00Z", data: {} });

    const events = eventRepo.findByRunId("run-1");
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(["started", "validation", "completed"]);

    recorder.close();
  });
});
