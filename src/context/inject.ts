import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import type Docker from "dockerode";
import { execInContainer } from "../container/runner.js";

/**
 * Copy context files from host into /input/context/ inside the container.
 * These supplement the input files — they're extra reference material.
 */
export async function injectContextFiles(
  container: Docker.Container,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;

  await execInContainer(container, ["mkdir", "-p", "/input/context"]);

  for (const file of files) {
    const absPath = resolve(file);
    if (!existsSync(absPath)) continue;

    const name = basename(absPath);
    // Context files are inlined into the prompt by buildPrompt.
    // This creates a marker file so agents know what context is available.
    await execInContainer(container, [
      "sh", "-c", `echo "context: ${name}" >> /input/context/.manifest`,
    ]);
  }
}
