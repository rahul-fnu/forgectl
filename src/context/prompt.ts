import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { RunPlan } from "../workflow/types.js";
import type { ContextResult } from "./builder.js";
import type { ReviewFindingRow } from "../storage/repositories/review-findings.js";
import { formatConventionsForContext } from "../kg/conventions.js";

const MAX_INLINE_CONTEXT_BYTES = 64 * 1024;

interface ContextArtifactSummary {
  name: string;
  type: "binary" | "large-text";
  size: number;
}

export interface PromptOptions {
  kgContext?: ContextResult;
  promotedFindings?: ReviewFindingRow[];
}

const FALLBACK_CONVENTIONS = `No project-specific conventions have been detected yet. Infer patterns from the existing code:
- Look at 2-3 existing files similar to what you're creating to understand the style.
- Match import ordering, error handling patterns, export style, and naming conventions.`;

export function buildPrompt(plan: RunPlan, kgContextOrOptions?: ContextResult | PromptOptions): string {
  let kgContext: ContextResult | undefined;
  let promotedFindings: ReviewFindingRow[] | undefined;

  if (kgContextOrOptions && "systemContext" in kgContextOrOptions) {
    kgContext = kgContextOrOptions;
  } else if (kgContextOrOptions) {
    const opts = kgContextOrOptions as PromptOptions;
    kgContext = opts.kgContext;
    promotedFindings = opts.promotedFindings;
  }

  const parts: string[] = [];

  // 1. Build the conventions block for {{conventions}} placeholder
  const conventionsBlock = buildConventionsBlock(kgContext, promotedFindings);

  // 2. System prompt with conventions injected
  const systemPrompt = plan.context.system || plan.workflow.system;
  if (systemPrompt.includes("{{conventions}}")) {
    parts.push(systemPrompt.replace("{{conventions}}", conventionsBlock));
  } else {
    parts.push(systemPrompt);
    // Append conventions after system prompt if no placeholder exists
    if (conventionsBlock !== FALLBACK_CONVENTIONS) {
      parts.push(`\n## Project conventions\n${conventionsBlock}\n`);
    }
  }

  // 3. Context files (text inlined, binary/large summarized)
  const artifacts: ContextArtifactSummary[] = [];
  for (const file of plan.context.files) {
    const absPath = resolve(file);
    if (!existsSync(absPath)) continue;

    try {
      const data = readFileSync(absPath);
      const classified = classifyContext(data);
      if (classified.type === "text") {
        parts.push(`\n--- Context: ${basename(file)} ---\n${classified.content}\n`);
      } else {
        artifacts.push({
          name: basename(file),
          type: classified.type,
          size: classified.size,
        });
      }
    } catch {
      artifacts.push({
        name: basename(file),
        type: "binary",
        size: 0,
      });
    }
  }

  if (artifacts.length > 0) {
    parts.push("\n--- Context Artifacts Manifest ---");
    parts.push("These artifacts were provided as files and were not inlined:");
    for (const artifact of artifacts) {
      parts.push(`- ${artifact.name} (${artifact.type}, ${artifact.size} bytes)`);
    }
    parts.push("Use artifact metadata and nearby text context when reasoning about these files.");
  }

  // 4. KG-derived structural context
  if (kgContext) {
    parts.push(`\n--- Structural Context (Knowledge Graph) ---`);
    parts.push(kgContext.systemContext);
    if (kgContext.taskContext) {
      parts.push(kgContext.taskContext);
    }
    parts.push(`--- End Structural Context ---\n`);
  }

  // 5. Available tools
  if (plan.workflow.tools.length > 0) {
    parts.push(`\n## Available tools\n${plan.workflow.tools.join(", ")}\n`);
  }

  // 6. The task
  parts.push(`\n## Task\n${plan.task}\n`);

  // 7. Validation instructions
  if (plan.validation.steps.length > 0) {
    const reproSteps = plan.validation.steps.filter((s) => s.before_fix === true);
    const verifySteps = plan.validation.steps.filter((s) => s.before_fix !== true);

    if (reproSteps.length > 0) {
      parts.push(`\n## Reproduce\nThese checks should FAIL before your fix (proving the bug exists):`);
      for (let i = 0; i < reproSteps.length; i++) {
        const step = reproSteps[i];
        parts.push(`${i + 1}. ${step.name}: \`${step.command}\` — ${step.description}`);
      }
    }

    parts.push(`\n## Verification\nThese checks must ALL pass when you are done:`);
    for (let i = 0; i < verifySteps.length; i++) {
      const step = verifySteps[i];
      parts.push(`${i + 1}. ${step.name}: \`${step.command}\` — ${step.description}`);
    }

    parts.push(`\nIf any check fails, you will receive the error output. Read it carefully, identify the root cause, and fix it. Do not retry the same fix.\n`);
  }

  // 8. Output instructions
  if (plan.output.mode === "files") {
    parts.push(`\nSave all output files to ${plan.output.path}\n`);
  }

  return parts.join("\n");
}

/**
 * Build the conventions block to replace {{conventions}} in the system prompt.
 * Merges KG-mined conventions and promoted review findings into a single section.
 */
function buildConventionsBlock(
  kgContext?: ContextResult,
  promotedFindings?: ReviewFindingRow[],
): string {
  const lines: string[] = [];

  // KG-mined conventions
  if (kgContext?.conventions && kgContext.conventions.length > 0) {
    const formatted = formatConventionsForContext(kgContext.conventions);
    if (formatted) {
      lines.push("This project follows these conventions (discovered from the codebase):");
      lines.push(formatted);
    }
  }

  // Promoted review findings
  if (promotedFindings && promotedFindings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Additional conventions from code review history:");
    for (const finding of promotedFindings) {
      const desc = finding.exampleComment ?? `${finding.category} in ${finding.module}`;
      lines.push(`- ${desc} (flagged ${finding.occurrenceCount} times)`);
    }
  }

  if (lines.length === 0) {
    return FALLBACK_CONVENTIONS;
  }

  return lines.join("\n");
}

function classifyContext(data: Buffer):
  | { type: "text"; size: number; content: string }
  | { type: "binary" | "large-text"; size: number } {
  const size = data.byteLength;
  const textLike = isTextLike(data);

  if (!textLike) {
    return { type: "binary", size };
  }
  if (size > MAX_INLINE_CONTEXT_BYTES) {
    return { type: "large-text", size };
  }

  return {
    type: "text",
    size,
    content: data.toString("utf-8"),
  };
}

function isTextLike(data: Buffer): boolean {
  if (data.byteLength === 0) return true;

  const sampleSize = Math.min(data.byteLength, 4096);
  let suspicious = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = data[i];
    if (byte === 0) return false;

    const isTabOrNewline = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    if (!isTabOrNewline && !isPrintableAscii) {
      suspicious += 1;
    }
  }

  return suspicious / sampleSize < 0.15;
}
