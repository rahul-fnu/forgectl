import chalk from "chalk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * CLI handler: inspect a run's audit trail from run log files.
 */
export async function inspectCommand(runId: string): Promise<void> {
  const logDir = join(homedir(), ".forgectl", "logs");
  const logPath = findRunLog(logDir, runId);

  if (!logPath) {
    console.error(chalk.red(`Run log not found for: ${runId}`));
    console.log(chalk.gray(`Looked in: ${logDir}`));
    process.exit(1);
  }

  const log = JSON.parse(readFileSync(logPath, "utf-8"));

  console.log(chalk.bold(`\nRun: ${log.runId}`));
  console.log(`Task: ${log.task}`);
  console.log(`Workflow: ${log.workflow ?? "N/A"}`);
  console.log(`Agent: ${log.agent ?? "N/A"}`);
  console.log(`Status: ${log.status}`);
  if (log.durationMs) {
    const secs = Math.floor(log.durationMs / 1000);
    console.log(`Duration: ${Math.floor(secs / 60)}m ${secs % 60}s`);
  }

  if (log.validation) {
    console.log(chalk.bold("\nValidation:"));
    console.log(`  Attempts: ${log.validation.attempts}`);
    if (log.validation.steps) {
      for (const step of log.validation.steps) {
        const icon = step.passed ? chalk.green("✔") : chalk.red("✗");
        console.log(`  ${icon} ${step.name} (${step.attempts} attempt(s))`);
      }
    }
  }

  if (log.output) {
    console.log(chalk.bold("\nOutput:"));
    console.log(`  Mode: ${log.output.mode}`);
    if (log.output.branch) console.log(`  Branch: ${log.output.branch}`);
  }

  if (log.entries && log.entries.length > 0) {
    console.log(chalk.bold("\nLog Entries:"));
    for (const entry of log.entries.slice(0, 50)) {
      const level = entry.level === "error" ? chalk.red(entry.level) : chalk.gray(entry.level);
      console.log(`  ${level} [${entry.category}] ${entry.message}`);
    }
    if (log.entries.length > 50) {
      console.log(chalk.gray(`  ... and ${log.entries.length - 50} more entries`));
    }
  }

  console.log("");
}

/**
 * CLI handler: print just the run summary for a given run ID.
 */
export async function summaryCommand(runId: string): Promise<void> {
  const logDir = join(homedir(), ".forgectl", "logs");
  const logPath = findRunLog(logDir, runId);

  if (!logPath) {
    console.error(chalk.red(`Run log not found for: ${runId}`));
    process.exit(1);
  }

  const log = JSON.parse(readFileSync(logPath, "utf-8"));

  console.log(chalk.bold(`\nRun Summary: ${log.runId}`));
  console.log(`  Status: ${log.status}`);
  console.log(`  Workflow: ${log.workflow ?? "N/A"}`);
  if (log.durationMs) {
    const secs = Math.floor(log.durationMs / 1000);
    console.log(`  Duration: ${Math.floor(secs / 60)}m ${secs % 60}s`);
  }
  console.log("");
}

function findRunLog(logDir: string, runId: string): string | null {
  if (!existsSync(logDir)) return null;
  const files = readdirSync(logDir).filter(f => f.endsWith(".json"));
  for (const file of files) {
    if (file.includes(runId)) {
      return join(logDir, file);
    }
  }
  return null;
}
