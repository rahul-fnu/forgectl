import type Docker from "dockerode";
import { execInContainer } from "../container/runner.js";
import type { Logger } from "../logging/logger.js";

/**
 * Checks file content for problems that indicate agent errors or corruption.
 * Returns a human-readable reason if the file is invalid, or null if OK.
 *
 * Shared logic used by both staged-file validation and sanitizeMergeOutput.
 */
export function detectContentProblems(content: string, filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const isMarkdown = ext === "md" || ext === "mdx";

  // Agent error messages at start of file
  if (/^Error:/m.test(content) && content.indexOf("Error:") < 200) {
    return "contains agent error message";
  }
  if (content.startsWith("Error: Reached max turns")) {
    return "contains 'Reached max turns' error";
  }

  // Markdown code fences in non-markdown files
  if (!isMarkdown && /^```/m.test(content)) {
    return "contains markdown code fences in non-markdown file";
  }

  // Git conflict markers
  if (/^[<>=]{7}/m.test(content)) {
    return "contains git conflict markers";
  }

  // File-type sanity checks
  if (ext === "toml" && !content.includes("[")) {
    return "TOML file missing section headers";
  }
  if (ext === "json") {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return "JSON file does not start with { or [";
    }
  }
  if (ext === "rs" && !content.includes("fn ") && !content.includes("mod ") && !content.includes("use ") && !content.includes("struct ")) {
    return "Rust file missing fn/mod/use/struct keywords";
  }

  return null;
}

/**
 * Validate staged files after `git add -A` but before commit.
 * Reads each staged file, checks for problems, and unstages invalid files.
 */
export async function validateStagedFiles(
  container: Docker.Container,
  logger: Logger,
): Promise<string[]> {
  // Get list of staged files
  const result = await execInContainer(container, [
    "git", "diff", "--cached", "--name-only",
  ], { workingDir: "/workspace" });

  const files = result.stdout.trim().split("\n").filter(Boolean);
  if (files.length === 0) return [];

  const unstaged: string[] = [];

  for (const file of files) {
    // Skip binary files and special files
    if (file === ".gitignore") continue;

    // Read file content
    let content: string;
    try {
      const readResult = await execInContainer(container, [
        "cat", file,
      ], { workingDir: "/workspace" });
      content = readResult.stdout;
    } catch {
      // File might be deleted (staged deletion) — skip
      continue;
    }

    // Skip empty files and binary-looking content
    if (!content || content.length === 0) continue;

    const problem = detectContentProblems(content, file);
    if (problem) {
      logger.warn("output", `Unstaging ${file}: ${problem}`);
      try {
        await execInContainer(container, [
          "git", "reset", "HEAD", file,
        ], { workingDir: "/workspace" });
        unstaged.push(file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("output", `Failed to unstage ${file}: ${msg}`);
      }
    }
  }

  if (unstaged.length > 0) {
    logger.warn("output", `Unstaged ${unstaged.length} invalid file(s): ${unstaged.join(", ")}`);
  }

  return unstaged;
}
