import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Octokit } from "@octokit/core";
import type { DetectedStack } from "../config/auto-profile.js";
import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { scaffoldPython } from "./scaffolds/scaffold-python.js";
import { scaffoldNode } from "./scaffolds/scaffold-node.js";
import { scaffoldGo } from "./scaffolds/scaffold-go.js";
import { scaffoldRust } from "./scaffolds/scaffold-rust.js";

export interface CreateProjectOptions {
  name: string;
  description?: string;
  private?: boolean;
  stack: DetectedStack;
  org?: string;
}

export interface CreateProjectResult {
  repoSlug: string;
  cloneUrl: string;
  htmlUrl: string;
}

export async function createGitHubRepo(
  octokit: Octokit,
  opts: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const repoParams = {
    name: opts.name,
    description: opts.description ?? "",
    private: opts.private ?? true,
    auto_init: false,
  };

  let data: { full_name: string; clone_url: string; html_url: string };

  if (opts.org) {
    const res = await (octokit as any).rest.repos.createInOrg({
      org: opts.org,
      ...repoParams,
    });
    data = res.data;
  } else {
    const res = await (octokit as any).rest.repos.createForAuthenticatedUser(repoParams);
    data = res.data;
  }

  return {
    repoSlug: data.full_name,
    cloneUrl: data.clone_url,
    htmlUrl: data.html_url,
  };
}

export function scaffoldProject(dir: string, opts: CreateProjectOptions): void {
  const { name, stack } = opts;

  switch (stack) {
    case "python":
      scaffoldPython(dir, name);
      break;
    case "node":
    case "typescript":
      scaffoldNode(dir, name);
      break;
    case "go":
      scaffoldGo(dir, name, `github.com/${opts.org ?? "user"}/${name}`);
      break;
    case "rust":
      scaffoldRust(dir, name);
      break;
  }
}

export function initAndPush(dir: string, remoteUrl: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  run(["init"]);
  run(["add", "."]);
  run(["commit", "-m", "Initial scaffold"]);
  run(["branch", "-M", "main"]);
  run(["remote", "add", "origin", remoteUrl]);
  run(["push", "-u", "origin", "main"]);
}

export async function createProject(
  octokit: Octokit,
  opts: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const result = await createGitHubRepo(octokit, opts);

  const tmpDir = join(tmpdir(), `forgectl-scaffold-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    scaffoldProject(tmpDir, opts);
    initAndPush(tmpDir, result.cloneUrl);

    const { autoGenerateProfile } = await import("../config/auto-profile.js");
    await autoGenerateProfile(result.repoSlug);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  return result;
}

export interface NewProjectDetection {
  isNewProject: boolean;
  projectName: string | null;
  stack: DetectedStack | null;
  features: string[];
}

const STACK_KEYWORDS: Record<string, DetectedStack> = {
  python: "python",
  django: "python",
  flask: "python",
  fastapi: "python",
  node: "node",
  express: "node",
  typescript: "typescript",
  react: "typescript",
  nextjs: "typescript",
  "next.js": "typescript",
  go: "go",
  golang: "go",
  rust: "rust",
};

export function detectNewProject(issue: TrackerIssue): NewProjectDetection {
  const text = `${issue.title}\n${issue.description ?? ""}`;
  const hasLabel = issue.labels.some(
    (l) => l === "forge:new-project" || l === "new-project",
  );
  const hasNewProject = /\bnew\s+project\b/i.test(text);
  const hasCreateRepo = /create\s+(?:a\s+)?(?:new\s+)?repo\b/i.test(text);
  const hasScaffold = /\bscaffold\b/i.test(text);
  const hasStackField = /\*\*Stack:?\*\*/.test(text);
  if (!hasLabel && !hasNewProject && !hasCreateRepo && !hasScaffold && !hasStackField) {
    return { isNewProject: false, projectName: null, stack: null, features: [] };
  }

  // Extract project name from **Repo:** URL, **Project:** field, or trailing word after "create repo"
  let projectName: string | null = null;
  const repoUrlMatch = text.match(/\*\*Repo:?\*\*[:\s]*https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)/i);
  if (repoUrlMatch) {
    projectName = repoUrlMatch[1].replace(/\.git$/, "");
  }
  if (!projectName) {
    const projMatch = text.match(/\*\*Project(?:\s+Name)?\*\*[:\s]*(\S+)/i);
    if (projMatch) {
      projectName = projMatch[1].replace(/[`"']/g, "");
    }
  }
  if (!projectName) {
    const createRepoMatch = text.match(/create\s+repo\s+([\w.-]+)/i);
    if (createRepoMatch) {
      projectName = createRepoMatch[1];
    }
  }

  // Extract stack
  const lowerText = text.toLowerCase();
  let stack: DetectedStack | null = null;
  const stackMatch = text.match(/\*\*Stack\*\*[:\s]*(.+)/i);
  if (stackMatch) {
    const stackLine = stackMatch[1].toLowerCase();
    for (const [keyword, s] of Object.entries(STACK_KEYWORDS)) {
      if (stackLine.includes(keyword)) {
        stack = s;
        break;
      }
    }
  }
  if (!stack) {
    for (const [keyword, s] of Object.entries(STACK_KEYWORDS)) {
      if (lowerText.includes(keyword)) {
        stack = s;
        break;
      }
    }
  }

  // Extract features from ## Features or ## Requirements sections
  const features: string[] = [];
  const featuresMatch = text.match(/##\s+(?:Features|Requirements)\s*\n([\s\S]*?)(?:\n##|$)/i);
  if (featuresMatch) {
    const block = featuresMatch[1];
    for (const line of block.split("\n")) {
      const trimmed = line.replace(/^[-*]\s*/, "").trim();
      if (trimmed) features.push(trimmed);
    }
  }

  return { isNewProject: true, projectName, stack, features };
}

