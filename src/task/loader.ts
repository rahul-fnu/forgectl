import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import yaml from "js-yaml";
import { TaskSpecSchema } from "./schema.js";
import type { TaskSpec } from "./types.js";

/**
 * Load and validate a task spec from a YAML file.
 */
export function loadTaskSpec(filePath: string): TaskSpec {
  const content = readFileSync(filePath, "utf-8");
  return loadTaskSpecFromString(content);
}

/**
 * Load and validate a task spec from a YAML string.
 */
export function loadTaskSpecFromString(yamlContent: string): TaskSpec {
  const raw = yaml.load(yamlContent);
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("Invalid YAML: expected an object");
  }
  return TaskSpecSchema.parse(raw) as TaskSpec;
}

/**
 * Find all task spec files (*.task.yaml, *.task.yml) in a directory.
 */
export function findTaskSpecs(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue;
    const name = entry.toLowerCase();
    if (name.endsWith(".task.yaml") || name.endsWith(".task.yml")) {
      results.push(fullPath);
    }
  }
  return results.sort();
}
