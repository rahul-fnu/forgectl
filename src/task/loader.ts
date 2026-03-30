import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { TaskSpecSchema } from "./schema.js";
import type { TaskSpec } from "./types.js";

export function loadTaskSpecFromString(content: string): TaskSpec {
  const parsed = yaml.load(content);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid YAML: expected an object");
  }
  return TaskSpecSchema.parse(parsed);
}

export function loadTaskSpec(filePath: string): TaskSpec {
  const content = readFileSync(filePath, "utf-8");
  return loadTaskSpecFromString(content);
}

export function findTaskSpecs(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries
    .filter((f) => (f.endsWith(".task.yaml") || f.endsWith(".task.yml")) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => join(dir, f));
}
