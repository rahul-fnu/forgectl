import type { SnapshotRepository } from "../storage/repositories/snapshots.js";

export interface CheckpointState {
  phase: "prepare" | "execute" | "validate" | "output";
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Save a checkpoint snapshot at a phase boundary.
 *
 * The stepName is stored as `after:{phase}` so it's clear the phase completed.
 */
export function saveCheckpoint(
  snapshotRepo: SnapshotRepository,
  runId: string,
  phase: CheckpointState["phase"],
  metadata?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  snapshotRepo.insert({
    runId,
    stepName: `after:${phase}`,
    timestamp,
    state: { phase, timestamp, ...metadata } satisfies CheckpointState,
  });
}

/**
 * Load the latest checkpoint for a run, parsed as CheckpointState.
 *
 * Returns null if no checkpoint exists.
 */
export function loadLatestCheckpoint(
  snapshotRepo: SnapshotRepository,
  runId: string,
): CheckpointState | null {
  const snap = snapshotRepo.latest(runId);
  return snap ? (snap.state as CheckpointState) : null;
}
