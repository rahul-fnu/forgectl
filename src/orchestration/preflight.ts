import Docker from "dockerode";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { RunPlan } from "../workflow/types.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import type { Logger } from "../logging/logger.js";

export interface PreflightResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export async function runPreflightChecks(plan: RunPlan, logger: Logger): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Docker available?
  logger.debug("preflight", "Checking Docker...");
  try {
    const docker = new Docker();
    await docker.ping();
  } catch {
    errors.push("Docker is not running. Start Docker Desktop or the Docker daemon.");
  }

  // 2. Credentials configured?
  logger.debug("preflight", "Checking credentials...");
  if (plan.agent.type === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) {
      errors.push("No Claude Code credentials found. Run: forgectl auth add claude-code");
    }
  } else if (plan.agent.type === "codex") {
    const auth = await getCodexAuth();
    if (!auth) {
      errors.push("No Codex credentials found. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    }
  }

  // 3. Input files/repo exist?
  logger.debug("preflight", "Checking inputs...");
  for (const source of plan.input.sources) {
    if (!existsSync(source)) {
      errors.push(`Input not found: ${source}`);
    }
  }

  // 4. For git output mode, verify we're in a git repo
  if (plan.output.mode === "git") {
    const repoPath = plan.input.sources[0];
    if (repoPath && existsSync(repoPath)) {
      try {
        execSync("git rev-parse --is-inside-work-tree", { cwd: repoPath, stdio: "ignore" });
      } catch {
        errors.push(`Git output mode requires a git repository. ${repoPath} is not a git repo.`);
      }

      // Check for uncommitted changes
      try {
        const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });
        if (status.trim()) {
          warnings.push("Working directory has uncommitted changes. Consider committing first.");
        }
      } catch { /* ignore */ }
    }
  }

  // 5. Context files exist?
  for (const file of plan.context.files) {
    if (!existsSync(file)) {
      warnings.push(`Context file not found (will be skipped): ${file}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
