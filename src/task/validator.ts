import { readdirSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import type { TaskSpec, TaskValidationResult, TaskValidationError, TaskValidationWarning } from "./types.js";

interface ValidateOptions {
  repoRoot?: string;
}

/**
 * Validate a task spec beyond schema validation.
 * Checks file existence, acceptance criteria quality, effort bounds, etc.
 */
export function validateTaskSpec(spec: TaskSpec, options?: ValidateOptions): TaskValidationResult {
  const errors: TaskValidationError[] = [];
  const warnings: TaskValidationWarning[] = [];

  // Check file patterns against repo if repoRoot is provided
  if (options?.repoRoot) {
    validateFilePatterns(spec.context.files, options.repoRoot, errors);
  }

  // Check acceptance criteria quality
  validateAcceptanceCriteria(spec, errors, warnings);

  // Warn if max_turns is not set (unbounded effort)
  if (spec.effort.max_turns === undefined) {
    warnings.push({
      field: "effort.max_turns",
      message: "No max_turns set — agent effort is unbounded",
      suggestion: "Set max_turns to limit agent iterations (e.g. 50)",
    });
  }

  // Warn if auto decomposition with deep max_depth
  if (spec.decomposition.strategy === "auto" && spec.decomposition.max_depth !== undefined && spec.decomposition.max_depth > 3) {
    warnings.push({
      field: "decomposition.max_depth",
      message: `max_depth of ${spec.decomposition.max_depth} is likely too deep for auto decomposition`,
      suggestion: "Consider reducing max_depth to 3 or less",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateFilePatterns(patterns: string[], repoRoot: string, errors: TaskValidationError[]): void {
  for (const pattern of patterns) {
    // Skip patterns with glob characters — just check that the base dir exists
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      // Try to match against actual files in the repo
      try {
        const matcher = picomatch(pattern);
        const files = collectFiles(repoRoot, "", 3); // Limit depth to 3 for performance
        const matched = files.some((f) => matcher(f));
        if (!matched) {
          errors.push({
            field: "context.files",
            message: `No files match pattern "${pattern}" in repository`,
          });
        }
      } catch {
        errors.push({
          field: "context.files",
          message: `Invalid glob pattern: "${pattern}"`,
        });
      }
    }
  }
}

function collectFiles(dir: string, prefix: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        results.push(relative);
      } else if (entry.isDirectory()) {
        results.push(...collectFiles(join(dir, entry.name), relative, maxDepth - 1));
      }
    }
  } catch {
    // Directory unreadable — skip
  }
  return results;
}

function validateAcceptanceCriteria(
  spec: TaskSpec,
  errors: TaskValidationError[],
  warnings: TaskValidationWarning[],
): void {
  const hasRunCriteria = spec.acceptance.some((c) => c.run);

  if (!hasRunCriteria) {
    warnings.push({
      field: "acceptance",
      message: "No acceptance criteria have 'run' commands — no automated validation possible",
      suggestion: "Add at least one criterion with a 'run' command for automated checking",
    });
  }

  for (let i = 0; i < spec.acceptance.length; i++) {
    const criterion = spec.acceptance[i];

    // Check for empty run commands
    if (criterion.run !== undefined && criterion.run.trim() === "") {
      errors.push({
        field: `acceptance[${i}].run`,
        message: "Run command must not be empty",
      });
    }

    // Check for obvious shell injection patterns
    if (criterion.run && /[;&|`$]/.test(criterion.run) && !/\|\|/.test(criterion.run) && !/&&/.test(criterion.run)) {
      warnings.push({
        field: `acceptance[${i}].run`,
        message: `Run command contains shell metacharacters: "${criterion.run}"`,
        suggestion: "Ensure the command is safe and intentional",
      });
    }
  }
}
