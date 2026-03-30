import chalk from "chalk";

export function workflowsCommand(action: string, _name?: string): void {
  if (action === "list") {
    console.log(chalk.bold("\nWorkflow registry has been removed.\n"));
    console.log("  forgectl now auto-detects the stack from workspace markers.");
    console.log("  Supported stacks: Node/TS (default), Python, Go, Rust.\n");
    return;
  }

  if (action === "show") {
    console.log(chalk.bold("\nWorkflow registry has been removed.\n"));
    console.log("  forgectl now auto-detects the stack from workspace markers.\n");
    return;
  }
}
