// Autonomy helpers - stub for TDD RED phase
import type { AutonomyLevel } from "./types.js";

export function needsPreApproval(_autonomy: AutonomyLevel): boolean {
  throw new Error("Not implemented");
}

export function needsPostApproval(_autonomy: AutonomyLevel): boolean {
  throw new Error("Not implemented");
}
