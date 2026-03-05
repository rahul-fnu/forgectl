import { execSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import picomatch from "picomatch";

/**
 * Prepare a workspace directory by copying source with exclusions.
 * Returns the temp directory path.
 */
export function prepareRepoWorkspace(
  repoPath: string,
  exclude: string[]
): string {
  const tmpDir = join(tmpdir(), `forgectl-workspace-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  const isExcluded = picomatch(exclude);

  // Use rsync if available (faster, respects excludes natively)
  // Fallback to recursive copy with filtering
  try {
    const excludeFlags = exclude.map(e => `--exclude='${e}'`).join(" ");
    execSync(`rsync -a ${excludeFlags} '${resolve(repoPath)}/' '${tmpDir}/'`, { stdio: "ignore" });
  } catch {
    // Fallback: manual copy (slower but works everywhere)
    cpSync(resolve(repoPath), tmpDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(resolve(repoPath), "").replace(/^\//, "");
        if (rel === "") return true;
        return !isExcluded(rel);
      },
    });
  }

  return tmpDir;
}

/**
 * Prepare input files workspace for files mode.
 * Copies input files to a temp /input dir and creates empty /output dir.
 */
export function prepareFilesWorkspace(
  inputPaths: string[]
): { inputDir: string; outputDir: string } {
  const base = join(tmpdir(), `forgectl-files-${randomBytes(4).toString("hex")}`);
  const inputDir = join(base, "input");
  const outputDir = join(base, "output");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  for (const p of inputPaths) {
    const resolved = resolve(p);
    if (!existsSync(resolved)) throw new Error(`Input file not found: ${p}`);
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(resolved)) {
        cpSync(join(resolved, entry), join(inputDir, entry), { recursive: true });
      }
    } else {
      cpSync(resolved, join(inputDir, basename(resolved)), { recursive: true });
    }
  }

  return { inputDir, outputDir };
}
