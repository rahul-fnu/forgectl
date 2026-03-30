import { deepMerge } from "../config/loader.js";
import type { ForgectlConfig } from "../config/schema.js";

/**
 * Merge workflow config: global defaults + forgectl.yaml overrides.
 * Additional arguments are accepted for backward compatibility but
 * the merge is now 2-layer (defaults + yaml overlay).
 */
export function mergeWorkflowConfig(
  defaults: ForgectlConfig,
  forgectlYaml: Partial<ForgectlConfig>,
  _workflowFrontMatter?: Partial<ForgectlConfig>,
  _cliFlags?: Partial<ForgectlConfig>,
): ForgectlConfig {
  return deepMerge(defaults, forgectlYaml);
}
