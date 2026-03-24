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

  // 1. Workflow system prompt
  parts.push(plan.context.system || plan.workflow.system);

  // 2. Context files (text inlined, binary/large summarized)
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

  // 2b. KG-derived structural context
  if (kgContext) {
    parts.push(`\n--- Structural Context (Knowledge Graph) ---`);
    parts.push(kgContext.systemContext);
    if (kgContext.taskContext) {
      parts.push(kgContext.taskContext);
    }
    parts.push(`--- End Structural Context ---\n`);
  }

  // 2c. Mined conventions from KG
  if (kgContext?.conventions && kgContext.conventions.length > 0) {
    const conventionSection = formatConventionsForContext(kgContext.conventions);
    if (conventionSection) {
      parts.push(`\n--- Mined Conventions ---`);
      parts.push(conventionSection);
      parts.push(`--- End Mined Conventions ---\n`);
    }
  }

  // 2d. Promoted review conventions
  if (promotedFindings && promotedFindings.length > 0) {
    parts.push(`\n--- Review Conventions ---`);
    parts.push("The following conventions were identified from recurring review findings:");
    for (const finding of promotedFindings) {
      const desc = finding.exampleComment ?? `${finding.category} in ${finding.module}`;
      parts.push(`- Convention: ${desc} (flagged ${finding.occurrenceCount} times in review, module: ${finding.module})`);
    }
    parts.push(`--- End Review Conventions ---\n`);
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
