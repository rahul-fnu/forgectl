import type { RunPlan } from "../workflow/types.js";
import type { ReviewFindingRow } from "../storage/repositories/review-findings.js";

export interface PromptOptions {
  promotedFindings?: ReviewFindingRow[];
}

export function buildPrompt(plan: RunPlan, _options?: PromptOptions): string {
  const parts: string[] = [];

  parts.push(`## Task\n${plan.task}`);

  if (plan.validation.steps.length > 0) {
    const reproSteps = plan.validation.steps.filter((s) => s.before_fix === true);
    const verifySteps = plan.validation.steps.filter((s) => s.before_fix !== true);

    if (reproSteps.length > 0) {
      parts.push(`## Reproduce\nThese checks should FAIL before your fix:`);
      for (const step of reproSteps) {
        parts.push(`- ${step.name}: \`${step.command}\``);
      }
    }

    if (verifySteps.length > 0) {
      parts.push(`## Verification\nThese checks must ALL pass when you are done:`);
      for (const step of verifySteps) {
        parts.push(`- ${step.name}: \`${step.command}\``);
      }
    }
  }

  if (plan.output.mode === "files") {
    parts.push(`Save all output files to ${plan.output.path}`);
  }

  return parts.join("\n\n");
}
