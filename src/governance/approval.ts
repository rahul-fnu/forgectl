import type { RunRepository } from "../storage/repositories/runs.js";

export function approveRun(_runRepo: RunRepository, _runId: string): { previousStatus: string } {
  throw new Error("Not implemented");
}

export function rejectRun(_runRepo: RunRepository, _runId: string, _reason?: string): void {
  throw new Error("Not implemented");
}

export function requestRevision(_runRepo: RunRepository, _runId: string, _feedback: string): void {
  throw new Error("Not implemented");
}

export function enterPendingApproval(_runRepo: RunRepository, _runId: string): void {
  throw new Error("Not implemented");
}

export function enterPendingOutputApproval(_runRepo: RunRepository, _runId: string): void {
  throw new Error("Not implemented");
}
