import { execFileSync } from "node:child_process";
import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { autoGenerateProfile } from "../config/auto-profile.js";

const NEW_PROJECT_PATTERNS = [
  /\bnew[ -]?project\b/i,
  /\bcreate[ -]?repo\b/i,
  /\bscaffold\b/i,
  /\*\*Stack:\*\*/i,
];

const NEW_PROJECT_LABEL = "new-project";

const STACK_KEYWORDS: Record<string, string> = {
  python: "python",
  fastapi: "python",
  django: "python",
  flask: "python",
  express: "node",
  "node.js": "node",
  nodejs: "node",
  typescript: "typescript",
  react: "typescript",
  "next.js": "typescript",
  nextjs: "typescript",
  go: "go",
  golang: "go",
  rust: "rust",
};

export interface NewProjectDetection {
  isNewProject: boolean;
  projectName: string | null;
  stack: string | null;
  features: string[];
}

export function detectNewProject(issue: TrackerIssue): NewProjectDetection {
  const title = issue.title ?? "";
  const description = issue.description ?? "";
  const combined = `${title}\n${description}`;

  const hasLabel = issue.labels.some(
    (l) => l.toLowerCase() === NEW_PROJECT_LABEL,
  );
  const hasPattern = NEW_PROJECT_PATTERNS.some((p) => p.test(combined));

  if (!hasLabel && !hasPattern) {
    return { isNewProject: false, projectName: null, stack: null, features: [] };
  }

  const projectName = extractProjectName(issue);
  const stack = extractStack(combined);
  const features = extractFeatures(description);

  return { isNewProject: true, projectName, stack, features };
}

function extractProjectName(issue: TrackerIssue): string | null {
  const description = issue.description ?? "";

  const repoMatch = description.match(
    /\*\*Repo:\*\*\s*(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+)/i,
  );
  if (repoMatch) {
    const slug = repoMatch[1].replace(/\.git$/, "");
    const parts = slug.split("/");
    return parts.length > 1 ? parts[1] : slug;
  }

  const titleMatch = issue.title.match(
    /(?:create|scaffold|new(?:\s+project)?)\s+(?:repo\s+)?["`']?([\w.-]+)["`']?/i,
  );
  if (titleMatch) {
    return titleMatch[1];
  }

  return null;
}

function extractStack(text: string): string | null {
  const stackFieldMatch = text.match(/\*\*Stack:\*\*\s*(.+)/i);
  if (stackFieldMatch) {
    const stackValue = stackFieldMatch[1].trim().toLowerCase();
    for (const [keyword, stack] of Object.entries(STACK_KEYWORDS)) {
      if (stackValue.includes(keyword)) return stack;
    }
    return stackValue.split(/[\s,]+/)[0] || null;
  }

  const lower = text.toLowerCase();
  for (const [keyword, stack] of Object.entries(STACK_KEYWORDS)) {
    if (lower.includes(keyword)) return stack;
  }

  return null;
}

function extractFeatures(description: string): string[] {
  const features: string[] = [];
  const lines = description.split("\n");

  let inFeatureSection = false;
  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#+\s*(features?|requirements?|tasks?)/i.test(trimmed)) {
      inFeatureSection = true;
      continue;
    }

    if (inFeatureSection && /^#+\s/.test(trimmed)) {
      inFeatureSection = false;
      continue;
    }

    if (inFeatureSection) {
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        features.push(bulletMatch[1].trim());
      }
    }
  }

  return features;
}

export function extractOrgFromConfig(config: ForgectlConfig): string | null {
  if (config.project?.github_org) return config.project.github_org;
  const trackerRepo = config.tracker?.repo;
  if (trackerRepo) {
    const parts = trackerRepo.split("/");
    if (parts.length >= 2) return parts[0];
  }
  return null;
}

export async function repoExistsOnGitHub(repoSlug: string): Promise<boolean> {
  try {
    execFileSync("git", ["ls-remote", `https://github.com/${repoSlug}.git`], {
      stdio: "pipe",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface CreateProjectResult {
  repoSlug: string;
  stack: string;
  profileGenerated: boolean;
}

export async function createProject(
  projectName: string,
  stack: string | null,
  org: string,
  logger: Logger,
): Promise<CreateProjectResult> {
  const repoSlug = `${org}/${projectName}`;

  try {
    execFileSync("gh", ["repo", "create", repoSlug, "--public", "--clone=false"], {
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create GitHub repo ${repoSlug}: ${msg}`);
  }

  const effectiveStack = stack ?? "node";

  logger.info("project", `Created GitHub repo ${repoSlug} with ${effectiveStack} scaffold`);

  let profileGenerated = false;
  try {
    const result = await autoGenerateProfile(repoSlug);
    profileGenerated = result !== null;
  } catch {
    // best-effort profile generation
  }

  return { repoSlug, stack: effectiveStack, profileGenerated };
}

export async function handleNewProjectIssue(
  issue: TrackerIssue,
  detection: NewProjectDetection,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  logger: Logger,
): Promise<boolean> {
  if (!config.project?.auto_create) {
    logger.info("project", `New-project detected for ${issue.identifier} but auto_create is disabled`);
    return false;
  }

  if (!detection.projectName) {
    logger.warn("project", `New-project detected for ${issue.identifier} but no project name found`);
    if (config.tracker?.comments_enabled !== false) {
      await tracker.postComment(
        issue.id,
        "**forgectl:** Detected new-project issue but could not determine project name. " +
          "Please include `**Repo:** https://github.com/org/name` in the description.",
      ).catch(() => {});
    }
    return false;
  }

  const org = extractOrgFromConfig(config);
  if (!org) {
    logger.warn("project", `New-project detected for ${issue.identifier} but no GitHub org configured`);
    return false;
  }

  const repoSlug = `${org}/${detection.projectName}`;
  const exists = await repoExistsOnGitHub(repoSlug);
  if (exists) {
    logger.info("project", `Repo ${repoSlug} already exists, falling through to normal dispatch`);
    return false;
  }

  try {
    const result = await createProject(
      detection.projectName,
      detection.stack,
      org,
      logger,
    );

    if (config.tracker?.comments_enabled !== false) {
      await tracker.postComment(
        issue.id,
        `**forgectl:** Created repo [https://github.com/${result.repoSlug}](https://github.com/${result.repoSlug}) with ${result.stack} scaffold`,
      ).catch(() => {});
    }

    if (detection.features.length > 0 && tracker.createIssue) {
      for (const feature of detection.features) {
        await tracker.createIssue(
          feature,
          `**Repo:** https://github.com/${result.repoSlug}\n\nChild of ${issue.identifier}`,
          ["new-project-child"],
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("project", `Failed to create child issue for "${feature}": ${msg}`);
        });
      }

      await tracker.updateState(issue.id, "closed").catch(() => {});
    }

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
