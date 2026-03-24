/**
 * Resolve a token value that may reference an environment variable or a sentinel.
 *
 * - "$GITHUB_TOKEN" => reads process.env.GITHUB_TOKEN
 * - "$LINEAR_API_KEY" => reads process.env.LINEAR_API_KEY
 * - "$gh" => runs `gh auth token` to get the token from GitHub CLI
 * - "$linear" => reads LINEAR_API_KEY env var (convenient shorthand)
 * - "literal-value" => returns the string as-is
 *
 * Throws if the env var is not set or is empty, or if gh CLI fails.
 */
import { execFileSync } from "node:child_process";

export function resolveToken(token: string): string {
  if (!token.startsWith("$")) {
    return token;
  }

  const varName = token.slice(1);

  // $linear sentinel: shorthand for $LINEAR_API_KEY
  if (varName === "linear") {
    const value = process.env.LINEAR_API_KEY;
    if (!value) {
      throw new Error('$linear: LINEAR_API_KEY environment variable is not set. Get your API key from Linear Settings > Account > Security & Access > API.');
    }
    return value;
  }

  // $gh sentinel: resolve via gh CLI
  if (varName === "gh") {
    try {
      const result = execFileSync("gh", ["auth", "token"], {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const resolved = result.trim();
      if (!resolved) {
        throw new Error("gh auth token returned empty output");
      }
      return resolved;
    } catch {
      throw new Error("'gh auth token' failed. Run 'gh auth login' first.");
    }
  }

  const value = process.env[varName];

  if (!value) {
    throw new Error(`Tracker: environment variable "${varName}" is not set`);
  }

  return value;
}
