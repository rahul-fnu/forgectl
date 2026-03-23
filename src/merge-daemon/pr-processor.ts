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
  status: "merged" | "skipped" | "failed" | "request_changes";
  error?: string;
}

export interface InlineReviewComment {
  file: string;
  line: number;
  severity: "must_fix" | "should_fix" | "nit";
  body: string;
}

export interface StructuredReview {
  summary: string;
  approval: "approve" | "request_changes";
  comments: InlineReviewComment[];
}

export function parseStructuredReview(raw: string): StructuredReview | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Try to extract JSON block from markdown fences
  let jsonText = trimmed;
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  } else {
    // Try to find a raw JSON object
    const objMatch = /\{[\s\S]*\}/.exec(trimmed);
    if (objMatch) {
      jsonText = objMatch[0];
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === "string" ? obj.summary : "No summary";
  const approval = obj.approval === "request_changes" ? "request_changes" as const : "approve" as const;

  const comments: InlineReviewComment[] = [];
  if (Array.isArray(obj.comments)) {
    for (const item of obj.comments) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const file = typeof c.file === "string" ? c.file : undefined;
      const line = typeof c.line === "number" ? c.line : undefined;
      const sev = typeof c.severity === "string" ? c.severity.toLowerCase() : undefined;
      const body = typeof c.body === "string" ? c.body : undefined;
      if (!file || !line || !body) continue;
      const severity = (sev === "must_fix" || sev === "should_fix" || sev === "nit") ? sev : "nit";
      comments.push({ file, line, severity, body });
    }
  }

  return { summary, approval, comments };
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
        const review = await this.reviewDiff(tmpDir, pr);
        if (review?.approval === "request_changes") {
          return this.recordResult(pr, "request_changes", review.summary);
        }
      }

      // Step 5+6: Wait for CI then merge, with retry on failure
      const maxMergeAttempts = 5;
      const maxBuildFixes = 3;
      let buildFixCount = 0;
      for (let mergeAttempt = 1; mergeAttempt <= maxMergeAttempts; mergeAttempt++) {
        // Re-fetch head SHA (may have changed from rebase/force-push)
        const prData = await this.fetchPRData(pr.number);
        const currentSha = prData?.head?.sha ?? pr.sha;
        const ciPassed = await this.waitForCI(pr.number, currentSha);
        if (!ciPassed) {
          // CI failed — try to fix the build if enabled
          if (this.config.enableBuildFix && buildFixCount < maxBuildFixes) {
            buildFixCount++;
            this.logger.info("merge-daemon", `PR #${pr.number}: CI failed, attempting build fix (${buildFixCount}/${maxBuildFixes})`);
            const fixed = await this.fixCIFailure(pr, currentSha);
            if (fixed) {
              continue; // New head pushed — re-wait for CI
            }
          }
          return this.recordResult(pr, "failed", `CI failed after ${buildFixCount} fix attempt(s)`);
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

        // 405 = branch not up to date or checks pending — check if rebase is actually needed
        if (mergeResponse.status === 405 && mergeAttempt < maxMergeAttempts) {
          // Check if the branch is actually behind main (mergeable_state)
          const prCheck = await this.fetchPRData(pr.number) as { mergeable_state?: string; mergeable?: boolean } | null;
          const needsRebase = prCheck?.mergeable === false || prCheck?.mergeable_state === "behind" || prCheck?.mergeable_state === "dirty";

          if (needsRebase) {
            this.logger.info("merge-daemon", `PR #${pr.number}: Branch behind main, rebasing (attempt ${mergeAttempt}/${maxMergeAttempts})`);
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
          } else {
            // Branch is up to date but checks still pending — just wait and retry
            this.logger.info("merge-daemon", `PR #${pr.number}: Checks still pending, waiting 60s before retry (attempt ${mergeAttempt}/${maxMergeAttempts})`);
            await new Promise((r) => setTimeout(r, 60_000));
          }
          continue;
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
   * Review the diff with structured inline comments.
   * Returns the parsed review, or undefined if review fails.
   */
  async reviewDiff(tmpDir: string, pr: PRInfo): Promise<StructuredReview | undefined> {
    try {
      const { writeFileSync: ws } = await import("node:fs");

      // Get full diff against main
      const diff = execSync(`git diff origin/main...HEAD`, {
        cwd: tmpDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      // Fetch PR description for context
      const prDescription = await this.fetchPRDescription(pr.number);

      const prompt = [
        `You are reviewing PR #${pr.number}: "${pr.title}".`,
        ``,
        ...(prDescription ? [`PR description:`, prDescription, ``] : []),
        `Here is the full diff:`,
        ``,
        diff,
        ``,
        `Review this diff and check for:`,
        `- Does the code match the PR description requirements?`,
        `- Error handling patterns (missing try/catch, swallowed errors)`,
        `- Test coverage (new code without tests)`,
        `- Security issues (injection, path traversal)`,
        `- Code patterns (consistent with codebase style)`,
        `- Unused imports/variables`,
        ``,
        `Output ONLY a JSON object (no markdown fences, no extra text) in this exact format:`,
        `{`,
        `  "summary": "Overall assessment of the changes",`,
        `  "approval": "approve" or "request_changes",`,
        `  "comments": [`,
        `    { "file": "src/foo.ts", "line": 42, "severity": "must_fix", "body": "Description of issue" }`,
        `  ]`,
        `}`,
        ``,
        `Severity levels:`,
        `- must_fix: Blocks merge. Correctness bugs, security issues, data loss risks.`,
        `- should_fix: Address if straightforward. Missing edge cases, weak error handling.`,
        `- nit: Style/preference.`,
        ``,
        `Set approval to "request_changes" if there are any must_fix comments. Otherwise "approve".`,
        `If the code is clean, set approval to "approve" with an empty comments array.`,
      ].join("\n");

      const promptFile = `${tmpDir}/.forgectl-review-prompt.txt`;
      ws(promptFile, prompt);
      const output = execSync(
        `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 3`,
        { cwd: tmpDir, encoding: "utf-8", timeout: 120_000 },
      );

      const review = parseStructuredReview(output);
      if (!review) {
        this.logger.warn("merge-daemon", `PR #${pr.number}: Could not parse review output as JSON`);
        return undefined;
      }

      // Post review to GitHub
      await this.submitPRReview(pr.number, review);

      this.logger.info(
        "merge-daemon",
        `PR #${pr.number}: Review complete — ${review.approval} (${review.comments.length} comments)`,
      );

      return review;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("merge-daemon", `PR #${pr.number}: Review step failed: ${msg}`);
      return undefined;
    }
  }

  /**
   * Post a structured review with inline comments on the PR via GitHub API.
   */
  async submitPRReview(prNumber: number, review: StructuredReview): Promise<void> {
    const { owner, repo } = this.config;

    // Map inline comments to GitHub's review comment format
    const ghComments = review.comments.map((c) => ({
      path: c.file,
      line: c.line,
      body: `**[${c.severity.toUpperCase()}]** ${c.body}`,
    }));

    const event = review.approval === "request_changes" ? "REQUEST_CHANGES" : "APPROVE";
    const body = review.approval === "approve"
      ? `LGTM — ${review.summary}`
      : review.summary;

    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        event,
        body,
        comments: ghComments,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(
        "merge-daemon",
        `PR #${prNumber}: Failed to submit review (${response.status}): ${text}`,
      );
    }
  }

  /**
   * Fetch a PR's description body from the API.
   */
  private async fetchPRDescription(prNumber: number): Promise<string | null> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
    try {
      const resp = await fetch(url, { headers: this.headers });
      if (resp.ok) {
        const data = (await resp.json()) as { body?: string | null };
        return data.body ?? null;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Fix a CI failure by fetching error logs, cloning the branch, and using Claude to fix.
   * Returns true if a fix was pushed (caller should re-wait for CI).
   */
  async fixCIFailure(pr: PRInfo, failedSha: string): Promise<boolean> {
    const { owner, repo, rawToken } = this.config;
    const repoUrl = `https://x-access-token:${resolveToken(rawToken)}@github.com/${owner}/${repo}.git`;
    const authorName = this.config.mergerAuthorName ?? "forgectl-merger[bot]";
    const authorEmail = this.config.mergerAuthorEmail ?? "forge-merger@localhost";

    // Step 1: Fetch CI error logs
    const errorLog = await this.fetchCIErrorLog(pr.number, failedSha);
    if (!errorLog) {
      this.logger.warn("merge-daemon", `PR #${pr.number}: Could not fetch CI error logs`);
      return false;
    }

    // Step 2: Clone the branch
    let fixDir: string | undefined;
    try {
      const clone = cloneAndRebase(repoUrl, pr.branch, authorName, authorEmail);
      fixDir = clone.tmpDir;

      // Step 3: Write error context and invoke Claude
      const { writeFileSync: ws } = await import("node:fs");
      const prompt = [
        `The CI build is failing on this branch. Here are the error logs:`,
        ``,
        errorLog,
        ``,
        `Fix the build errors. Rules:`,
        `- Read the failing source files before making changes`,
        `- Fix the actual errors shown above — do not change tests or disable checks`,
        `- Make minimal changes to fix the build`,
        `- Stage your changes with git add`,
      ].join("\n");

      const promptFile = `${fixDir}/.forgectl-ci-fix-prompt.txt`;
      ws(promptFile, prompt);
      execSync(
        `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 15`,
        { cwd: fixDir, encoding: "utf-8", timeout: 300_000 },
      );

      // Step 4: Check if Claude made changes
      const status = execSync(`git status --porcelain`, { cwd: fixDir, encoding: "utf-8" }).trim();
      if (!status) {
        this.logger.warn("merge-daemon", `PR #${pr.number}: Claude made no changes`);
        return false;
      }

      // Step 5: Commit and push
      execSync(`git add -A`, { cwd: fixDir, stdio: "pipe" });
      execSync(`git commit -m "fix: CI build errors (forgectl merge-daemon)"`, { cwd: fixDir, stdio: "pipe" });
      execSync(`git push origin "${pr.branch}" --force`, { cwd: fixDir, stdio: "pipe" });

      this.logger.info("merge-daemon", `PR #${pr.number}: Build fix pushed`);
      await this.postComment(pr.number, `**forgectl merge-daemon:** Pushed build fix based on CI error logs. Waiting for CI to re-run.`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("merge-daemon", `PR #${pr.number}: CI fix failed: ${msg}`);
      return false;
    } finally {
      if (fixDir) cleanupTmpDir(fixDir);
    }
  }

  /**
   * Fetch CI error logs from GitHub Actions for a failed SHA.
   * Downloads actual job logs (not just annotations) to get real compiler errors.
   * Returns the combined error output, or null if unavailable.
   */
  private async fetchCIErrorLog(prNumber: number, sha: string): Promise<string | null> {
    const { owner, repo } = this.config;
    try {
      // Find the workflow run for this SHA
      const runsUrl = `${API_BASE}/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=5`;
      const runsResp = await fetch(runsUrl, { headers: this.headers });
      if (!runsResp.ok) return null;

      const runsData = (await runsResp.json()) as {
        workflow_runs?: Array<{ id: number; conclusion: string }>;
      };
      const failedWorkflow = (runsData.workflow_runs ?? []).find((r) => r.conclusion === "failure");
      if (!failedWorkflow) return null;

      // Get jobs for the failed workflow
      const jobsUrl = `${API_BASE}/repos/${owner}/${repo}/actions/runs/${failedWorkflow.id}/jobs`;
      const jobsResp = await fetch(jobsUrl, { headers: this.headers });
      if (!jobsResp.ok) return null;

      const jobsData = (await jobsResp.json()) as {
        jobs?: Array<{ id: number; name: string; conclusion: string }>;
      };
      const failedJobs = (jobsData.jobs ?? []).filter((j) => j.conclusion === "failure");
      if (failedJobs.length === 0) return null;

      // Download logs from the first failed job
      const failedJob = failedJobs[0];
      const logUrl = `${API_BASE}/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`;
      const logResp = await fetch(logUrl, {
        headers: this.headers,
        redirect: "follow",
      });
      if (!logResp.ok) {
        this.logger.warn("merge-daemon", `PR #${prNumber}: Failed to download job logs (${logResp.status})`);
        return null;
      }

      const fullLog = await logResp.text();
      const lines = fullLog.split("\n");

      // Extract error lines with context — look for compiler errors, build failures
      const errorPattern = /error\[E\d+\]|^error:|cannot find|not found|expected .* found|no method named|mismatched types|missing field|unresolved import|failed to compile/i;
      const contextLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        // Strip ANSI codes and timestamps for cleaner output
        const clean = lines[i].replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
        if (errorPattern.test(clean)) {
          // Include 2 lines before and 5 lines after for context
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 6);
          for (let j = start; j < end; j++) {
            const ctx = lines[j].replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
            if (!contextLines.includes(ctx)) {
              contextLines.push(ctx);
            }
          }
        }
      }

      if (contextLines.length > 0) {
        this.logger.info("merge-daemon", `PR #${prNumber}: Extracted ${contextLines.length} error lines from CI logs`);
        return contextLines.slice(0, 150).join("\n");
      }

      // Fallback: last 80 lines
      return lines.slice(-80).map((l) =>
        l.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, ""),
      ).join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("merge-daemon", `PR #${prNumber}: Error fetching CI logs: ${msg}`);
      return null;
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
