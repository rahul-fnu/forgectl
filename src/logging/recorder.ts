import { runEvents } from "./events.js";
import type { EventRepository } from "../storage/repositories/events.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import type { RunEvent } from "./events.js";

/**
 * EventRecorder subscribes to the runEvents EventEmitter and persists
 * each event to the database via EventRepository. Errors are swallowed
 * to avoid crashing the emitter.
 */
export class EventRecorder {
  private readonly eventRepo: EventRepository;
  private readonly snapshotRepo: SnapshotRepository;
  private readonly handler: (event: RunEvent) => void;

  constructor(eventRepo: EventRepository, snapshotRepo: SnapshotRepository) {
    this.eventRepo = eventRepo;
    this.snapshotRepo = snapshotRepo;

    this.handler = (event: RunEvent) => {
      try {
        this.eventRepo.insert({
          runId: event.runId,
          type: event.type,
          timestamp: event.timestamp,
          data: event.data,
        });
      } catch (err) {
        console.error("[EventRecorder] Failed to persist event:", err);
      }
    };

    runEvents.on("run", this.handler);
  }

  /**
   * Capture a state snapshot at a step boundary.
   */
  captureSnapshot(
    runId: string,
    stepName: string,
    state: Record<string, unknown>,
  ): void {
    this.snapshotRepo.insert({
      runId,
      stepName,
      timestamp: new Date().toISOString(),
      state,
    });
  }

  /**
   * Remove the listener so no more events are persisted.
   */
  close(): void {
    runEvents.removeListener("run", this.handler);
  }
}
