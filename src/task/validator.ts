import { globSync } from "node:fs";
import type { TaskSpec } from "./types.js";

interface ValidationIssue {
  field: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface ValidateOptions {
  repoRoot?: string;
}

export function validateTaskSpec(spec: TaskSpec, options?: ValidateOptions): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check acceptance criteria
  const hasRunCommands = spec.acceptance.some((a) => a.run && a.run.trim().length > 0);
  if (!hasRunCommands) {
    warnings.push({
      field: "acceptance",
      message: "No acceptance criteria have executable run commands",
    });
  }

  // Check for empty run commands
  for (let i = 0; i < spec.acceptance.length; i++) {
    const criterion = spec.acceptance[i];
    if (criterion.run !== undefined && criterion.run.trim().length === 0) {
      errors.push({
        field: `acceptance[${i}].run`,
        message: "Run command cannot be empty or whitespace",
      });
    }
  }

  // Warn about effort
  if (spec.effort.max_turns === undefined) {
    warnings.push({
      field: "effort.max_turns",
      message: "max_turns is not set; agent may run indefinitely",
    });
  }

  // Warn about deep decomposition (only for auto strategy)
  if (spec.decomposition.strategy === "auto" && spec.decomposition.max_depth !== undefined && spec.decomposition.max_depth > 3) {
    warnings.push({
      field: "decomposition.max_depth",
      message: `max_depth ${spec.decomposition.max_depth} may lead to excessive sub-task creation`,
    });
  }

  // Validate file patterns against repo if repoRoot provided
  if (options?.repoRoot) {
    for (const pattern of spec.context.files) {
      const matches = globSync(pattern, { cwd: options.repoRoot });
      if (matches.length === 0) {
        errors.push({
          field: "context.files",
          message: `Pattern "${pattern}" matches no files in ${options.repoRoot}`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
