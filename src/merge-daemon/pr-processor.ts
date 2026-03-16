/**
 * Core PR processing pipeline for the merge daemon.
 * Fetches open forge/* PRs and processes them sequentially:
 * rebase → resolve conflicts → validate → fix build → review → wait CI → merge.
 */

import { execSync } from "node:child_process";
import { resolveToken } from "../tracker/token.js";
import {
  cloneAndRebase,
  mergeMain,
  resolveConflicts,
  verifyMerge,
  pushResolved,
  cleanupTmpDir,
} from "./git-operations.js";
import type { Logger } from "../logging/logger.js";

const API_BASE = "https://api.github.com";

export interface PRInfo {
  number: number;
  branch: string;
  title: string;
  sha: string;
  url: string;
}

export interface ProcessResult {
  prNumber: number;
  branch: string;
  status: "merged" | "skipped" | "failed";
  error?: string;
}

export interface PRProcessorConfig {
  owner: string;
  repo: string;
  token: string;           // PAT or installation token (resolved)
  rawToken: string;         // raw token string (may be env: reference)
  branchPattern: string;    // e.g. "forge/*"
  ciTimeoutMs: number;      // default 45 min
  enableReview: boolean;
  enableBuildFix: boolean;
  validationCommands: string[];
  mergerAuthorName?: string;
  mergerAuthorEmail?: string;
}

export class PRProcessor {
  private readonly headers: Record<string, string>;
  private readonly history: ProcessResult[] = [];

