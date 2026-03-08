import { deepMerge } from "../config/loader.js";
import type { ForgectlConfig } from "../config/schema.js";

/**
 * Merge workflow config from four sources with priority:
 * CLI flags > WORKFLOW.md front matter > forgectl.yaml > defaults
 *
 * Uses deepMerge in sequence so each layer overrides the previous.
 * Arrays are replaced (not merged) per deepMerge semantics.
 */
export function mergeWorkflowConfig(
  defaults: ForgectlConfig,
  forgectlYaml: Partial<ForgectlConfig>,
  workflowFrontMatter: Partial<ForgectlConfig>,
  cliFlags: Partial<ForgectlConfig>,
): ForgectlConfig {
  let result = defaults;
  result = deepMerge(result, forgectlYaml);
  result = deepMerge(result, workflowFrontMatter);
  result = deepMerge(result, cliFlags);
  return result;
}
