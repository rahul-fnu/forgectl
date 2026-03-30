import type { RunPlan } from "../workflow/types.js";

export interface ReviewFindingRow {
  id: number;
  category: string;
  pattern: string;
  module: string;
  exampleComment: string;
  occurrences: number;
  promoted: number;
}

export interface HandoffEntry {
  nodeId: string;
  status: "completed" | "failed" | "skipped";
  filesChanged?: number;
  diffStat?: string;
  branch?: string;
  outputFiles?: string[];
}

const MAX_HANDOFF_LINES = 5;

/**
 * Build a concise handoff context block from completed upstream dependency results.
 * Returns at most MAX_HANDOFF_LINES lines summarizing previous work.
 */
export function buildHandoffContext(entries: HandoffEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= MAX_HANDOFF_LINES) break;

    if (entry.status !== "completed") continue;

    const parts: string[] = [`${entry.nodeId} merged`];
    if (entry.diffStat) {
      // diffStat is typically like "3 files changed, 50 insertions(+), 10 deletions(-)"
      parts.push(entry.diffStat.trim());
    } else if (entry.filesChanged !== undefined) {
      parts.push(`${entry.filesChanged} file(s) changed`);
    }
    if (entry.branch) {
      parts.push(`branch: ${entry.branch}`);
    }
    if (entry.outputFiles && entry.outputFiles.length > 0) {
      const shown = entry.outputFiles.slice(0, 3);
      const suffix = entry.outputFiles.length > 3 ? ` +${entry.outputFiles.length - 3} more` : "";
      parts.push(`files: ${shown.join(", ")}${suffix}`);
    }

    lines.push(`- ${parts.join("; ")}`);
  }

  if (lines.length === 0) return "";

  return `## Previous Work\n${lines.join("\n")}`;
}

export interface PromptOptions {
  promotedFindings?: ReviewFindingRow[];
  handoffContext?: string;
}

export function buildPrompt(plan: RunPlan, _options?: PromptOptions): string {
  const parts: string[] = [];

  if (_options?.handoffContext) {
    parts.push(_options.handoffContext);
  }

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
