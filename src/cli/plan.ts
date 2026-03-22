import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import chalk from "chalk";
import {
  generatePlanPrompt,
  parsePlanResponse,
  validateExecutionPlan,
} from "../planner/index.js";
import type { ExecutionPlan } from "../planner/types.js";

export async function planCommand(
  goalOrFile: string,
  options: {
    db?: string;
    output?: string;
    validate?: boolean;
  },
): Promise<void> {
  const repoRoot = process.cwd();

  console.log(chalk.bold("Generating execution plan...\n"));

  // Build the planning prompt with KG context
  const { prompt, contextSummary } = await generatePlanPrompt(goalOrFile, {
    kgDbPath: options.db,
    repoRoot,
  });

  console.log(chalk.gray(`Context: ${contextSummary}`));
  console.log(chalk.gray(`Prompt length: ${prompt.length} chars\n`));

  // Output the prompt for the user to pipe to Claude Code
  // In production this would be invoked via the agent system,
  // but the planner runs as a Claude Code invocation with the same execution model.
  console.log(chalk.bold("Planning prompt ready."));
  console.log(chalk.gray("Run with: forgectl run -t \"$(cat plan-prompt.txt)\""));
  console.log(chalk.gray("Or pipe directly to claude -p\n"));

  // Write prompt to file for easy piping
  const promptFile = resolve(repoRoot, "plan-prompt.txt");
  writeFileSync(promptFile, prompt);
  console.log(chalk.green(`Prompt written to: plan-prompt.txt`));

  // If --output is specified, also write the prompt there
  if (options.output) {
    const outPath = resolve(options.output);
    writeFileSync(outPath, prompt);
    console.log(chalk.green(`Prompt also written to: ${outPath}`));
  }

  // If stdin has data (piped response), parse and validate it
  if (options.validate !== false) {
    console.log(chalk.gray("\nTo validate a plan response, pipe it to:"));
    console.log(chalk.gray("  echo '<json>' | forgectl plan --validate-response -"));
  }
}

export async function planValidateResponseCommand(
  responseFile: string,
  options: { db?: string },
): Promise<void> {
  const repoRoot = process.cwd();

  let responseText: string;
  if (responseFile === "-") {
    // Read from stdin
    const { readFileSync } = await import("node:fs");
    responseText = readFileSync("/dev/stdin", "utf-8");
  } else {
    const { readFileSync } = await import("node:fs");
    responseText = readFileSync(resolve(responseFile), "utf-8");
  }

  let plan: ExecutionPlan;
  try {
    plan = parsePlanResponse(responseText);
    console.log(chalk.green("Parsed ExecutionPlan successfully.\n"));
  } catch (err) {
    console.error(chalk.red(`Failed to parse plan: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  printPlan(plan);

  const validation = validateExecutionPlan(plan, {
    kgDbPath: options.db,
    repoRoot,
  });

  if (validation.errors.length > 0) {
    console.log(chalk.red("\nValidation errors:"));
    for (const err of validation.errors) {
      console.log(chalk.red(`  - ${err}`));
    }
  }

  if (validation.warnings.length > 0) {
    console.log(chalk.yellow("\nValidation warnings:"));
    for (const warn of validation.warnings) {
      console.log(chalk.yellow(`  - ${warn}`));
    }
  }

  if (validation.valid) {
    console.log(chalk.green("\nPlan is valid."));
  } else {
    console.log(chalk.red("\nPlan has errors — fix and re-validate."));
    process.exit(1);
  }
}

function printPlan(plan: ExecutionPlan): void {
  console.log(chalk.bold.cyan(`Execution Plan`));
  console.log(chalk.gray(`Risk: ${plan.riskLevel} | Estimated turns: ${plan.estimatedTurns}`));
  console.log(`\n${plan.rationale}\n`);

  console.log(chalk.bold(`Tasks (${plan.tasks.length}):\n`));
  for (const task of plan.tasks) {
    const deps = task.dependsOn.length > 0
      ? chalk.gray(` (depends on: ${task.dependsOn.join(", ")})`)
      : "";
    console.log(`  ${chalk.bold(task.id)} — ${task.title}${deps}`);
    console.log(`    Turns: ${task.estimatedTurns} | Files: ${task.spec.context.files.join(", ")}`);
    if (task.riskNotes) {
      console.log(chalk.yellow(`    Risk: ${task.riskNotes}`));
    }
    if (task.spec.acceptance.length > 0) {
      for (const a of task.spec.acceptance) {
        if (a.run) console.log(chalk.green(`    check: ${a.run}`));
      }
    }
    console.log();
  }
}
