import type { RunRepository } from "../storage/repositories/runs.js";
import type { ApprovalContext } from "./types.js";
import { emitRunEvent } from "../logging/events.js";

const PENDING_STATUSES = new Set(["pending_approval", "pending_output_approval"]);

function assertRunExists(runRepo: RunRepository, runId: string) {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  return run;
}

function assertPendingStatus(run: { id: string; status: string }) {
  if (!PENDING_STATUSES.has(run.status)) {
    throw new Error(
      `Cannot act on run ${run.id}: status is ${run.status}, expected pending_approval or pending_output_approval`,
    );
  }
}

/**
 * Approve a run that is pending approval.
 * - pending_approval -> running (pre-execution gate cleared)
 * - pending_output_approval -> completed (output accepted)
 */
export function approveRun(
  runRepo: RunRepository,
  runId: string,
): { previousStatus: string } {
  const run = assertRunExists(runRepo, runId);
  assertPendingStatus(run);

  const previousStatus = run.status;

  if (run.status === "pending_approval") {
    runRepo.updateStatus(runId, {
      status: "running",
      approvalAction: "approve",
    });
    emitRunEvent({
      runId,
      type: "approved",
      timestamp: new Date().toISOString(),
      data: { previousStatus },
    });
  } else {
    // pending_output_approval
    runRepo.updateStatus(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      approvalAction: "approve",
    });
    emitRunEvent({
      runId,
      type: "output_approved",
      timestamp: new Date().toISOString(),
      data: { previousStatus },
    });
  }

  return { previousStatus };
}

/**
 * Reject a run that is pending approval.
 * Transitions to "rejected" with an optional reason.
 */
export function rejectRun(
  runRepo: RunRepository,
  runId: string,
  reason?: string,
): void {
  const run = assertRunExists(runRepo, runId);
  assertPendingStatus(run);

  const eventType = run.status === "pending_approval" ? "rejected" : "output_rejected";

  runRepo.updateStatus(runId, {
    status: "rejected",
    error: reason,
    approvalAction: "reject",
  });

  emitRunEvent({
    runId,
    type: eventType,
    timestamp: new Date().toISOString(),
    data: { reason },
  });
}

/**
 * Request revision on a pending run.
 * Stores feedback as ApprovalContext and transitions back to "running"
 * so the agent can re-execute with the feedback.
 */
export function requestRevision(
  runRepo: RunRepository,
  runId: string,
  feedback: string,
): void {
  const run = assertRunExists(runRepo, runId);
  assertPendingStatus(run);

  const context: ApprovalContext = {
    action: "revision_requested",
    feedback,
    requestedAt: new Date().toISOString(),
  };

  runRepo.updateStatus(runId, {
    status: "running",
    approvalContext: context,
    approvalAction: "revision_requested",
  });

  emitRunEvent({
    runId,
    type: "revision_requested",
    timestamp: new Date().toISOString(),
    data: { feedback },
  });
}

/**
 * Transition a run into the pre-execution pending approval state.
 */
export function enterPendingApproval(
  runRepo: RunRepository,
  runId: string,
): void {
  const run = assertRunExists(runRepo, runId);
  runRepo.updateStatus(runId, { status: "pending_approval" });

  emitRunEvent({
    runId,
    type: "approval_required",
    timestamp: new Date().toISOString(),
    data: { previousStatus: run.status },
  });
}

/**
 * Transition a run into the post-execution pending output approval state.
 */
export function enterPendingOutputApproval(
  runRepo: RunRepository,
  runId: string,
): void {
  const run = assertRunExists(runRepo, runId);
  runRepo.updateStatus(runId, { status: "pending_output_approval" });

  emitRunEvent({
    runId,
    type: "output_approval_required",
    timestamp: new Date().toISOString(),
    data: { previousStatus: run.status },
  });
}
