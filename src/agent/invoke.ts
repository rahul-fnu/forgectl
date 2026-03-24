import type Docker from "dockerode";
import type { AgentAdapter, AgentOptions } from "./types.js";
import { execInContainer, type ExecResult } from "../container/runner.js";

const PROMPT_DIR = "/tmp/forgectl";

/**
 * Invoke an agent inside a container safely:
 * 1. Write the prompt to a temp file inside the container via base64
 * 2. Build a shell command that reads from the file
 * 3. Execute via `sh -c`
 *
 * This avoids ARG_MAX limits and shell escaping issues with multi-KB prompts.
 */
export async function invokeAgent(
  container: Docker.Container,
  adapter: AgentAdapter,
  prompt: string,
  options: AgentOptions,
  env?: string[],
  promptId = "prompt",
): Promise<ExecResult> {
  const promptFile = `${PROMPT_DIR}/${promptId}.txt`;

  // Ensure prompt dir exists
  await execInContainer(container, ["mkdir", "-p", PROMPT_DIR], {
    workingDir: options.workingDir,
  });

  // Write prompt via base64 to avoid any shell escaping issues.
  // Split into chunks to stay under shell argument limits.
  const b64 = Buffer.from(prompt, "utf-8").toString("base64");
  const CHUNK_SIZE = 65536; // 64KB chunks — well under any shell limit

  // First chunk overwrites, subsequent chunks append
  for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
    const chunk = b64.slice(i, i + CHUNK_SIZE);
    const op = i === 0 ? ">" : ">>";
    await execInContainer(container, [
      "sh", "-c", `printf '%s' "$1" ${op} "${promptFile}.b64"`, "sh", chunk,
    ], { workingDir: options.workingDir });
  }

  // Decode in one shot
  await execInContainer(container, [
    "sh", "-c", `base64 -d "${promptFile}.b64" > "${promptFile}" && rm "${promptFile}.b64"`,
  ], { workingDir: options.workingDir });

  // Build the shell command that reads from the prompt file
  const shellCmd = adapter.buildShellCommand(promptFile, options);

  // Execute
  return execInContainer(container, ["sh", "-c", shellCmd], {
    env,
    workingDir: options.workingDir,
    timeout: options.timeout,
  });
}
