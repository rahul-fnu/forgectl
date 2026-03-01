import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { WorkflowSchema, type WorkflowDefinition } from "../config/schema.js";

export function loadCustomWorkflows(
  projectDir?: string
): Record<string, WorkflowDefinition & { extends?: string }> {
  const dir = resolve(projectDir || process.cwd(), ".forgectl", "workflows");
  if (!existsSync(dir)) return {};

  const result: Record<string, WorkflowDefinition & { extends?: string }> = {};

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = readFileSync(join(dir, file), "utf-8");
    const parsed = yaml.load(raw);
    if (parsed == null || typeof parsed !== "object") continue;

    // Validate but allow `extends` field
    const workflow = WorkflowSchema.parse(parsed);
    const extendsField = (parsed as Record<string, unknown>).extends as string | undefined;
    result[workflow.name] = { ...workflow, extends: extendsField };
  }

  return result;
}
