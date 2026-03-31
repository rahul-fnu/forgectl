import { execFile } from "node:child_process";

/**
 * Execute a workspace lifecycle hook as a shell command.
 * @param hookName - Name of the hook (for error messages)
 * @param command - Shell command to execute
 * @param cwd - Working directory (workspace path)
 * @param timeoutMs - Timeout in milliseconds
 */
export async function executeHook(
  hookName: string,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error: any) => {
        if (error) {
          if (error.killed) {
            reject(
              new Error(
                `Hook "${hookName}" timed out after ${timeoutMs}ms`,
              ),
            );
          } else {
            const stderr = (error.stderr || "").trim().slice(0, 500);
            reject(
              new Error(
                `Hook "${hookName}" failed (exit ${error.code}): ${stderr}`,
              ),
            );
          }
          return;
        }
        resolve();
      },
    );
  });
}
