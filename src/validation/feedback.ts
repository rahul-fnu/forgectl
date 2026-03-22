import type { StepResult } from "./step.js";

const WORKFLOW_INSTRUCTIONS: Record<string, string> = {
  code: "Fix the code issues. Do NOT weaken linting rules or delete tests.",
  research: "Fix the report. Ensure sources are cited with URLs and claims are supported.",
  content: "Revise the content. Address the style and quality issues.",
  data: "Fix the data pipeline. Ensure output matches expected schema and no PII is present.",
  ops: "Fix the infrastructure code. Ensure it passes validation/dry-run.",
  general: "Fix the issues identified above.",
};

/**
 * Format validation failure into a clear error message for the agent.
 * Truncates long output to avoid blowing up the context window.
 */
export function formatFeedback(failedSteps: StepResult[], workflowName: string): string {
  const parts: string[] = [
    "VALIDATION FAILED. The following checks did not pass:\n",
  ];

  for (const { step, exitCode, stdout, stderr } of failedSteps) {
    parts.push(`--- ${step.name} (exit code ${exitCode}) ---`);
    parts.push(`Command: ${step.command}`);
    if (stdout.trim()) {
      parts.push(`STDOUT:\n${truncate(stdout, 3000)}`);
    }
    if (stderr.trim()) {
      parts.push(`STDERR:\n${truncate(stderr, 3000)}`);
    }
    parts.push("");
  }

  const instruction = WORKFLOW_INSTRUCTIONS[workflowName] || WORKFLOW_INSTRUCTIONS.general;
  parts.push(instruction);
  parts.push("\nFix the issues and the checks will run again.");

  return parts.join("\n");
}

/**
 * Format lint failure into structured feedback for the agent.
 * Lint errors are deterministic — the agent gets exact error output with no LLM review.
 */
export function formatLintFeedback(failedSteps: StepResult[]): string {
  const parts: string[] = [
    "LINT CHECK FAILED. Fix the following lint/type errors before proceeding:\n",
  ];

  for (const { step, exitCode, stdout, stderr } of failedSteps) {
    parts.push(`--- ${step.name} (exit code ${exitCode}) ---`);
    parts.push(`Command: ${step.command}`);
    if (stdout.trim()) {
      parts.push(`STDOUT:\n${truncate(stdout, 3000)}`);
    }
    if (stderr.trim()) {
      parts.push(`STDERR:\n${truncate(stderr, 3000)}`);
    }
    parts.push("");
  }

  parts.push("Fix the exact errors above. Do NOT weaken linting rules or disable checks.");
  parts.push("\nLint checks will run again after your fix.");

  return parts.join("\n");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + "\n\n... (truncated) ...\n\n" + text.slice(-half);
}
