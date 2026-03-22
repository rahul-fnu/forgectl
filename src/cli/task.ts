import { writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import chalk from "chalk";
import { loadTaskSpec, findTaskSpecs, validateTaskSpec, scaffoldTaskSpec } from "../task/index.js";

export async function taskNewCommand(options: {
  id: string;
  title: string;
  files?: string[];
}): Promise<void> {
  const yamlContent = scaffoldTaskSpec({
    id: options.id,
    title: options.title,
    files: options.files,
  });

  const fileName = `${options.id}.task.yaml`;
  const filePath = resolve(process.cwd(), fileName);

  if (existsSync(filePath)) {
    console.error(chalk.red(`File already exists: ${filePath}`));
    process.exit(1);
  }

  writeFileSync(filePath, yamlContent);
  console.log(chalk.green(`Created task spec: ${fileName}`));
  console.log(`Edit the file to fill in TODO sections.`);
}

export async function taskValidateCommand(file: string): Promise<void> {
  const filePath = resolve(file);

  try {
    const spec = loadTaskSpec(filePath);
    const result = validateTaskSpec(spec, { repoRoot: process.cwd() });

    if (result.valid && result.warnings.length === 0) {
      console.log(chalk.green(`Valid: ${file}`));
      return;
    }

    if (result.errors.length > 0) {
      console.log(chalk.red(`Errors in ${file}:`));
      for (const error of result.errors) {
        console.log(chalk.red(`  - ${error.field}: ${error.message}`));
      }
    }

    if (result.warnings.length > 0) {
      console.log(chalk.yellow(`Warnings in ${file}:`));
      for (const warning of result.warnings) {
        console.log(chalk.yellow(`  - ${warning.field}: ${warning.message}`));
        if (warning.suggestion) {
          console.log(chalk.gray(`    Suggestion: ${warning.suggestion}`));
        }
      }
    }

    if (!result.valid) {
      process.exit(1);
    }
  } catch (err) {
    console.error(chalk.red(`Failed to validate ${file}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function taskShowCommand(file: string): Promise<void> {
  const filePath = resolve(file);

  try {
    const spec = loadTaskSpec(filePath);

    console.log(chalk.bold.cyan(`Task: ${spec.title}`));
    console.log(chalk.gray(`ID: ${spec.id}`));
    if (spec.description) {
      console.log(`\n${spec.description}`);
    }

    console.log(chalk.bold("\nContext Files:"));
    for (const f of spec.context.files) {
      console.log(`  ${f}`);
    }

    if (spec.context.docs && spec.context.docs.length > 0) {
      console.log(chalk.bold("\nDocs:"));
      for (const doc of spec.context.docs) {
        console.log(`  ${doc}`);
      }
    }

    if (spec.constraints.length > 0) {
      console.log(chalk.bold("\nConstraints:"));
      for (const c of spec.constraints) {
        console.log(`  - ${c}`);
      }
    }

    console.log(chalk.bold("\nAcceptance Criteria:"));
    for (const a of spec.acceptance) {
      if (a.run) {
        console.log(`  ${chalk.green("run:")} ${a.run}`);
      }
      if (a.assert) {
        console.log(`  ${chalk.blue("assert:")} ${a.assert}`);
      }
      if (a.description) {
        console.log(`  ${chalk.gray(a.description)}`);
      }
    }

    console.log(chalk.bold("\nDecomposition:"));
    console.log(`  Strategy: ${spec.decomposition.strategy}`);
    if (spec.decomposition.max_depth !== undefined) {
      console.log(`  Max depth: ${spec.decomposition.max_depth}`);
    }

    console.log(chalk.bold("\nEffort:"));
    if (spec.effort.max_turns !== undefined) console.log(`  Max turns: ${spec.effort.max_turns}`);
    if (spec.effort.max_review_rounds !== undefined) console.log(`  Max review rounds: ${spec.effort.max_review_rounds}`);
    if (spec.effort.timeout) console.log(`  Timeout: ${spec.effort.timeout}`);
  } catch (err) {
    console.error(chalk.red(`Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function taskListCommand(dir?: string): Promise<void> {
  const searchDir = resolve(dir || process.cwd());

  const files = findTaskSpecs(searchDir);

  if (files.length === 0) {
    console.log(chalk.gray("No task specs found (*.task.yaml, *.task.yml)"));
    return;
  }

  console.log(chalk.bold(`Task specs in ${searchDir}:\n`));
  console.log(`${"ID".padEnd(30)} ${"Title".padEnd(50)} File`);
  console.log(`${"─".repeat(30)} ${"─".repeat(50)} ${"─".repeat(30)}`);

  for (const file of files) {
    try {
      const spec = loadTaskSpec(file);
      const relPath = relative(searchDir, file);
      console.log(`${spec.id.padEnd(30)} ${spec.title.slice(0, 50).padEnd(50)} ${relPath}`);
    } catch {
      const relPath = relative(searchDir, file);
      console.log(`${chalk.red("(invalid)".padEnd(30))} ${chalk.red("Parse error".padEnd(50))} ${relPath}`);
    }
  }
}
