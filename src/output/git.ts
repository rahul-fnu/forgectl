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

export async function collectGitOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<GitResult> {
  const slug = slugify(plan.task);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const branch = expandTemplate("forge/{{slug}}/{{ts}}", { slug, ts });

  logger.info("output", `Creating branch: ${branch}`);

  // Configure git identity in container
  await execInContainer(container, [
    "git", "config", "user.name", plan.commit.author.name,
  ], { workingDir: "/workspace" });
  await execInContainer(container, [
    "git", "config", "user.email", plan.commit.author.email,
  ], { workingDir: "/workspace" });

  // Stage all changes
  await execInContainer(container, ["git", "add", "-A"], {
    workingDir: "/workspace",
  });

  // Check if there are staged changes
  const diffResult = await execInContainer(container, ["git", "diff", "--cached", "--stat"], {
    workingDir: "/workspace",
  });

  if (!diffResult.stdout.trim()) {
    logger.warn("output", "No changes detected in workspace");
    return { mode: "git", branch, sha: "", filesChanged: 0, insertions: 0, deletions: 0 };
  }

  // Create branch from HEAD
  await execInContainer(container, ["git", "checkout", "-b", branch], {
    workingDir: "/workspace",
  });

  // Commit
  const commitMsg = expandTemplate(plan.commit.message.template, {
    prefix: plan.commit.message.prefix,
    summary: plan.task.slice(0, 72),
  });

  const commitCmd = [
    "git", "commit",
    "-m", commitMsg,
  ];

  await execInContainer(container, commitCmd, { workingDir: "/workspace" });

  // Get commit SHA
  const shaResult = await execInContainer(container, ["git", "rev-parse", "HEAD"], {
    workingDir: "/workspace",
  });
  const sha = shaResult.stdout.trim();

  // Get diff stats
  const statResult = await execInContainer(container, ["git", "diff", "--stat", "HEAD~1"], {
    workingDir: "/workspace",
  });

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
