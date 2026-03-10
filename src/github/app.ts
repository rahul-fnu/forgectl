import { readFileSync } from "node:fs";
import { App } from "@octokit/app";
import type { GitHubAppConfig } from "./types.js";

/**
 * Service wrapping @octokit/app for GitHub App operations.
 * Handles initialization, private key validation, and installation authentication.
 */
export class GitHubAppService {
  readonly app: App;

  constructor(config: GitHubAppConfig) {
    const privateKey = readFileSync(config.privateKeyPath, "utf-8");
    if (!privateKey.startsWith("-----BEGIN")) {
      throw new Error(
        `Invalid GitHub App private key at ${config.privateKeyPath}: ` +
          `file must start with "-----BEGIN". Ensure you have the correct PEM-formatted key.`
      );
    }

    this.app = new App({
      appId: config.appId,
      privateKey,
      webhooks: { secret: config.webhookSecret },
    });
  }

  /**
   * Get an authenticated Octokit instance for a specific installation.
   * Use this to make API calls on behalf of the app for a given org/repo.
   */
  async getInstallationOctokit(installationId: number) {
    return this.app.getInstallationOctokit(installationId);
  }
}

/**
 * Factory function to create a GitHubAppService from config.
 */
export function createGitHubAppService(
  config: GitHubAppConfig
): GitHubAppService {
  return new GitHubAppService(config);
}
