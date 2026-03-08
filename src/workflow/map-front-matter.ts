import type { WorkflowFileConfig } from "./types.js";
import type { ForgectlConfig } from "../config/schema.js";

/**
 * Maps WORKFLOW.md front matter fields to the ForgectlConfig structure.
 *
 * Front matter uses user-friendly names (polling.interval_ms, concurrency.max_agents)
 * while ForgectlConfig uses internal names (orchestrator.poll_interval_ms,
 * orchestrator.max_concurrent_agents). This function bridges the two.
 *
 * Fields that already align (tracker, workspace, agent, validation) are passed through.
 */
export function mapFrontMatterToConfig(
  fm: WorkflowFileConfig,
): Partial<ForgectlConfig> {
  const result: Partial<ForgectlConfig> = {};

  // Map polling and concurrency to orchestrator config
  const orchestratorOverrides: Record<string, unknown> = {};
  if (fm.polling?.interval_ms !== undefined) {
    orchestratorOverrides.poll_interval_ms = fm.polling.interval_ms;
  }
  if (fm.concurrency?.max_agents !== undefined) {
    orchestratorOverrides.max_concurrent_agents = fm.concurrency.max_agents;
  }
  if (Object.keys(orchestratorOverrides).length > 0) {
    result.orchestrator = orchestratorOverrides as ForgectlConfig["orchestrator"];
  }

  // Pass through fields that align directly
  if (fm.tracker !== undefined) {
    result.tracker = fm.tracker as ForgectlConfig["tracker"];
  }
  if (fm.workspace !== undefined) {
    result.workspace = fm.workspace as ForgectlConfig["workspace"];
  }
  if (fm.agent !== undefined) {
    result.agent = fm.agent as ForgectlConfig["agent"];
  }
  if (fm.validation !== undefined) {
    (result as Record<string, unknown>).validation = fm.validation;
  }

  return result;
}
