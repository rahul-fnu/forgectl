/**
 * Git operations for the merge daemon — extracted from tracker/github.ts.
 * Provides reusable functions for cloning, rebasing, conflict resolution, and pushing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Sanitize Claude's merge output before writing it to a file.
 * Returns cleaned content, or null if the output is invalid.
 */
export function sanitizeMergeOutput(raw: string, filename: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  // Reject obvious error messages
  if (/^error:/i.test(text) || text.startsWith("Error: Reached max turns")) return null;
  if (text.startsWith("I ") || text.startsWith("Here ") || text.startsWith("The merged")) return null;

  // Strip ALL markdown code fences
  text = text.replace(/^```\w*\r?\n/gm, "");
  text = text.replace(/^```\s*$/gm, "");
  text = text.trim();

  if (!text) return null;

  // Validate file-type-specific syntax
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "toml" && !text.includes("[")) return null;
  if (ext === "json" && !text.startsWith("{") && !text.startsWith("[")) return null;
  if (ext === "rs" && !text.includes("fn ") && !text.includes("mod ") && !text.includes("use ") && !text.includes("struct ")) return null;

  if (/^```/m.test(text)) return null;

  return text + "\n";
}

export interface CloneResult {
  tmpDir: string;
}

/**
 * Clone a repo and rebase a branch onto main.
 * Returns the tmpDir for further operations. Caller must clean up with cleanupTmpDir().
 */
export function cloneAndRebase(repoUrl: string, branch: string, authorName = "forgectl-merger[bot]", authorEmail = "forge-merger@localhost"): CloneResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "forgectl-merge-"));

  execFileSync("git", ["clone", "--no-checkout", repoUrl, "."], { cwd: tmpDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", authorName], { cwd: tmpDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", authorEmail], { cwd: tmpDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], { cwd: tmpDir, stdio: "pipe" });
  execFileSync("git", ["checkout", branch], { cwd: tmpDir, stdio: "pipe" });

  return { tmpDir };
}

/**
 * Attempt to merge main into the branch. Returns list of conflicted files, or empty if clean.
 */
export function mergeMain(tmpDir: string): string[] {
  try {
    execFileSync("git", ["merge", "origin/main", "--no-edit"], { cwd: tmpDir, stdio: "pipe" });
    return []; // Clean merge
  } catch {
    const conflictOutput = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: tmpDir,
      encoding: "utf-8",
    }).trim();

    if (!conflictOutput) return [];
    return conflictOutput.split("\n");
  }
}

/**
 * Resolve conflicts in given files using Claude Code.
 * Falls back to --theirs on failure.
 */
export async function resolveConflicts(tmpDir: string, conflicts: string[], claudeToken: string): Promise<void> {
  for (const file of conflicts) {
    let base = "", ours = "", theirs = "";
    try { base = execFileSync("git", ["show", `:1:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* new file */ }
    try { ours = execFileSync("git", ["show", `:2:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* deleted */ }
    try { theirs = execFileSync("git", ["show", `:3:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* deleted */ }

    const prompt = [
      `Merge these three versions of ${file}. Output ONLY the merged file content, no explanation.`,
      `=== BASE (common ancestor) ===`,
      base,
      `=== OURS (main branch) ===`,
      ours,
      `=== THEIRS (feature branch - new code to keep) ===`,
      theirs,
      `Rules: Include ALL content from both sides. Combine imports, merge function lists. Do not duplicate identical lines.`,
    ].join("\n");

    try {
      const promptFile = join(tmpDir, ".forgectl-merge-prompt.txt");
      writeFileSync(promptFile, prompt);
      const resolved = execFileSync(
        "claude",
        ["-p", "-", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "1"],
        { cwd: tmpDir, encoding: "utf-8", timeout: 60000, input: readFileSync(promptFile, "utf-8"), env: { ...process.env, ANTHROPIC_API_KEY: claudeToken } },
      );
      const cleaned = sanitizeMergeOutput(resolved, file);
      if (cleaned) {
        writeFileSync(join(tmpDir, file), cleaned);
      } else {
        execFileSync("git", ["checkout", "--theirs", file], { cwd: tmpDir, stdio: "pipe" });
      }
    } catch {
      execFileSync("git", ["checkout", "--theirs", file], { cwd: tmpDir, stdio: "pipe" });
    }
    execFileSync("git", ["add", file], { cwd: tmpDir, stdio: "pipe" });
  }
}

/**
 * Post-resolve verification: ask Claude to review the merge result.
 */
export async function verifyMerge(tmpDir: string, conflicts: string[]): Promise<void> {
  try {
    const diffOutput = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: tmpDir, encoding: "utf-8" });
    const changedFiles = conflicts.join(", ");
    const verifyPrompt = [
      `You just resolved merge conflicts in: ${changedFiles}`,
      `Here is the staged diff summary:\n${diffOutput}`,
      `Review the resolved files for these problems:`,
      `1. Markdown code fences (\`\`\`) that don't belong in source code`,
      `2. Duplicate function/struct/mod declarations`,
      `3. Missing imports or module declarations`,
      `4. Syntax errors (unclosed braces, missing semicolons)`,
      `5. Conflict markers (<<<<<<, ======, >>>>>>)`,
      ``,
      `For each file, run: cat <file> and check.`,
      `If you find problems, fix them and run: git add <file>`,
      `If everything looks clean, just say "LGTM".`,
    ].join("\n");
    const verifyFile = join(tmpDir, ".forgectl-verify-prompt.txt");
    writeFileSync(verifyFile, verifyPrompt);
    execFileSync(
      "claude",
      ["-p", "-", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "5"],
      { cwd: tmpDir, encoding: "utf-8", timeout: 120000, input: readFileSync(verifyFile, "utf-8") },
    );
  } catch {
    // Verification is best-effort
  }
}

/**
 * Commit the merge resolution (if needed) and force-push to the remote branch.
 * If the merge was clean (no conflicts to resolve), there may be nothing to commit.
 */
export function pushResolved(tmpDir: string, branch: string): void {
  // Only commit if there are staged changes (conflict resolution) or an in-progress merge
  try {
    execFileSync("git", ["commit", "--no-edit"], { cwd: tmpDir, stdio: "pipe" });
  } catch {
    // Nothing to commit (clean merge already created the commit)
  }
  execFileSync("git", ["push", "origin", branch, "--force"], { cwd: tmpDir, stdio: "pipe" });
}

/**
 * Clean up a temporary directory.
 */
export function cleanupTmpDir(tmpDir: string): void {
  rmSync(tmpDir, { recursive: true, force: true });
}
