import type { SnapshotRepository } from "../storage/repositories/snapshots.js";

export interface CheckpointState {
  phase: "prepare" | "execute" | "validate" | "output";
  timestamp: string;
  workspacePath?: string;
  branchName?: string;
  issueId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Save a checkpoint snapshot at a phase boundary.
 *
 * The stepName is stored as `after:{phase}` so it's clear the phase completed.
 */
export interface SaveCheckpointOptions {
  workspacePath?: string;
  branchName?: string;
  issueId?: string;
  metadata?: Record<string, unknown>;
}

export function saveCheckpoint(
  snapshotRepo: SnapshotRepository,
  runId: string,
  phase: CheckpointState["phase"],
  metadataOrOptions?: Record<string, unknown> | SaveCheckpointOptions,
): void {
  const timestamp = new Date().toISOString();

  // Support both old-style metadata and new-style options
  let workspacePath: string | undefined;
  let branchName: string | undefined;
  let issueId: string | undefined;
  let metadata: Record<string, unknown> | undefined;

  if (metadataOrOptions && ("workspacePath" in metadataOrOptions || "branchName" in metadataOrOptions || "issueId" in metadataOrOptions)) {
    const opts = metadataOrOptions as SaveCheckpointOptions;
    workspacePath = opts.workspacePath;
    branchName = opts.branchName;
    issueId = opts.issueId;
    metadata = opts.metadata;
  } else {
    metadata = metadataOrOptions as Record<string, unknown> | undefined;
  }

  const state: CheckpointState = {
    phase,
    timestamp,
    ...(workspacePath ? { workspacePath } : {}),
    ...(branchName ? { branchName } : {}),
    ...(issueId ? { issueId } : {}),
    ...metadata,
  };

  snapshotRepo.insert({
    runId,
    stepName: `after:${phase}`,
    timestamp,
    state,
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
