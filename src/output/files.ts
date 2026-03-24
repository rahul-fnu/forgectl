import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdirSync, statSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { FileResult } from "./types.js";

export async function collectFileOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<FileResult> {
  const outputDir = plan.output.hostDir;
  mkdirSync(outputDir, { recursive: true });

  logger.info("output", `Collecting files from container ${plan.output.path} → ${outputDir}`);

  // Get archive of the output directory from container
  let archive: NodeJS.ReadableStream;
  try {
    archive = await container.getArchive({ path: plan.output.path });
  } catch {
    logger.warn("output", `Output path ${plan.output.path} not found in container`);
    return { mode: "files", dir: outputDir, files: [], totalSize: 0 };
  }

  // Extract to a temp dir first
  const tmpDir = mkdtempSync(join(tmpdir(), "forgectl-output-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const extract = spawn("tar", ["xf", "-", "-C", tmpDir]);
      archive.pipe(extract.stdin);
      extract.on("close", (code: number) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });

    // Docker's getArchive returns a tar where the root entry is the directory basename.
    // e.g., for /output the tar contains output/...
    // We want to copy the contents of that inner directory to outputDir.
    const containerPathBase = plan.output.path.split("/").filter(Boolean).pop() || "output";
    const extractedDir = join(tmpDir, containerPathBase);

    try {
      execSync(`cp -r --no-dereference "${extractedDir}/." "${outputDir}/"`, { stdio: "pipe" });
    } catch {
      // If extractedDir doesn't exist, the container path may have been a file, not dir
      execSync(`cp -r --no-dereference "${tmpDir}/." "${outputDir}/"`, { stdio: "pipe" });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const files = listFilesRecursive(outputDir);
  const totalSize = files.reduce((sum, f) => {
    try { return sum + statSync(join(outputDir, f)).size; } catch { return sum; }
  }, 0);

  logger.info("output", `Collected ${files.length} files (${formatBytes(totalSize)})`);

  return {
    mode: "files",
    dir: outputDir,
    files,
    totalSize,
  };
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(join(dir, entry.name), rel));
      } else {
        files.push(rel);
      }
    }
  } catch {
    // Directory may not exist yet
  }
  return files;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
