import type { AutonomyLevel } from "./types.js";

/**
 * Returns true if the autonomy level requires pre-execution approval.
 * Semi and supervised modes need approval before the agent runs.
 */
export function needsPreApproval(autonomy: AutonomyLevel): boolean {
  return autonomy === "semi" || autonomy === "supervised";
}

/**
 * Returns true if the autonomy level requires post-execution approval.
 * Interactive and supervised modes need approval after the agent produces output.
 */
export function needsPostApproval(autonomy: AutonomyLevel): boolean {
  return autonomy === "interactive" || autonomy === "supervised";
}
