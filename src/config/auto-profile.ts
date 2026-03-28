import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Logger } from "../logging/logger.js";

const API_BASE = "https://api.github.com";

export interface AutoProfileResult {
  profilePath: string;
  repoSlug: string;
  appInstalled: boolean;
}

/**
 * Check if the GitHub App (merger app) has access to a repo.
 * Calls GET /repos/{owner}/{repo}/installation to verify the app is installed.
 */
export async function checkGitHubAppAccess(
  owner: string,
  repo: string,
  token: string,
  logger: Logger,
): Promise<boolean> {
  const url = `${API_BASE}/repos/${owner}/${repo}/installation`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.ok) {
      logger.info("auto-profile", `GitHub App is installed on ${owner}/${repo}`);
      return true;
    }
    if (res.status === 404) {
      logger.warn("auto-profile", `GitHub App is NOT installed on ${owner}/${repo}`);
      return false;
    }
    logger.warn("auto-profile", `GitHub App access check returned ${res.status} for ${owner}/${repo}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("auto-profile", `GitHub App access check failed for ${owner}/${repo}: ${msg}`);
    return false;
  }
}

/**
 * Auto-generate a repo profile for a new repo and verify GitHub App access.
 * If the app is not installed, logs a warning and optionally posts a comment on the tracker issue.
 */
export async function autoGenerateProfile(
  repoSlug: string,
  token: string,
  logger: Logger,
  opts?: {
    appName?: string;
    tracker?: import("../tracker/types.js").TrackerAdapter;
    issueId?: string;
  },
): Promise<AutoProfileResult> {
  const [owner, repo] = repoSlug.split("/");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const reposDir = join(home, ".forgectl", "repos");
  const profilePath = join(reposDir, `${repo}.yaml`);

  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
  }

  if (!existsSync(profilePath)) {
    const overlay = {
      tracker: {
        kind: "github",
        repo: repoSlug,
        token: "$gh",
      },
    };
    writeFileSync(profilePath, yaml.dump(overlay, { lineWidth: 120 }), "utf-8");
    logger.info("auto-profile", `Generated repo profile: ${profilePath}`);
  }

  const appInstalled = await checkGitHubAppAccess(owner, repo, token, logger);

  if (!appInstalled) {
    const appName = opts?.appName ?? "forgectl-merger";
    const installUrl = `https://github.com/apps/${appName}/installations/new`;
    logger.warn(
      "auto-profile",
      `GitHub App not installed on ${repoSlug}. Install at: ${installUrl}`,
    );

    if (opts?.tracker && opts.issueId) {
      try {
        await opts.tracker.postComment(
          opts.issueId,
          `forgectl needs the GitHub App installed on this repo to create PRs. Install at: ${installUrl}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("auto-profile", `Failed to post install comment on issue: ${msg}`);
      }
    }
  }

  return { profilePath, repoSlug, appInstalled };
}
