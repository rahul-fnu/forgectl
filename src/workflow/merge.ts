import { deepMerge } from "../config/loader.js";
import type { ForgectlConfig } from "../config/schema.js";

/**
 * Merge workflow config with four-layer priority:
 * CLI flags > workflow front matter > forgectl.yaml > global defaults.
 */
export function mergeWorkflowConfig(
  defaults: ForgectlConfig,
  forgectlYaml: Partial<ForgectlConfig>,
  workflowFrontMatter?: Partial<ForgectlConfig>,
  cliFlags?: Partial<ForgectlConfig>,
): ForgectlConfig {
  let result = deepMerge(defaults, forgectlYaml);
  if (workflowFrontMatter) {
    result = deepMerge(result, workflowFrontMatter);
  }
  if (cliFlags) {
    result = deepMerge(result, cliFlags);
  }
  return result;
}
