import { execFileSync } from "node:child_process";

export interface MergeResult {
  success: boolean;
  conflicts?: string;
}

/**
 * Merge multiple upstream git branches into a target branch.
 * Creates the target branch from the first upstream, then merges the rest.
 */
export async function mergeUpstreamBranches(
  repoPath: string,
  upstreamBranches: string[],
  targetBranch: string,
): Promise<MergeResult> {
  if (upstreamBranches.length === 0) {
    return { success: true };
  }

  if (upstreamBranches.length === 1) {
    // Single branch, just create target from it
    execFileSync("git", ["checkout", "-b", targetBranch, upstreamBranches[0]], { cwd: repoPath, stdio: "pipe" });
    return { success: true };
  }

  // Create target from first upstream
  execFileSync("git", ["checkout", "-b", targetBranch, upstreamBranches[0]], { cwd: repoPath, stdio: "pipe" });

  // Merge remaining upstreams
  for (const branch of upstreamBranches.slice(1)) {
    try {
      execFileSync("git", ["merge", branch, "--no-edit"], { cwd: repoPath, stdio: "pipe" });
    } catch {
      // Merge conflict
      let conflicts = "";
      try {
        conflicts = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repoPath, encoding: "utf-8" });
      } catch {
        // ignore
      }
      try {
        execFileSync("git", ["merge", "--abort"], { cwd: repoPath, stdio: "pipe" });
      } catch {
        // ignore
      }
      return { success: false, conflicts: conflicts.trim() || "Unknown merge conflict" };
    }
  }

  return { success: true };
}
