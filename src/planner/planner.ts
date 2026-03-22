import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KGDatabase } from "../kg/storage.js";
import { createKGDatabase } from "../kg/storage.js";
import { buildContext } from "../context/builder.js";
import type { TaskSpec } from "../task/types.js";
import { loadTaskSpec } from "../task/loader.js";
import type { ExecutionPlan } from "./types.js";
import { validatePlan } from "./validator.js";
import type { PlanValidationResult } from "./types.js";

export interface PlannerOptions {
  kgDbPath?: string;
  repoRoot?: string;
}

export interface PlannerResult {
  plan: ExecutionPlan;
  validation: PlanValidationResult;
  contextSummary: string;
}

/**
 * Load a goal from a string or file path.
 * If the goal looks like a file path and exists, load as TaskSpec YAML or plain text.
 * Otherwise treat as free-text goal.
 */
export function loadGoal(goalOrFile: string): { text: string; taskSpec?: TaskSpec } {
  const resolved = resolve(goalOrFile);
  if (existsSync(resolved)) {
    const content = readFileSync(resolved, "utf-8");
    // Try parsing as TaskSpec YAML
    if (resolved.endsWith(".yaml") || resolved.endsWith(".yml")) {
      try {
        const spec = loadTaskSpec(resolved);
        return {
          text: `${spec.title}\n\n${spec.description ?? ""}\n\nConstraints:\n${spec.constraints.join("\n")}`,
          taskSpec: spec,
        };
      } catch {
        // Not a valid TaskSpec — use as plain text
      }
    }
    return { text: content };
  }
  return { text: goalOrFile };
}

/**
 * Build the planning prompt that asks Claude Code to produce an ExecutionPlan.
 */
export function buildPlanningPrompt(
  goalText: string,
  kgContextStr?: string,
): string {
  const parts: string[] = [];

  parts.push(`You are a planning agent. Given the goal below, produce a structured ExecutionPlan as JSON.

The ExecutionPlan must conform to this schema:
\`\`\`typescript
interface ExecutionPlan {
  tasks: PlannedTask[];
  estimatedTurns: number;
  riskLevel: "LOW" | "MED" | "HIGH" | "CRITICAL";
  rationale: string;
}
interface PlannedTask {
  id: string;           // lowercase alphanumeric with hyphens
  title: string;        // max 200 chars
  spec: TaskSpec;
  dependsOn: string[];  // IDs of tasks this depends on
  estimatedTurns: number;
  riskNotes: string;
}
interface TaskSpec {
  id: string;           // same as PlannedTask.id
  title: string;
  description?: string;
  context: {
    files: string[];    // glob patterns for relevant files
    docs?: string[];
    modules?: string[];
    related_tasks?: string[];
  };
  constraints: string[];
  acceptance: Array<{
    run?: string;       // shell command that must exit 0
    assert?: string;
    description?: string;
  }>;
  decomposition: {
    strategy: "auto" | "manual" | "forbidden";
    max_depth?: number;
  };
  effort: {
    max_turns?: number;
    max_review_rounds?: number;
    timeout?: string;   // e.g. "30m", "1h"
  };
}
\`\`\`

Rules:
- Each task must have at least one acceptance criterion with a \`run\` command
- Task IDs must be unique and lowercase with hyphens
- Dependencies must reference valid task IDs and form a DAG (no cycles)
- estimatedTurns should be the sum of all task estimatedTurns
- riskLevel: LOW (<5 files), MED (5-15 files), HIGH (15-50 files), CRITICAL (>50 files or infra changes)
- Output ONLY valid JSON — no markdown fences, no explanation outside the JSON`);

  if (kgContextStr) {
    parts.push(`\n--- Codebase Context (from Knowledge Graph) ---`);
    parts.push(kgContextStr);
    parts.push(`--- End Codebase Context ---`);
  }

  parts.push(`\n--- Goal ---`);
  parts.push(goalText);
  parts.push(`--- End Goal ---`);

  parts.push(`\nRespond with the ExecutionPlan JSON only.`);

  return parts.join("\n");
}

/**
 * Parse Claude's JSON response into an ExecutionPlan.
 * Handles common formatting issues (markdown fences, trailing text).
 */
