import type { WorkflowDefinition } from "./types.js";
import { codeWorkflow } from "./builtins/code.js";
import { researchWorkflow } from "./builtins/research.js";
import { contentWorkflow } from "./builtins/content.js";
import { dataWorkflow } from "./builtins/data.js";
import { opsWorkflow } from "./builtins/ops.js";
import { generalWorkflow } from "./builtins/general.js";
import { browserResearchWorkflow } from "./builtins/browser-research.js";
import { codePythonWorkflow } from "./builtins/code-python.js";
import { codeGoWorkflow } from "./builtins/code-go.js";
import { codeRustWorkflow } from "./builtins/code-rust.js";
import { loadCustomWorkflows } from "./custom.js";
import { deepMerge } from "../config/loader.js";

const BUILTINS: Record<string, WorkflowDefinition> = {
  code: codeWorkflow,
  research: researchWorkflow,
  content: contentWorkflow,
  data: dataWorkflow,
  ops: opsWorkflow,
  general: generalWorkflow,
  "browser-research": browserResearchWorkflow,
  "code-python": codePythonWorkflow,
  "code-go": codeGoWorkflow,
  "code-rust": codeRustWorkflow,
};

/**
 * Get a workflow by name. Checks built-ins first, then custom workflows.
 * Custom workflows with `extends` inherit from the base and override.
 */
export function getWorkflow(name: string, projectDir?: string): WorkflowDefinition {
  // Check built-ins
  if (BUILTINS[name]) return BUILTINS[name];

  // Check custom workflows
  const customs = loadCustomWorkflows(projectDir);
  const custom = customs[name];
  if (!custom) {
    throw new Error(
      `Unknown workflow: "${name}". Available: ${listWorkflowNames(projectDir).join(", ")}`
    );
  }

  // If custom extends a built-in, merge
  if (custom.extends && BUILTINS[custom.extends]) {
    return deepMerge(BUILTINS[custom.extends], custom) as WorkflowDefinition;
  }

  return custom;
}

export function listWorkflowNames(projectDir?: string): string[] {
  const customNames = Object.keys(loadCustomWorkflows(projectDir));
  return [...Object.keys(BUILTINS), ...customNames];
}

export function listWorkflows(projectDir?: string): WorkflowDefinition[] {
  const customs = loadCustomWorkflows(projectDir);
  return [...Object.values(BUILTINS), ...Object.values(customs)];
}
