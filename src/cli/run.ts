import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";

export async function runCommand(options: CLIOptions): Promise<void> {
  const config = loadConfig(options.config);
  const plan = resolveRunPlan(config, options);

  if (options.dryRun) {
    console.log(chalk.bold("\n📋 Run Plan (dry run)\n"));
    console.log(`  Run ID:     ${plan.runId}`);
    console.log(`  Task:       ${plan.task}`);
    console.log(`  Workflow:   ${plan.workflow.name}`);
    console.log(`  Agent:      ${plan.agent.type}${plan.agent.model ? ` (${plan.agent.model})` : ""}`);
    console.log(`  Image:      ${plan.container.image}`);
    console.log(`  Network:    ${plan.container.network.mode}`);
    console.log(`  Input:      ${plan.input.mode} → ${plan.input.mountPath}`);
    console.log(`  Output:     ${plan.output.mode}${plan.output.mode === "git" ? "" : ` → ${plan.output.hostDir}`}`);
    console.log(`  Validation: ${plan.validation.steps.length} steps`);
    for (const step of plan.validation.steps) {
      console.log(`    - ${step.name}: \`${step.command}\` (${step.retries} retries)`);
    }
    console.log(`  Review:     ${plan.orchestration.review.enabled ? "enabled" : "disabled"}`);
    console.log(`  Timeout:    ${plan.agent.timeout}ms`);
    console.log();
    return;
  }

  // Phase 3 will implement actual execution here
  console.log(chalk.yellow("\nAgent execution not yet implemented. Use --dry-run to see the resolved plan.\n"));
}
