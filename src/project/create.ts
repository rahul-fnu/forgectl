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

const NEW_PROJECT_TITLE_PATTERNS = [
  /\bnew project\b/i,
  /\bcreate repo\b/i,
  /\bscaffold\b/i,
  /\bnew repo\b/i,
];

const NEW_PROJECT_DESC_PATTERNS = [
  /\bscaffold\b/i,
  /\*\*Stack:\*\*/i,
];

const STACK_KEYWORDS: Array<{ pattern: RegExp; stack: DetectedStack }> = [
  { pattern: /\bpython\b/i, stack: "python" },
  { pattern: /\bfastapi\b/i, stack: "python" },
  { pattern: /\bdjango\b/i, stack: "python" },
  { pattern: /\bflask\b/i, stack: "python" },
  { pattern: /\btypescript\b/i, stack: "typescript" },
  { pattern: /\bnode\.?js\b/i, stack: "node" },
  { pattern: /\bexpress\b/i, stack: "node" },
  { pattern: /\bnext\.?js\b/i, stack: "typescript" },
  { pattern: /\b(?:go|golang)\b/i, stack: "go" },
  { pattern: /\bgrpc\b/i, stack: "go" },
  { pattern: /\brust\b/i, stack: "rust" },
  { pattern: /\bactix\b/i, stack: "rust" },
];

export function detectNewProject(issue: TrackerIssue): NewProjectDetection {
  const title = issue.title ?? "";
  const desc = issue.description ?? "";
  const labels = issue.labels ?? [];
  const text = `${title}\n${desc}`;

  let isNewProject = false;

  if (labels.includes("new-project")) {
    isNewProject = true;
  }
  for (const pat of NEW_PROJECT_TITLE_PATTERNS) {
    if (pat.test(title)) {
      isNewProject = true;
      break;
    }
  }
  if (!isNewProject) {
    for (const pat of NEW_PROJECT_DESC_PATTERNS) {
      if (pat.test(desc)) {
        isNewProject = true;
        break;
      }
    }
  }

  if (!isNewProject) {
    return { isNewProject: false, projectName: null, stack: null, features: [] };
  }

  // Extract project name from **Repo:** field
  let projectName: string | null = null;
  const repoFieldMatch = desc.match(/\*\*Repo:\*\*\s*(?:https?:\/\/github\.com\/[\w.-]+\/)?([\w.-]+)/i);
  if (repoFieldMatch) {
    projectName = repoFieldMatch[1].replace(/\.git$/, "");
  }

  // Fall back to extracting from title
  if (!projectName) {
    const titleNameMatch = title.match(/(?:new project|create repo|scaffold|new repo)[:\s]+(\S+)/i);
    if (titleNameMatch) {
      projectName = titleNameMatch[1].replace(/[^a-zA-Z0-9_.-]/g, "");
    }
  }

  // Extract stack from **Stack:** field first
  let stack: DetectedStack | null = null;
  const stackFieldMatch = desc.match(/\*\*Stack:\*\*\s*(.+)/i);
  if (stackFieldMatch) {
    const stackText = stackFieldMatch[1];
    for (const { pattern, stack: s } of STACK_KEYWORDS) {
      if (pattern.test(stackText)) {
        stack = s;
        break;
      }
    }
  }

  // Fall back to keyword detection in full text
  if (!stack) {
    for (const { pattern, stack: s } of STACK_KEYWORDS) {
      if (pattern.test(text)) {
        stack = s;
        break;
      }
    }
  }

  // Extract features from ## Features or ## Requirements sections
  const features: string[] = [];
  const sectionMatch = desc.match(/##\s*(?:Features|Requirements)\s*\n((?:\s*-\s*.+\n?)+)/i);
  if (sectionMatch) {
    const lines = sectionMatch[1].split("\n");
    for (const line of lines) {
      const itemMatch = line.match(/^\s*-\s+(.+)/);
      if (itemMatch) {
        features.push(itemMatch[1].trim());
      }
    }
  }

  return { isNewProject, projectName, stack, features };
}

export function extractOrgFromConfig(config: ForgectlConfig): string | null {
  const project = (config as any).project as { auto_create?: boolean; github_org?: string } | undefined;
  if (project?.github_org) {
    return project.github_org;
  }
  const trackerRepo = config.tracker?.repo;
  if (trackerRepo && trackerRepo.includes("/")) {
    return trackerRepo.split("/")[0];
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
  const project = (config as any).project as { auto_create?: boolean; github_org?: string } | undefined;
  if (!project?.auto_create) {
    logger.info("project", `New project detected in ${issue.identifier} but auto_create is disabled`);
    return false;
  }

  if (!detection.projectName) {
    await tracker.postComment(
      issue.id,
      `**forgectl:** New project detected but could not determine project name. Please add **Repo:** to the issue description.`,
    );
    logger.warn("project", `New project detected in ${issue.identifier} but no project name found`);
    return false;
  }

  const org = extractOrgFromConfig(config);
  if (!org) {
    logger.warn("project", `New project detected in ${issue.identifier} but no GitHub org configured`);
    return false;
  }

  const stack = detection.stack ?? "typescript";
  const name = detection.projectName;

  logger.info("project", `Creating new project: ${org}/${name} (stack=${stack})`);
  await tracker.postComment(
    issue.id,
    `**forgectl:** Creating new project **${org}/${name}** (stack: ${stack})...`,
  );

  try {
    const { Octokit } = await import("@octokit/core");
    const token = config.tracker?.token?.startsWith("$")
      ? process.env[config.tracker.token.slice(1)] ?? config.tracker.token
      : config.tracker?.token;

    const octokit = new Octokit({ auth: token });

    const result = await createProject(octokit, {
      name,
      description: detection.features.length > 0
        ? detection.features.join(", ")
        : issue.title,
      stack,
      org,
      private: true,
    });

    await tracker.postComment(
      issue.id,
      [
        `**forgectl:** Project created successfully!`,
        ``,
        `- **Repo:** ${result.htmlUrl}`,
        `- **Stack:** ${stack}`,
        `- **Profile:** ~/.forgectl/repos/${name}.yaml`,
      ].join("\n"),
    );

    logger.info("project", `Project created: ${result.repoSlug} (${result.htmlUrl})`);

    // Create feature sub-issues if features were listed
    if (detection.features.length > 0 && tracker.createIssue) {
      for (const feature of detection.features) {
        try {
          await tracker.createIssue(
            feature,
            `**Repo:** ${result.htmlUrl}\n\nImplement: ${feature}`,
            ["feature"],
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("project", `Failed to create sub-issue for "${feature}": ${msg}`);
        }
      }
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("project", `Failed to create project ${org}/${name}: ${msg}`);
    await tracker.postComment(
      issue.id,
      `**forgectl:** Failed to create project **${org}/${name}**: ${msg}`,
    ).catch(() => { /* best-effort */ });
    return false;
  }
}
