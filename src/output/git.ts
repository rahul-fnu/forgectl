import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Docker from "dockerode";
import { execInContainer } from "../container/runner.js";
import { expandTemplate } from "../utils/template.js";
import { slugify } from "../utils/slug.js";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { GitResult } from "./types.js";

/**
 * Record the HEAD SHA before agent runs — used to detect agent changes.
 */
export async function recordPreAgentSha(
  container: Docker.Container,
): Promise<string> {
  const result = await execInContainer(container, [
    "git", "rev-parse", "HEAD",
  ], { workingDir: "/workspace" });
  return result.stdout.trim();
}

export async function collectGitOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger,
  preAgentSha?: string,
  pushToken?: string,
): Promise<GitResult> {
  const slug = slugify(plan.task);
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15);
  const branch = expandTemplate("forge/{{slug}}/{{ts}}", { slug, ts });

  logger.info("output", `Creating branch: ${branch}`);

  // Trust the workspace mount regardless of ownership.
  // The container runs as root but /workspace is bind-mounted from a temp dir owned
  // by the host user (e.g. uid=node), so git refuses all operations without this.
  await execInContainer(container, [
    "git", "config", "--global", "--add", "safe.directory", "/workspace",
  ], { workingDir: "/workspace" });

  // Configure git identity in container
  await execInContainer(container, [
    "git", "config", "user.name", plan.commit.author.name,
  ], { workingDir: "/workspace" });
  await execInContainer(container, [
    "git", "config", "user.email", plan.commit.author.email,
  ], { workingDir: "/workspace" });

  // Determine the SHA representing the state before the agent ran
  let initialSha: string;
  if (preAgentSha) {
    initialSha = preAgentSha;
  } else {
    // Fallback: use root commit (works when workspace was init'd fresh for this run)
    const initialResult = await execInContainer(container, [
      "git", "rev-list", "--max-parents=0", "HEAD",
    ], { workingDir: "/workspace" });
    initialSha = initialResult.stdout.trim().split("\n")[0];
  }

  // Check whether the agent made any commits on top of the pre-agent state
  const logResult = await execInContainer(container, [
    "git", "log", "--oneline", `${initialSha}..HEAD`,
  ], { workingDir: "/workspace" });
  const hasAgentCommits = logResult.stdout.trim().length > 0;

  // Also check for any unstaged/untracked changes the agent left behind (without committing)
  await execInContainer(container, ["git", "add", "-A"], {
    workingDir: "/workspace",
  });
  const diffResult = await execInContainer(container, [
    "git", "diff", "--cached", "--stat",
  ], { workingDir: "/workspace" });
  const hasUnstagedChanges = diffResult.stdout.trim().length > 0;

  if (!hasAgentCommits && !hasUnstagedChanges) {
    logger.warn("output", "No changes detected in workspace");
    return { mode: "git", branch, sha: "", filesChanged: 0, insertions: 0, deletions: 0 };
  }

  // If there are staged changes (agent left uncommitted work), commit them now
  if (hasUnstagedChanges) {
    const commitMsg = expandTemplate(plan.commit.message.template, {
      prefix: plan.commit.message.prefix,
      summary: plan.task.slice(0, 72),
    });
    await execInContainer(container, ["git", "commit", "-m", commitMsg], {
      workingDir: "/workspace",
    });
  }

  // Create the branch at current HEAD (includes agent commits and/or the forge commit)
  await execInContainer(container, ["git", "checkout", "-b", branch], {
    workingDir: "/workspace",
  });

  // Get final commit SHA
  const shaResult = await execInContainer(container, ["git", "rev-parse", "HEAD"], {
    workingDir: "/workspace",
  });
  const sha = shaResult.stdout.trim();

  // Get diff stats: compare all changes from the initial commit to current HEAD
  const statResult = await execInContainer(container, [
    "git", "diff", "--stat", `${initialSha}..HEAD`,
  ], { workingDir: "/workspace" });

  const statLine = statResult.stdout.trim().split("\n").pop() || "";
  const filesChanged = parseInt(statLine.match(/(\d+) file/)?.[1] || "0", 10);
  const insertions = parseInt(statLine.match(/(\d+) insertion/)?.[1] || "0", 10);
  const deletions = parseInt(statLine.match(/(\d+) deletion/)?.[1] || "0", 10);

  // Extract .git from container and fetch into host repo
  const tmpGit = mkdtempSync(join(tmpdir(), "forgectl-git-"));
  try {
    const archive = await container.getArchive({ path: "/workspace/.git" });

    // Extract tar stream to temp dir using system tar
    await new Promise<void>((resolve, reject) => {
      const extract = spawn("tar", ["xf", "-", "-C", tmpGit]);
      archive.pipe(extract.stdin);
      extract.on("close", (code: number) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });

    // tmpGit now contains a .git directory
    // Fetch the branch from tmpGit (which is a git repo root) into the host repo
    const hostRepo = plan.input.sources[0];
    execSync(`git fetch "${tmpGit}" "${branch}:${branch}"`, {
      cwd: hostRepo,
      stdio: "pipe",
    });

    logger.info("output", `Branch ${branch} fetched to host repo at ${hostRepo}`);

    // Push the branch to the remote
    try {
      const pushEnv = { ...process.env };
      if (pushToken) {
        // Set up credential helper that provides the token
        execSync(`git config credential.helper '!f() { echo "password=${pushToken}"; }; f'`, {
          cwd: hostRepo, stdio: "pipe",
        });
      }
      execSync(`git push origin "${branch}"`, {
        cwd: hostRepo,
        stdio: "pipe",
        env: pushEnv,
      });
      logger.info("output", `Branch ${branch} pushed to remote`);
    } catch (pushErr) {
      const msg = pushErr instanceof Error ? (pushErr as any).stderr?.toString() || pushErr.message : String(pushErr);
      logger.warn("output", `Failed to push branch (continuing): ${msg}`);
    }
  } finally {
    rmSync(tmpGit, { recursive: true, force: true });
  }

  return {
    mode: "git",
    branch,
    sha,
    filesChanged,
    insertions,
    deletions,
  };
}
