import picomatch from "picomatch";
import type { AutoApproveRule, AutoApproveContext } from "./types.js";

/**
 * Evaluates auto-approve rules against a run context.
 *
 * Uses AND logic: all specified conditions must pass.
 * Returns true if no rules are specified (vacuous truth).
 *
 * - label: context.labels must include rules.label
 * - workflow_pattern: context.workflowName must match the picomatch glob
 * - max_cost: context.actualCost must be defined AND less than max_cost
 */
export function evaluateAutoApprove(
  rules: AutoApproveRule | undefined,
  context: AutoApproveContext,
): boolean {
  if (!rules) return true;

  // Check if the rules object has any conditions at all
  const hasLabel = rules.label !== undefined;
  const hasPattern = rules.workflow_pattern !== undefined;
  const hasCost = rules.max_cost !== undefined;

  if (!hasLabel && !hasPattern && !hasCost) return true;

  // AND logic: all specified conditions must pass
  if (hasLabel && !context.labels.includes(rules.label!)) {
    return false;
  }

  if (hasPattern && !picomatch.isMatch(context.workflowName, rules.workflow_pattern!)) {
    return false;
  }

  if (hasCost) {
    // If actualCost is undefined (pre-gate), we cannot verify cost -> fail
    if (context.actualCost === undefined) return false;
    // Cost must be strictly less than max_cost
    if (context.actualCost >= rules.max_cost!) return false;
  }

  return true;
}
