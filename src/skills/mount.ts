import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ContainerMounts } from "../auth/mount.js";

/**
 * Set of file/directory names that must never appear inside a skill directory.
 * If any of these are found (recursively), the mount is rejected as a security violation.
 */
export const CREDENTIAL_DENY_LIST = new Set<string>([
  ".credentials.json",
  "credentials.json",
  "auth.json",
  "statsig",
  ".env",
  "token",
  "api_key",
]);

/**
 * Recursively scan hostPath for credential files.
 * Throws if any file or directory basename matches the deny list.
 */
export function validateNoCredentials(hostPath: string): void {
  const entries = readdirSync(hostPath, { recursive: true }) as string[];
  for (const entry of entries) {
    // Extract the basename from possibly nested paths like "subdir/.credentials.json"
    const parts = entry.split("/");
    const basename = parts[parts.length - 1];
    if (CREDENTIAL_DENY_LIST.has(basename)) {
      throw new Error(
        `Skill mount security violation: credential file "${entry}" found in ${hostPath}. Remove it or use --no-skills to disable skill mounting.`,
      );
    }
  }
}

/**
 * Prepare Docker bind mounts and --add-dir flags for the requested skill names.
 *
 * For each skill name, checks two host locations:
 *   - ~/.claude/skills/<name>
 *   - ~/.claude/agents/<name>
 *
 * If the directory exists and passes credential validation, it is mounted read-only.
 *
 * Also checks for ~/CLAUDE.md on the host and mounts it read-only if present.
 *
 * @param skills   - List of skill names to mount
 * @param noSkills - If true, return empty (skip all skill mounting)
 * @returns mounts (ContainerMounts with binds only) and addDirFlags (separate --add-dir entries)
 */
export function prepareSkillMounts(
  skills: string[],
  noSkills: boolean,
): { mounts: ContainerMounts; addDirFlags: string[] } {
  const empty = {
    mounts: { binds: [], env: {}, cleanup: () => {} },
    addDirFlags: [],
  };

  if (noSkills || skills.length === 0) {
    return empty;
  }

  const binds: string[] = [];
  const addDirFlags: string[] = [];
  const home = homedir();

  // Search paths: each skill name is checked under these ~/.claude/ subdirs
  const searchDirs = ["skills", "agents", "commands"] as const;
  const claudeBase = join(home, ".claude");

  for (const name of skills) {
    for (const subdir of searchDirs) {
      const hostPath = join(claudeBase, subdir, name);
      if (existsSync(hostPath)) {
        validateNoCredentials(hostPath);
        const containerPath = `/home/node/.claude/${subdir}/${name}`;
        binds.push(`${hostPath}:${containerPath}:ro`);
        addDirFlags.push("--add-dir");
        addDirFlags.push(containerPath);
      }
    }

    // Also check top-level ~/.claude/<name> (e.g. ~/.claude/get-shit-done)
    const topLevelPath = join(claudeBase, name);
    if (existsSync(topLevelPath) && !["skills", "agents", "commands"].includes(name)) {
      validateNoCredentials(topLevelPath);
      const containerPath = `/home/node/.claude/${name}`;
      binds.push(`${topLevelPath}:${containerPath}:ro`);
      addDirFlags.push("--add-dir");
      addDirFlags.push(containerPath);
    }
  }

  // Mount ~/CLAUDE.md if it exists on the host
  const claudeMdPath = join(home, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    binds.push(`${claudeMdPath}:/home/node/CLAUDE.md:ro`);
  }

  return {
    mounts: { binds, env: {}, cleanup: () => {} },
    addDirFlags,
  };
}
