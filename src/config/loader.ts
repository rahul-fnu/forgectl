import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema, type ForgectlConfig } from "./schema.js";

const CONFIG_FILENAMES = [".forgectl/config.yaml", ".forgectl/config.yml"];

/**
 * Find the config file by walking up directories.
 * Check: CLI path → cwd → parent dirs → ~/.forgectl/config.yaml
 */
export function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    if (existsSync(explicitPath)) return resolve(explicitPath);
    throw new Error(`Config file not found: ${explicitPath}`);
  }

  // Walk up from cwd
  let dir = process.cwd();
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  // Check home directory
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(home, name);
    if (existsSync(candidate)) return candidate;
  }

  return null; // No config found — use defaults
}

/**
 * Load config from file, validate with zod, return typed config.
 * Returns defaults if no config file exists.
 */
export function loadConfig(explicitPath?: string): ForgectlConfig {
  const configPath = findConfigFile(explicitPath);

  if (!configPath) {
    return ConfigSchema.parse({});
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw);

  if (parsed == null || typeof parsed !== "object") {
    return ConfigSchema.parse({});
  }

  return ConfigSchema.parse(parsed);
}

/**
 * Deep merge two objects. `overrides` values take precedence.
 * Arrays are replaced (not merged). Undefined values in overrides are skipped.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: Partial<T>
): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const overrideVal = overrides[key];
    if (overrideVal === undefined) continue;
    const baseVal = base[key];
    if (
      baseVal != null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      overrideVal != null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      ) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}
