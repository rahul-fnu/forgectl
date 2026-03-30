import chalk from "chalk";
import yaml from "js-yaml";
import { listWorkflows, getWorkflow } from "../workflow/resolver.js";

export function workflowsCommand(action: string, name?: string): void {
  if (action === "list") {
    const workflows = listWorkflows();
    console.log(chalk.bold("\nAvailable workflows:\n"));
    for (const w of workflows) {
      console.log(`  ${chalk.cyan(w.name.padEnd(12))} ${w.description}`);
    }
    console.log(`\nUse ${chalk.cyan("forgectl workflows show <name>")} to see full definition.\n`);
    return;
  }

  if (action === "show" && name) {
    const workflow = getWorkflow(name);
    console.log(chalk.bold(`\nWorkflow: ${workflow.name}\n`));
    console.log(yaml.dump(workflow, { lineWidth: 120, noRefs: true }));
    return;
  }
}
