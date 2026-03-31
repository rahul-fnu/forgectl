import type { RunRepository } from "../storage/repositories/runs.js";

export interface PauseContext {
  reason: string;
  phase: string;
  question?: string;
  serializedState?: unknown;
}

export interface ResumeResult {
  runId: string;
  pauseContext: PauseContext;
  humanInput: string;
}

/**
 * Pause a run into waiting_for_input state with context persistence.
 *
 * The run must be in "running" status. Stores the reason, phase, and
 * optional question/serialized state for the human-in-the-loop to act on.
 */
export function pauseRun(
  runRepo: RunRepository,
  runId: string,
  context: PauseContext,
): void {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "running") {
    throw new Error(
      `Cannot pause run ${runId}: status is ${run.status}, expected running`,
    );
  }
  runRepo.updateStatus(runId, {
    status: "waiting_for_input",
    pauseReason: context.reason,
    pauseContext: context,
  });
}

/**
 * Resume a paused run, transitioning it back to "running" and clearing
 * the pause context. Returns the stored pause context so the caller
 * can re-enter execution with the human's input.
 */
export function resumeRun(
  runRepo: RunRepository,
  runId: string,
  humanInput: string,
): ResumeResult {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "waiting_for_input") {
    throw new Error(
      `Run ${runId} is ${run.status}, not waiting_for_input`,
    );
  }
  const pauseContext = run.pauseContext as PauseContext;
  runRepo.updateStatus(runId, { status: "running" });
  runRepo.clearPauseContext(runId);
  return { runId, pauseContext, humanInput };
}
