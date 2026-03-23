import type { RunRepository } from "../storage/repositories/runs.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import { loadLatestCheckpoint } from "./checkpoint.js";

export interface RecoveryResult {
  runId: string;
  action: "marked_interrupted" | "requeued";
  reason: string;
}

/**
 * Phases that are safe to resume from — the agent hasn't produced final output yet.
 * "prepare" and "execute" phases can be restarted because agent invocations are
 * individual CLI calls (no persistent sessions to recover).
 */
const RESUMABLE_PHASES = new Set(["prepare", "execute"]);

/**
 * Recover interrupted runs on daemon startup.
 *
 * Finds all runs with status "running" (leftovers from a previous daemon
 * that crashed) and either re-queues them or marks them as interrupted:
 *
 * - Runs with no checkpoint or checkpoint in a resumable phase (prepare/execute)
 *   are re-queued for execution.
 * - Runs past the execute phase (validate/output) are marked interrupted
 *   because partial output may already exist.
 */
export function recoverInterruptedRuns(
  runRepo: RunRepository,
  snapshotRepo: SnapshotRepository,
): RecoveryResult[] {
  const running = runRepo.findByStatus("running");
  const results: RecoveryResult[] = [];

  for (const run of running) {
    const checkpoint = loadLatestCheckpoint(snapshotRepo, run.id);

    if (!checkpoint || RESUMABLE_PHASES.has(checkpoint.phase)) {
      // Safe to re-queue: no output has been produced yet
      const reason = checkpoint
        ? `Re-queued after crash (was in ${checkpoint.phase} phase)`
        : "Re-queued after crash (no checkpoint — run had not started execution)";

      runRepo.updateStatus(run.id, {
        status: "queued",
        error: undefined,
      });

      results.push({ runId: run.id, action: "requeued", reason });
    } else {
      // Past execute phase — mark interrupted to avoid duplicate output
      const reason = `Interrupted after ${checkpoint.phase} phase — partial output may exist, manual review needed`;

      runRepo.updateStatus(run.id, {
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: reason,
      });

      results.push({ runId: run.id, action: "marked_interrupted", reason });
    }
  }

  return results;
}
