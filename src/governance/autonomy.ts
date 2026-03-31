import type { RunPlan } from "../workflow/types.js";

export function needsPostApproval(_plan: RunPlan): boolean {
  return false;
}
