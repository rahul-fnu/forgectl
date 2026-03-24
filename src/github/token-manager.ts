import type { GitHubAppService } from "./app.js";
import type { Logger } from "../logging/logger.js";

const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_BUFFER_MS = 5 * 60 * 1000;  // refresh if <5 min remaining
const AUTO_REFRESH_MS = 50 * 60 * 1000;   // pre-emptive refresh every 50 min

export class TokenManager {
  private token = "";
  private expiresAt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly appService: GitHubAppService,
    private readonly installationId: number,
    private readonly logger?: Logger,
  ) {
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, AUTO_REFRESH_MS);
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_BUFFER_MS) {
      return this.token;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const octokit = await this.appService.getInstallationOctokit(this.installationId);
    const auth = await (octokit as any).auth({ type: "installation" }) as { token: string; expiresAt?: string };
    this.token = auth.token;
    this.expiresAt = auth.expiresAt
      ? new Date(auth.expiresAt).getTime()
      : Date.now() + TOKEN_LIFETIME_MS;
    this.logger?.info("token-manager", `GitHub App token refreshed (expires ${new Date(this.expiresAt).toISOString()})`);
    return this.token;
  }

  async getOctokit(): Promise<unknown> {
    // Always get a fresh octokit — @octokit/app handles token refresh internally
    // but we also track the token for raw API usage
    await this.getToken();
    return this.appService.getInstallationOctokit(this.installationId);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