export function parsePlanResponse(response: string): ExecutionPlan {
  let cleaned = response.trim();

  // Strip markdown code fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try to extract JSON object
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  const raw = JSON.parse(cleaned);

  // Validate required fields
  if (!Array.isArray(raw.tasks)) {
    throw new Error("ExecutionPlan missing 'tasks' array");
  }
  if (typeof raw.estimatedTurns !== "number") {
    throw new Error("ExecutionPlan missing 'estimatedTurns' number");
  }
  if (!["LOW", "MED", "HIGH", "CRITICAL"].includes(raw.riskLevel)) {
    throw new Error(`Invalid riskLevel: ${raw.riskLevel}`);
  }
  if (typeof raw.rationale !== "string") {
    throw new Error("ExecutionPlan missing 'rationale' string");
  }

  // Validate each task has required fields
  for (const task of raw.tasks) {
    if (!task.id || typeof task.id !== "string") {
      throw new Error("PlannedTask missing 'id'");
    }
    if (!task.title || typeof task.title !== "string") {
      throw new Error(`PlannedTask "${task.id}" missing 'title'`);
    }
    if (!task.spec || typeof task.spec !== "object") {
      throw new Error(`PlannedTask "${task.id}" missing 'spec'`);
    }
    if (!Array.isArray(task.dependsOn)) {
      task.dependsOn = [];
    }
    if (typeof task.estimatedTurns !== "number") {
      task.estimatedTurns = 10;
    }
    if (typeof task.riskNotes !== "string") {
      task.riskNotes = "";
    }

    // Ensure spec has required defaults
    const spec = task.spec;
    if (!spec.id) spec.id = task.id;
    if (!spec.title) spec.title = task.title;
    if (!spec.context) spec.context = { files: [] };
    if (!Array.isArray(spec.context.files)) spec.context.files = [];
    if (!Array.isArray(spec.constraints)) spec.constraints = [];
    if (!Array.isArray(spec.acceptance)) {
      spec.acceptance = [{ run: "npm test", description: "Tests pass" }];
    }
    if (!spec.decomposition) spec.decomposition = { strategy: "forbidden" };
    if (!spec.effort) spec.effort = { max_turns: task.estimatedTurns };
  }

  return raw as ExecutionPlan;
}

/**
 * Build KG-enriched context for the planning goal.
 * Returns the context string for the prompt, or undefined if KG is not available.
 */
export async function buildPlannerContext(
  goalText: string,
  taskSpec?: TaskSpec,
  options?: PlannerOptions,
): Promise<string | undefined> {
  let kgDb: KGDatabase | undefined;
  try {
    kgDb = createKGDatabase(options?.kgDbPath);
  } catch {
    return undefined;
  }

  // Build a synthetic TaskSpec for context lookup if we don't have one
  const contextTask: TaskSpec = taskSpec ?? {
    id: "planner-goal",
    title: goalText.slice(0, 200),
    description: goalText,
    context: { files: extractFileRefs(goalText) },
    constraints: [],
    acceptance: [{ description: "Plan is valid" }],
    decomposition: { strategy: "auto" },
    effort: { max_turns: 1 },
  };

  try {
    const ctx = await buildContext(contextTask, kgDb);
    return `${ctx.systemContext}\n${ctx.taskContext}`;
  } catch {
    return undefined;
  }
}

/**
 * Extract file path references from free-text goals.
 */
function extractFileRefs(text: string): string[] {
  const pattern = /(?:src|test|lib)\/[\w/.=-]+\.(?:ts|js|tsx|jsx)/g;
  const matches = text.match(pattern);
  return matches ? [...new Set(matches)] : ["src/**/*.ts"];
}

/**
 * Generate an execution plan from a goal.
 * This builds context and produces a prompt — the actual Claude invocation
 * is done by the caller (CLI or orchestrator).
 */
export async function generatePlanPrompt(
  goalOrFile: string,
  options?: PlannerOptions,
): Promise<{ prompt: string; contextSummary: string }> {
  const goal = loadGoal(goalOrFile);
  const kgContext = await buildPlannerContext(goal.text, goal.taskSpec, options);

  const prompt = buildPlanningPrompt(goal.text, kgContext);
  const contextSummary = kgContext
    ? `KG context included (${kgContext.length} chars)`
    : "No KG context available (run 'forgectl kg build' first)";

  return { prompt, contextSummary };
}

/**
 * Validate a plan with optional KG and repo root.
 */
export function validateExecutionPlan(
  plan: ExecutionPlan,
  options?: PlannerOptions,
): PlanValidationResult {
  let kgDb: KGDatabase | undefined;
  try {
    kgDb = createKGDatabase(options?.kgDbPath);
  } catch {
    // KG not available — validate without it
  }

  return validatePlan(plan, kgDb, options?.repoRoot);
}
