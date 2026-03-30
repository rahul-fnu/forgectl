import type { RunPlan } from "../workflow/types.js";

export function evaluateAutoApprove(_plan: RunPlan): boolean {
  return true;
}
