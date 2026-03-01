import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { RunPlan } from "../workflow/types.js";

export function buildPrompt(plan: RunPlan): string {
  const parts: string[] = [];

  // 1. Workflow system prompt
  parts.push(plan.context.system || plan.workflow.system);

  // 2. Context files (contents inlined with filename headers)
  for (const file of plan.context.files) {
    const absPath = resolve(file);
    if (existsSync(absPath)) {
      const content = readFileSync(absPath, "utf-8");
      parts.push(`\n--- Context: ${basename(file)} ---\n${content}\n`);
    }
  }

  // 3. Available tools description
  if (plan.workflow.tools.length > 0) {
    parts.push(`\nAvailable tools in this container: ${plan.workflow.tools.join(", ")}\n`);
  }

  // 4. The task
  parts.push(`\n--- Task ---\n${plan.task}\n`);

  // 5. Validation instructions (so the agent knows what will be checked)
  if (plan.validation.steps.length > 0) {
    parts.push(`\nAfter you finish, these validation checks will run:`);
    for (const step of plan.validation.steps) {
      parts.push(`- ${step.name}: \`${step.command}\` — ${step.description}`);
    }
    parts.push(`\nIf any check fails, you'll receive the error output and must fix it.\n`);
  }

  // 6. Output instructions
  if (plan.output.mode === "files") {
    parts.push(`\nSave all output files to ${plan.output.path}\n`);
  }

  return parts.join("\n");
}