export function extractOrgFromConfig(config: ForgectlConfig): string | null {
  const project = (config as any).project;
  if (project?.github_org) return project.github_org;
  if (config.tracker?.repo) {
    const parts = config.tracker.repo.split("/");
    if (parts.length >= 2) return parts[0];
  }
  return null;
}

export async function handleNewProjectIssue(
  issue: TrackerIssue,
  detection: NewProjectDetection,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  logger: Logger,
): Promise<boolean> {
  const autoCreate = (config as any).project?.auto_create;
  if (!autoCreate) {
    return false;
  }

  if (!detection.projectName) {
    if (config.tracker?.comments_enabled !== false) {
      await tracker.postComment(
        issue.id,
        `**forgectl:** New project detected but could not determine project name. Add **Project:** name to the description.`,
      ).catch(() => {});
    }
    return false;
  }

  const org = extractOrgFromConfig(config);
  if (!org) {
    logger.warn("project", `No org available for project creation, skipping`);
    return false;
  }

  const githubToken = process.env.GITHUB_TOKEN ?? config.tracker?.token;
  if (!githubToken) {
    logger.warn("project", `No GITHUB_TOKEN available for project creation, skipping`);
    return false;
  }

  const stack = detection.stack ?? "typescript";

  try {
    const { Octokit } = await import("@octokit/core");
    const octokit = new Octokit({ auth: githubToken });

    const result = await createProject(octokit, {
      name: detection.projectName,
      stack,
      org,
      description: issue.title,
      private: true,
    });

    logger.info("project", `Created new project: ${result.repoSlug} (${result.htmlUrl})`);

    if (config.tracker?.comments_enabled !== false) {
      await tracker.postComment(
        issue.id,
        `**forgectl:** Created new project **${result.repoSlug}** (${stack})\n\n${result.htmlUrl}`,
      ).catch(() => {});
    }

    await tracker.updateState(issue.id, "closed").catch(() => {});
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("project", `Failed to create project for ${issue.identifier}: ${msg}`);
    if (config.tracker?.comments_enabled !== false) {
      await tracker.postComment(
        issue.id,
        `**forgectl:** Failed to create project: ${msg}`,
      ).catch(() => {});
    }
    return false;
  }
}
