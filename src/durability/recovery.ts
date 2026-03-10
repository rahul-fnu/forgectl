import type { RunRepository } from "../storage/repositories/runs.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import { loadLatestCheckpoint } from "./checkpoint.js";

export interface RecoveryResult {
  runId: string;
  action: "marked_interrupted";
  reason: string;
}

/**
 * Recover interrupted runs on daemon startup.
 *
 * Finds all runs with status "running" (which must be leftovers from a
 * previous daemon instance that crashed) and marks them as "interrupted".
 *
 * v2.0 does not attempt container re-creation -- it only marks runs as
 * interrupted with a descriptive reason based on the last checkpoint.
 */
export function recoverInterruptedRuns(
  runRepo: RunRepository,
  snapshotRepo: SnapshotRepository,
): RecoveryResult[] {
  const running = runRepo.findByStatus("running");
  const results: RecoveryResult[] = [];

  for (const run of running) {
    const checkpoint = loadLatestCheckpoint(snapshotRepo, run.id);
    const reason = checkpoint
      ? `Interrupted after ${checkpoint.phase} phase. Container likely dead after daemon restart.`
      : "Daemon crashed before any checkpoint was saved";

    runRepo.updateStatus(run.id, {
      status: "interrupted",
      completedAt: new Date().toISOString(),
      error: reason,
    });

    results.push({ runId: run.id, action: "marked_interrupted", reason });
  }

  return results;
}