  constructor(
    private readonly config: PRProcessorConfig,
    private readonly logger: Logger,
  ) {
    this.headers = {
      Authorization: `token ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    };
  }

  /**
   * Fetch open PRs matching the branch pattern, sorted oldest first.
   */
  async fetchOpenForgePRs(): Promise<PRInfo[]> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc`;
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch PRs: ${response.status}`);
    }

    const prs = (await response.json()) as Array<{
      number: number;
      head: { ref: string; sha: string };
      title: string;
      html_url: string;
    }>;

    // Filter by branch pattern (convert glob to regex)
    const patternRegex = new RegExp(
      "^" + this.config.branchPattern.replace(/\*/g, ".*") + "$",
    );

    return prs
      .filter((pr) => patternRegex.test(pr.head.ref))
      .map((pr) => ({
        number: pr.number,
        branch: pr.head.ref,
        title: pr.title,
        sha: pr.head.sha,
        url: pr.html_url,
      }));
  }

  /**
   * Process a single PR through the full pipeline.
   */
  async processPR(pr: PRInfo): Promise<ProcessResult> {
    const { owner, repo, rawToken } = this.config;
    const token = this.config.token;
    const repoUrl = `https://x-access-token:${resolveToken(rawToken)}@github.com/${owner}/${repo}.git`;
    const authorName = this.config.mergerAuthorName ?? "forgectl-merger[bot]";
    const authorEmail = this.config.mergerAuthorEmail ?? "forge-merger@localhost";

    this.logger.info("merge-daemon", `Processing PR #${pr.number}: ${pr.title} (${pr.branch})`);

    let tmpDir: string | undefined;

    try {
      // Step 1: Clone and rebase
      const clone = cloneAndRebase(repoUrl, pr.branch, authorName, authorEmail);
      tmpDir = clone.tmpDir;

      // Step 2: Merge main — resolve conflicts if any
      const conflicts = mergeMain(tmpDir);
      if (conflicts.length > 0) {
        this.logger.info("merge-daemon", `PR #${pr.number}: Resolving ${conflicts.length} conflict(s)`);
        await resolveConflicts(tmpDir, conflicts, token);
        await verifyMerge(tmpDir, conflicts);
        pushResolved(tmpDir, pr.branch);
        this.logger.info("merge-daemon", `PR #${pr.number}: Conflicts resolved and pushed`);
      }

      // Step 3: Run validation commands locally (if configured)
      if (this.config.validationCommands.length > 0) {
        const validationOk = await this.runValidation(tmpDir, this.config.validationCommands, pr);
        if (!validationOk) {
          if (this.config.enableBuildFix) {
            const fixed = await this.fixBuild(tmpDir, pr);
            if (!fixed) {
              return this.recordResult(pr, "failed", "Validation failed and build fix unsuccessful");
            }
            // Push fixed branch
            execSync(`git push origin "${pr.branch}" --force`, { cwd: tmpDir, stdio: "pipe" });
          } else {
            return this.recordResult(pr, "failed", "Validation failed");
          }
        }
      }

      // Step 4: Review diff (optional)
      if (this.config.enableReview) {
        await this.reviewDiff(tmpDir, pr);
      }

      // Step 5+6: Wait for CI then merge, with retry on 405 (branch not up to date)
      const maxMergeAttempts = 3;
      for (let mergeAttempt = 1; mergeAttempt <= maxMergeAttempts; mergeAttempt++) {
        // Re-fetch head SHA (may have changed from rebase/force-push)
        const prData = await this.fetchPRData(pr.number);
        const currentSha = prData?.head?.sha ?? pr.sha;
        const ciPassed = await this.waitForCI(pr.number, currentSha);
        if (!ciPassed) {
          return this.recordResult(pr, "failed", "CI did not pass");
        }

        // Attempt squash merge
        const mergeUrl = `${API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}/merge`;
        const mergeResponse = await fetch(mergeUrl, {
          method: "PUT",
          headers: this.headers,
          body: JSON.stringify({ merge_method: "squash" }),
        });

        if (mergeResponse.ok) {
          this.logger.info("merge-daemon", `PR #${pr.number}: Merged successfully`);
          return this.recordResult(pr, "merged");
        }

        const body = await mergeResponse.text();

        // 405 = branch not up to date with main (strict protection) — rebase and retry
        if (mergeResponse.status === 405 && mergeAttempt < maxMergeAttempts) {
          this.logger.info("merge-daemon", `PR #${pr.number}: Branch not up to date, rebasing (attempt ${mergeAttempt}/${maxMergeAttempts})`);
          // Clean up old tmpDir and re-clone
          if (tmpDir) cleanupTmpDir(tmpDir);
          const reclone = cloneAndRebase(repoUrl, pr.branch, authorName, authorEmail);
          tmpDir = reclone.tmpDir;
          const newConflicts = mergeMain(tmpDir);
          if (newConflicts.length > 0) {
            this.logger.info("merge-daemon", `PR #${pr.number}: Resolving ${newConflicts.length} conflict(s) on retry`);
            await resolveConflicts(tmpDir, newConflicts, token);
            await verifyMerge(tmpDir, newConflicts);
          }
          pushResolved(tmpDir, pr.branch);
          continue; // Wait for CI on new head and retry merge
        }

        return this.recordResult(pr, "failed", `Merge API returned ${mergeResponse.status}: ${body}`);
      }

      return this.recordResult(pr, "failed", `Exhausted ${maxMergeAttempts} merge attempts`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("merge-daemon", `PR #${pr.number}: Error — ${msg}`);
      return this.recordResult(pr, "failed", msg);
    } finally {
      if (tmpDir) cleanupTmpDir(tmpDir);
    }
  }

  /**
   * Wait for CI checks to pass on a given SHA.
   */
  async waitForCI(prNumber: number, sha: string): Promise<boolean> {
    const { owner, repo, ciTimeoutMs } = this.config;
    const pollMs = 30_000;
    const start = Date.now();

    while (Date.now() - start < ciTimeoutMs) {
      const url = `${API_BASE}/repos/${owner}/${repo}/commits/${sha}/check-runs`;
      const response = await fetch(url, { headers: this.headers });
      if (!response.ok) {
        this.logger.warn("merge-daemon", `PR #${prNumber}: Failed to fetch check-runs (${response.status})`);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }

      const checks = (await response.json()) as {
        check_runs?: Array<{ status: string; conclusion: string | null }>;
      };
      const runs = checks.check_runs ?? [];

      if (runs.length === 0) {
        // No checks yet — CI may not have started. Wait a bit before concluding no CI is configured.
        if (Date.now() - start < 60_000) {
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        return true; // No CI configured (waited at least 60s)
      }

      const allComplete = runs.every((r) => r.status === "completed");
      if (allComplete) {
        const allPassed = runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped");
        if (!allPassed) {
          this.logger.warn("merge-daemon", `PR #${prNumber}: CI failed`);
          await this.postComment(prNumber, "**forgectl merge-daemon:** CI checks failed. Skipping this PR.");
        }
        return allPassed;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    this.logger.warn("merge-daemon", `PR #${prNumber}: CI timed out after ${ciTimeoutMs}ms`);
    await this.postComment(prNumber, `**forgectl merge-daemon:** CI timed out after ${Math.round(ciTimeoutMs / 60000)} minutes. Skipping.`);
    return false;
  }

  /**
   * Run validation commands in the working directory.
   */
  async runValidation(tmpDir: string, commands: string[], pr: PRInfo): Promise<boolean> {
    for (const cmd of commands) {
      try {
        execSync(cmd, { cwd: tmpDir, stdio: "pipe", timeout: 300_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("merge-daemon", `PR #${pr.number}: Validation '${cmd}' failed: ${msg}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Invoke Claude to fix build errors, retry up to 3 times.
   */
  async fixBuild(tmpDir: string, pr: PRInfo): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { writeFileSync: ws } = await import("node:fs");
        const prompt = `The build is failing. Run the validation commands, read the errors, and fix them. Do not change test expectations or disable checks.`;
        const promptFile = `${tmpDir}/.forgectl-fix-prompt.txt`;
        ws(promptFile, prompt);
        execSync(
          `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 10`,
          { cwd: tmpDir, encoding: "utf-8", timeout: 180_000 },
        );

        // Re-run validation
        if (await this.runValidation(tmpDir, this.config.validationCommands, pr)) {
          execSync(`git add -A && git commit -m "fix: build fixes by forgectl merge-daemon"`, { cwd: tmpDir, stdio: "pipe" });
          this.logger.info("merge-daemon", `PR #${pr.number}: Build fixed on attempt ${attempt}`);
          return true;
        }
      } catch {
        this.logger.warn("merge-daemon", `PR #${pr.number}: Build fix attempt ${attempt} failed`);
      }
    }
    return false;
  }

  /**
   * Have Claude review the diff for obvious issues.
   */
  async reviewDiff(tmpDir: string, pr: PRInfo): Promise<void> {
    try {
      const { writeFileSync: ws } = await import("node:fs");
      const diff = execSync(`git diff origin/main...HEAD --stat`, { cwd: tmpDir, encoding: "utf-8" });
      const prompt = [
        `Review this PR diff for obvious issues (security, logic errors, missing error handling):`,
        diff,
        `If the changes look safe, say "LGTM". If there are critical issues, list them.`,
      ].join("\n");
      const promptFile = `${tmpDir}/.forgectl-review-prompt.txt`;
      ws(promptFile, prompt);
      execSync(
        `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 1`,
        { cwd: tmpDir, encoding: "utf-8", timeout: 60_000 },
      );
    } catch {
      // Review is best-effort
      this.logger.warn("merge-daemon", `PR #${pr.number}: Review step failed (best-effort, continuing)`);
    }
  }

  /** Fetch PR data from the API. */
  private async fetchPRData(prNumber: number): Promise<{ head?: { sha?: string } } | null> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
    try {
      const resp = await fetch(url, { headers: this.headers });
      if (resp.ok) return (await resp.json()) as { head?: { sha?: string } };
    } catch { /* ignore */ }
    return null;
  }

  /** Post a comment on a PR. */
  private async postComment(prNumber: number, body: string): Promise<void> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
    await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ body }),
    }).catch(() => {});
  }

  private recordResult(pr: PRInfo, status: ProcessResult["status"], error?: string): ProcessResult {
    const result: ProcessResult = { prNumber: pr.number, branch: pr.branch, status, error };
    this.history.push(result);
    // Keep last 100 results
    if (this.history.length > 100) this.history.shift();
    return result;
  }

  /** Get processing history. */
  getHistory(): readonly ProcessResult[] {
    return this.history;
  }
}
