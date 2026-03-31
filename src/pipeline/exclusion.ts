import { execFileSync } from "node:child_process";
import picomatch from "picomatch";

export interface ExclusionCheckResult {
  violations: string[];
}

export function checkExclusionViolations(
  repoPath: string,
  excludePatterns: string[],
): ExclusionCheckResult {
  if (excludePatterns.length === 0) {
    return { violations: [] };
  }

  const isExcluded = picomatch(excludePatterns);
  let changedFiles: string[] = [];
  try {
    const diffOutput = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];
  } catch {
    // git not available or not a repo — skip check
    return { violations: [] };
  }

  const violations = changedFiles.filter(f => isExcluded(f));
  if (violations.length > 0) {
    for (const file of violations) {
      try {
        execFileSync("git", ["checkout", "HEAD", "--", file], {
          cwd: repoPath,
          stdio: "pipe",
        });
      } catch { /* ignore revert failures */ }
    }
  }

  return { violations };
}
