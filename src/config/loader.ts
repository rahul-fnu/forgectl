import { readFileSync, existsSync, readdirSync } from "node:fs";
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
 *
 * Supports "repo:<path>" sentinel for repo profile loading (used internally).
 */
export function loadConfig(explicitPath?: string): ForgectlConfig {
  // Handle repo profile sentinel
  if (explicitPath?.startsWith("repo:")) {
    const profilePath = explicitPath.slice(5);
    return loadRepoProfileFromPath(profilePath);
  }

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

/**
 * Load a repo profile by name. Loads base config from ~/.forgectl/config.yaml,
 * deep-merges overlay from ~/.forgectl/repos/<name>.yaml, validates result.
 */
export function loadRepoProfile(name: string): ForgectlConfig {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const profilePath = join(home, ".forgectl", "repos", `${name}.yaml`);
  return loadRepoProfileFromPath(profilePath);
}

/**
 * Load a repo profile from an absolute path. Loads base from ~/.forgectl/config.yaml,
 * deep-merges the overlay, validates with ConfigSchema.
 */
function loadRepoProfileFromPath(profilePath: string): ForgectlConfig {
  if (!existsSync(profilePath)) {
    throw new Error(`Repo profile not found: ${profilePath}`);
  }

  // Load base config from home directory explicitly (not CWD walk)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const basePath = join(home, ".forgectl", "config.yaml");
  let base: Record<string, unknown> = {};
  if (existsSync(basePath)) {
    const raw = readFileSync(basePath, "utf-8");
    const parsed = yaml.load(raw);
    if (parsed != null && typeof parsed === "object") {
      base = parsed as Record<string, unknown>;
    }
  }

  // Load overlay
  const overlayRaw = readFileSync(profilePath, "utf-8");
  const overlay = yaml.load(overlayRaw);
  if (overlay == null || typeof overlay !== "object") {
    return ConfigSchema.parse(base);
  }

  const merged = deepMerge(base, overlay as Partial<Record<string, unknown>>);
  return ConfigSchema.parse(merged);
}

/**
 * Load config with options. Routes to the right loader based on flags.
 */
export function loadConfigWithOptions(opts: { config?: string; repo?: string }): ForgectlConfig {
  if (opts.config && opts.repo) {
    throw new Error("--config and --repo are mutually exclusive");
  }
  if (opts.repo) {
    return loadRepoProfile(opts.repo);
  }
  return loadConfig(opts.config);
}

/**
 * List available repo profiles from ~/.forgectl/repos/.
 * Returns array of { name, trackerRepo } objects.
 */
export function listRepoProfiles(): Array<{ name: string; trackerRepo?: string }> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const reposDir = join(home, ".forgectl", "repos");

  if (!existsSync(reposDir)) {
    return [];
  }

  const files = readdirSync(reposDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  return files.map(f => {
    const name = f.replace(/\.ya?ml$/, "");
    try {
      const raw = readFileSync(join(reposDir, f), "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown> | null;
      const tracker = parsed?.tracker as Record<string, unknown> | undefined;
      return { name, trackerRepo: tracker?.repo as string | undefined };
    } catch {
      return { name };
    }
  });
}
