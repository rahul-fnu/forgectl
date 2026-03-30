import { detectIssueCycles } from "../tracker/sub-issue-dag.js";
import type { ExecutionPlan, PlanValidationResult } from "./types.js";
import type { KGDatabase } from "../kg/storage.js";

/**
 * Validate an ExecutionPlan:
 * 1. Dependency graph is acyclic (reuses sub-issue-dag cycle detection)
 * 2. Basic structural validation
 * 3. Optional KG file existence checks
 */
export function validatePlan(
  plan: ExecutionPlan,
  kgDb?: KGDatabase,
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

  // Basic spec validation
  for (const task of plan.tasks) {
    const spec = task.spec;
    if (!spec.id) {
      errors.push(`Task "${task.id}" spec missing id`);
    }
    if (!spec.title) {
      errors.push(`Task "${task.id}" spec missing title`);
    }
    if (!spec.context?.files) {
      warnings.push(`Task "${task.id}" spec missing context.files`);
    }
  }

  // KG file existence checks
  if (kgDb) {
    const knownPaths = new Set(kgDb.getModulePaths());
    for (const task of plan.tasks) {
      for (const file of task.spec.context?.files ?? []) {
        // Skip glob patterns
        if (file.includes("*") || file.includes("?")) continue;
        if (!knownPaths.has(file)) {
          warnings.push(`Task "${task.id}": file "${file}" not found in knowledge graph`);
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
