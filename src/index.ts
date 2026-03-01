import { Command } from "commander";
import { runCommand } from "./cli/run.js";
import { authCommand } from "./cli/auth.js";
import { initCommand } from "./cli/init.js";
import { workflowsCommand } from "./cli/workflows.js";

const program = new Command();

program
  .name("forgectl")
  .description("Run AI agents in isolated Docker containers for any workflow")
  .version("0.1.0");

// forgectl run
program
  .command("run")
  .description("Run a task synchronously")
  .requiredOption("-t, --task <string>", "Task prompt")
  .option("-w, --workflow <string>", "Workflow type")
  .option("-r, --repo <path>", "Repository path")
  .option("-i, --input <paths...>", "Input files/directories")
  .option("--context <paths...>", "Context files for agent prompt")
  .option("-a, --agent <string>", "Agent type: claude-code | codex")
  .option("-m, --model <string>", "Model override")
  .option("-c, --config <path>", "Config file path")
  .option("--review", "Enable review mode")
  .option("--no-review", "Disable review mode")
  .option("-o, --output-dir <path>", "Output directory for file mode")
  .option("--timeout <duration>", "Timeout override (e.g. 30m)")
  .option("--verbose", "Show full agent output")
  .option("--no-cleanup", "Leave container running after run")
  .option("--dry-run", "Show run plan without executing")
  .action(runCommand);

// forgectl auth
const auth = program
  .command("auth")
  .description("Manage BYOK credentials");

auth
  .command("add <provider>")
  .description("Add credentials (claude-code | codex)")
  .action(async (provider: string) => { await authCommand("add", provider); });

auth
  .command("list")
  .description("List configured credentials")
  .action(async () => { await authCommand("list"); });

auth
  .command("remove <provider>")
  .description("Remove credentials")
  .action(async (provider: string) => { await authCommand("remove", provider); });

// forgectl init
program
  .command("init")
  .description("Generate starter config")
  .option("--stack <string>", "Stack template: node|python|go|research|data|ops")
  .action(initCommand);

// forgectl workflows
const workflows = program
  .command("workflows")
  .description("Manage workflows");

workflows
  .command("list")
  .description("List available workflows")
  .action(() => { workflowsCommand("list"); });

workflows
  .command("show <name>")
  .description("Show workflow definition")
  .action((name: string) => { workflowsCommand("show", name); });

// Stub commands for later phases
program.command("submit").description("Submit task to daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented. Use `forgectl run` for synchronous execution.");
});
program.command("up").description("Start daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("down").description("Stop daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("status").description("Show status (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("logs").description("Show run logs (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});

program.parse();
