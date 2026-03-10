import { EventEmitter } from "node:events";

export interface RunEvent {
  runId: string;
  type: "started" | "phase" | "validation" | "retry" | "output" | "completed" | "failed" | "dispatch" | "reconcile" | "stall" | "orch_retry" | "prompt" | "agent_response" | "validation_step" | "cost" | "snapshot" | "approval_required" | "approved" | "rejected" | "revision_requested" | "output_approval_required" | "output_approved" | "output_rejected";
  timestamp: string;
  data: Record<string, unknown>;
}

export const runEvents = new EventEmitter();

export function emitRunEvent(event: RunEvent): void {
  runEvents.emit("run", event);
  runEvents.emit(`run:${event.runId}`, event);
}
