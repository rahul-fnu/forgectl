import type { KGDatabase } from "../kg/storage.js";
import { getModule } from "../kg/storage.js";
import { validateTaskSpec } from "../task/validator.js";
import { detectIssueCycles } from "../tracker/sub-issue-dag.js";
import type { ExecutionPlan, PlanValidationResult } from "./types.js";

/**
 * Validate an ExecutionPlan:
 * 1. Referenced files exist in the KG
 * 2. Dependency graph is acyclic (reuses sub-issue-dag cycle detection)
 * 3. TaskSpecs pass validation
 */
export function validatePlan(
  plan: ExecutionPlan,
  kgDb?: KGDatabase,
  repoRoot?: string,
): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.tasks.length === 0) {
    errors.push("Plan has no tasks");
    return { valid: false, errors, warnings };
  }

  // Check for duplicate task IDs
  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    taskIds.add(task.id);
  }

  // Validate dependency graph is acyclic using sub-issue-dag cycle detection
  const dagNodes = plan.tasks.map(t => ({
    id: t.id,
    blocked_by: t.dependsOn,
  }));
  const cycleError = detectIssueCycles(dagNodes);
  if (cycleError) {
    errors.push(`Dependency cycle: ${cycleError}`);
  }

  // Validate dependency references exist
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Validate each TaskSpec
  for (const task of plan.tasks) {
    const result = validateTaskSpec(task.spec, { repoRoot });
    for (const err of result.errors) {
      errors.push(`Task "${task.id}" spec error: ${err.field} — ${err.message}`);
    }
    for (const warn of result.warnings) {
      warnings.push(`Task "${task.id}" spec warning: ${warn.field} — ${warn.message}`);
    }
  }

  // Check referenced files exist in KG (if KG is available)
  if (kgDb) {
    for (const task of plan.tasks) {
      for (const filePath of task.spec.context.files) {
        // Skip glob patterns — only check literal paths
        if (filePath.includes("*") || filePath.includes("?") || filePath.includes("{")) {
          continue;
        }
        const mod = getModule(kgDb, filePath);
        if (!mod) {
          warnings.push(`Task "${task.id}": file "${filePath}" not found in knowledge graph`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
