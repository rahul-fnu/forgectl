/**
 * Core PR processing pipeline for the review/merge daemon.
 * Fetches open forge/* PRs and processes them sequentially:
 * rebase → resolve conflicts → validate → fix build → enrich PR description → review (approve/request changes) → wait CI → merge.
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
import type { ReviewMetricsRepository } from "../storage/repositories/review-metrics.js";
import type { ReviewFindingsRepository } from "../storage/repositories/review-findings.js";
import { extractAcceptanceCriteria } from "../github/pr-description.js";
import { fetchCIErrorLog } from "../github/ci-logs.js";
import { load as yamlLoad } from "js-yaml";

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
  suggested_fix?: string;
}

export interface StructuredReview {
  summary: string;
  approval: "approve" | "request_changes";
  comments: InlineReviewComment[];
}

export function parseStructuredReview(raw: string): StructuredReview | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Step 1: Unwrap Claude --output-format json envelope if present
  const unwrapped = unwrapClaudeEnvelope(trimmed);

  // Step 2: Try to extract JSON from markdown fences
  const candidates = extractJsonCandidates(unwrapped);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate)
      ?? tryParseJson(cleanJsonText(candidate, false))
      ?? tryParseJson(cleanJsonText(candidate, true));
    if (parsed) return buildReview(parsed);
  }

  // Step 3: YAML fallback — try parsing as YAML
  const yamlResult = tryParseYaml(unwrapped);
  if (yamlResult) return buildReview(yamlResult);

  // Step 4: Line-by-line field extraction
  const lineByLine = extractFieldsFromText(unwrapped);
  if (lineByLine) return lineByLine;

  // Step 5: Keyword-based extraction
  const lower = unwrapped.toLowerCase();
  if (lower.includes("request_changes") || lower.includes("must_fix")) {
    return { summary: unwrapped.slice(0, 200), approval: "request_changes", comments: [] };
  }
  if (lower.includes("approve")) {
    return { summary: unwrapped.slice(0, 200), approval: "approve", comments: [] };
  }

  return undefined;
}

function unwrapClaudeEnvelope(text: string): string {
  const parsed = tryParseJson(text);
  if (!parsed) return text;
  // Claude --output-format json wraps in {"type":"result","result":"..."} or {"result":"..."}
  if (typeof parsed.result === "string") {
    return parsed.result.trim();
  }
  // If the envelope itself contains review fields, use it directly
  if (parsed.summary !== undefined || parsed.approval !== undefined) {
    return text;
  }
  return text;
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  // The full text itself
  candidates.push(text);
  // Extract from markdown fences (try all fence blocks)
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }
  // Extract JSON object from surrounding prose (first { to last })
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.substring(firstBrace, lastBrace + 1));
  }
  return candidates;
}

function cleanJsonText(text: string, replaceSingleQuotes: boolean): string {
  // Strip markdown fence lines
  let cleaned = text.replace(/^```(?:json)?\s*$/gm, "").replace(/^```\s*$/gm, "");
  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  // Only replace single quotes as last resort (can corrupt apostrophes in text)
  if (replaceSingleQuotes) {
    cleaned = cleaned.replace(/'/g, '"');
  }
  return cleaned.trim();
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch { /* ignore */ }
  return undefined;
}

function tryParseYaml(text: string): Record<string, unknown> | undefined {
  // Strip markdown fences first
  let yamlText = text;
  const fenceMatch = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(text);
  if (fenceMatch) {
    yamlText = fenceMatch[1].trim();
  } else {
    // Remove any leading prose before YAML-like content
    const yamlStart = /^(summary|approval|comments)\s*:/m.exec(yamlText);
    if (yamlStart) {
      yamlText = yamlText.substring(yamlStart.index);
    }
  }
  try {
    const obj = yamlLoad(yamlText);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      if (rec.summary !== undefined || rec.approval !== undefined) {
        return rec;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function extractFieldsFromText(text: string): StructuredReview | undefined {
  const summaryMatch = /"summary"\s*:\s*"([^"]*)"/.exec(text);
  const approvalMatch = /"approval"\s*:\s*"([^"]*)"/.exec(text);
  if (!summaryMatch && !approvalMatch) return undefined;

  const summary = summaryMatch?.[1] ?? "No summary";
  const approvalRaw = approvalMatch?.[1] ?? "";
  const approval = approvalRaw === "request_changes" ? "request_changes" as const : "approve" as const;
  return { summary, approval, comments: [] };
}

function buildReview(obj: Record<string, unknown>): StructuredReview {
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
      const suggested_fix = typeof c.suggested_fix === "string" ? c.suggested_fix : undefined;
      if (!file || !line || !body) continue;
      const severity = (sev === "must_fix" || sev === "should_fix" || sev === "nit") ? sev : "nit";
      comments.push({ file, line, severity, body, ...(suggested_fix ? { suggested_fix } : {}) });
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

export interface ReviewFailureState {
  attempts: number;
  lastFailure: string;
  lastAttemptAt: number;
}

export class PRProcessor {
  private headers: Record<string, string>;
  private readonly history: ProcessResult[] = [];
  private readonly reviewRounds = new Map<number, number>();
  private readonly reviewFailures = new Map<number, ReviewFailureState>();
  /** Tracks the last SHA we reviewed for each PR — only re-review if SHA changed */
  private readonly lastReviewedSha = new Map<number, string>();
  /** Tracks the last review verdict per PR — persists across poll cycles */
  private readonly lastReviewVerdict = new Map<number, "approve" | "request_changes">();

  constructor(
    private config: PRProcessorConfig,
    private readonly logger: Logger,
    private readonly metricsRepo?: ReviewMetricsRepository,
    private readonly findingsRepo?: ReviewFindingsRepository,
  ) {
    this.headers = {
      Authorization: `token ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    };
  }

  /**
   * Update the token used for GitHub API calls (e.g. after refresh).
   */
  updateToken(token: string, rawToken?: string): void {
    this.config = { ...this.config, token, rawToken: rawToken ?? token };
    this.headers = {
      Authorization: `token ${token}`,
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

      // Step 4: Enrich PR description with ticket context
      await this.enrichPRDescription(pr, tmpDir);

      // Step 5: Review diff (optional) — post review, block on request_changes
      if (this.config.enableReview) {
        // Check if PR already has needs-manual-review label (e.g. from a previous daemon run)
        const hasManualLabel = await this.hasLabel(pr.number, "needs-manual-review");
        if (hasManualLabel) {
          this.logger.info("merge-daemon", `PR #${pr.number}: Skipping review — already labeled needs-manual-review`);
          return this.recordResult(pr, "skipped", "Escalated for manual review");
        }

        // Check if we already reviewed this exact SHA and requested changes.
        // If SHA hasn't changed since last review, the old verdict still stands — don't re-review.
        const previousSha = this.lastReviewedSha.get(pr.number);
        const previousVerdict = this.lastReviewVerdict.get(pr.number);
        if (previousSha === pr.sha && previousVerdict === "request_changes") {
          this.logger.info("merge-daemon", `PR #${pr.number}: SHA unchanged since last review (changes still requested) — auto-addressing`);
          // Re-run self-addressing on the existing branch
          const review = await this.reviewDiff(tmpDir, pr);
          if (review && review.approval === "request_changes") {
            const reviewRound = this.reviewRounds.get(pr.number) ?? 0;
            if (reviewRound >= 3) {
              await this.postComment(pr.number, `**forgectl review:** Changes still requested after ${reviewRound} rounds. Escalating for manual review.`);
              return this.recordResult(pr, "request_changes", `Escalated after ${reviewRound} rounds`);
            }
            const fixed = await this.addressReviewComments(tmpDir, pr, review);
            if (fixed) {
              return this.recordResult(pr, "request_changes", `Self-addressed round ${reviewRound + 1}, awaiting re-review`);
            }
          }
          return this.recordResult(pr, "request_changes", "Changes requested, SHA unchanged, auto-address failed");
        }

        // Try review up to 2 times (Claude may produce non-JSON on first attempt)
        let review: StructuredReview | undefined;
        for (let reviewAttempt = 1; reviewAttempt <= 2; reviewAttempt++) {
          review = await this.reviewDiff(tmpDir, pr);
          if (review) break;
          if (reviewAttempt < 2) {
            this.logger.info("merge-daemon", `PR #${pr.number}: Review parse failed, retrying (attempt ${reviewAttempt + 1})`);
          }
        }

        // Track SHA and verdict for this review
        this.lastReviewedSha.set(pr.number, pr.sha);

        if (review) {
          this.lastReviewVerdict.set(pr.number, review.approval);
          this.reviewFailures.delete(pr.number);
          this.recordParseResult(pr, true);

          if (review.approval === "request_changes") {
            const reviewRound = this.reviewRounds.get(pr.number) ?? 0;
            if (reviewRound >= 3) {
              this.logger.info("merge-daemon", `PR #${pr.number}: Review requested changes after ${reviewRound} rounds — escalating`);
              await this.postComment(pr.number, `**forgectl review:** Changes requested after ${reviewRound} review rounds. Escalating for manual review.`);
              return this.recordResult(pr, "request_changes", `Escalated after ${reviewRound} rounds: ${review.summary}`);
            }

            // Self-address: use Claude to fix the review comments on the branch
            this.logger.info("merge-daemon", `PR #${pr.number}: Review requested changes (${review.comments.length} comments, round ${reviewRound + 1}/3) — auto-addressing`);
            const fixed = await this.addressReviewComments(tmpDir, pr, review);
            if (fixed) {
              this.logger.info("merge-daemon", `PR #${pr.number}: Review comments addressed, pushed fixes`);
              // Re-review will happen on next poll cycle (new SHA triggers re-review)
              return this.recordResult(pr, "request_changes", `Self-addressed round ${reviewRound + 1}, awaiting re-review`);
            } else {
              this.logger.warn("merge-daemon", `PR #${pr.number}: Could not auto-address review comments — leaving for manual review`);
              return this.recordResult(pr, "request_changes", review.summary);
            }
          }
          // Approved — log non-blocking comments if any
          if (review.comments.length > 0) {
            this.logger.info("merge-daemon", `PR #${pr.number}: Approved with ${review.comments.length} comment(s), proceeding to merge`);
          }
        } else {
          // Record parse failure
          this.recordParseResult(pr, false);
          const current = this.reviewFailures.get(pr.number) ?? { attempts: 0, lastFailure: "", lastAttemptAt: 0 };
          current.attempts++;
          current.lastFailure = "Review output parsing failed";
          current.lastAttemptAt = Date.now();
          this.reviewFailures.set(pr.number, current);

          if (current.attempts >= 3) {
            // Escalate: comment + label + skip on future polls
            this.logger.warn("merge-daemon", `PR #${pr.number}: Review failed ${current.attempts} times — escalating for manual review`);
            await this.postComment(pr.number, `**forgectl review:** Review daemon unable to review this PR after ${current.attempts} attempts. Escalating for manual review.`);
            await this.addLabel(pr.number, "needs-manual-review");
            return this.recordResult(pr, "skipped", "Escalated for manual review after persistent parse failures");
          }

          // Not yet at threshold — skip this cycle, retry next poll
          this.logger.warn("merge-daemon", `PR #${pr.number}: Review failed after retries (${current.attempts}/3) — skipping (will retry next poll)`);
          await this.postComment(pr.number, `**forgectl review:** Automated review could not be completed (output parsing failed). Will retry on next poll cycle.`);
          this.checkParseFailureRate();
          return this.recordResult(pr, "skipped", "Review failed after retries");
        }
      }

      // Step 6+7: Wait for CI then merge, with retry on failure
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
   * Address review comments by invoking Claude to fix the flagged issues.
   * Returns true if fixes were committed and pushed.
   */
  async addressReviewComments(tmpDir: string, pr: PRInfo, review: StructuredReview): Promise<boolean> {
    try {
      const { writeFileSync: ws } = await import("node:fs");

      // Build a prompt with all review comments
      const commentList = review.comments.map((c, i) =>
        `${i + 1}. [${c.severity.toUpperCase()}] ${c.file}:${c.line} — ${c.body}${c.suggested_fix ? `\n   Suggested fix: ${c.suggested_fix}` : ""}`
      ).join("\n\n");

      const prompt = [
        `A code review has requested changes on this branch. Address ALL of the following review comments:`,
        ``,
        commentList,
        ``,
        `Rules:`,
        `- Read each flagged file before making changes`,
        `- Address EVERY comment listed above — do not skip any`,
        `- Follow the suggested fixes when provided`,
        `- Make minimal changes — only fix what the review flagged`,
        `- Run the build and tests after making changes to verify nothing breaks`,
        `- Stage all changes with git add`,
      ].join("\n");

      const promptFile = `${tmpDir}/.forgectl-address-review.txt`;
      ws(promptFile, prompt);

      execSync(
        `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 15`,
        { cwd: tmpDir, encoding: "utf-8", timeout: 300_000 },
      );

      // Check if Claude made changes
      const status = execSync(`git status --porcelain`, { cwd: tmpDir, encoding: "utf-8" }).trim();
      if (!status) {
        this.logger.warn("merge-daemon", `PR #${pr.number}: Claude made no changes when addressing review`);
        return false;
      }

      // Commit and push
      execSync(`git add -A`, { cwd: tmpDir, stdio: "pipe" });
      execSync(`git commit -m "fix: address review comments (forgectl review daemon)"`, { cwd: tmpDir, stdio: "pipe" });
      execSync(`git push origin "${pr.branch}" --force`, { cwd: tmpDir, stdio: "pipe" });

      await this.postComment(pr.number,
        `**forgectl review daemon:** Addressed ${review.comments.length} review comment(s). Pushed fixes — awaiting re-review.`
      );

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("merge-daemon", `PR #${pr.number}: Failed to address review comments: ${msg}`);
      return false;
    }
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
        `You are a code reviewer. Review PR #${pr.number}: "${pr.title}".`,
        ``,
        ...(prDescription ? [`PR description:`, prDescription, ``] : []),
        `<diff>`,
        diff,
        `</diff>`,
        ``,
        `Check for: correctness bugs, security issues (injection, path traversal), missing error handling, missing tests for new code, unused imports.`,
        `Do NOT flag: .gitignore changes, binary files, formatting, boilerplate.`,
        ``,
        `Severity: must_fix (blocks merge: bugs, security, data loss), should_fix (edge cases, weak error handling), nit (style).`,
        `Set "approval" to "request_changes" ONLY if there are must_fix issues. Otherwise "approve".`,
        ``,
        `Respond with ONLY this JSON object, no other text:`,
        `{"summary": "<one sentence>", "approval": "approve", "comments": [{"file": "src/example.ts", "line": 1, "severity": "nit", "body": "description", "suggested_fix": "optional fix"}]}`,
      ].join("\n");

      const promptFile = `${tmpDir}/.forgectl-review-prompt.txt`;
      ws(promptFile, prompt);
      const output = execSync(
        `cat "${promptFile}" | claude -p - --output-format json --dangerously-skip-permissions --max-turns 1`,
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

      // Record review metrics
      this.recordReviewMetrics(pr, review);

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

    // Build the review body with all comments included as a formatted list
    const commentLines = review.comments.map((c) => {
      let line = `- **[${c.severity.toUpperCase()}]** \`${c.file}:${c.line}\` — ${c.body}`;
      if (c.suggested_fix) {
        line += `\n  **Suggested fix:** ${c.suggested_fix}`;
      }
      return line;
    });

    const verdict = review.approval === "approve" ? "LGTM" : "Changes requested";
    const fullBody = [
      `## Review by forgectl`,
      ``,
      `**Verdict:** ${verdict}`,
      ``,
      review.summary,
      ``,
      ...(commentLines.length > 0 ? [`### Comments`, ``, ...commentLines] : []),
    ].join("\n");

    // Try to submit as a formal review first.
    // Use COMMENT event instead of REQUEST_CHANGES to avoid "can't request changes on own PR" error.
    // The review body clearly states whether it's an approval or has requested changes.
    const event = review.approval === "approve" ? "APPROVE" : "COMMENT";

    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        event,
        body: fullBody,
        // Skip inline comments — line positions in the diff are unreliable.
        // All comments are included in the review body instead.
        comments: [],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(
        "merge-daemon",
        `PR #${prNumber}: Failed to submit review (${response.status}): ${text}`,
      );
      // Fallback: post as a regular PR comment
      const commentUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
      const commentResp = await fetch(commentUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ body: fullBody }),
      });
      if (commentResp.ok) {
        this.logger.info("merge-daemon", `PR #${prNumber}: Review posted as comment (fallback)`);
      }
    } else {
      this.logger.info("merge-daemon", `PR #${prNumber}: Review submitted — ${verdict}`);
    }
  }

  /**
   * Fetch full PR data from the API (body, issue refs, etc.).
   */
  private async fetchPRFull(prNumber: number): Promise<{
    body?: string | null;
    head?: { sha?: string };
    merged?: boolean;
    merged_by?: { login?: string };
    mergeable_state?: string;
    mergeable?: boolean;
  } | null> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
    try {
      const resp = await fetch(url, { headers: this.headers });
      if (resp.ok) return (await resp.json()) as any;
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Fetch a PR's description body from the API.
   */
  private async fetchPRDescription(prNumber: number): Promise<string | null> {
    const data = await this.fetchPRFull(prNumber);
    return data?.body ?? null;
  }

  /**
   * Fetch linked issue data from GitHub.
   * Tries to extract issue number from PR title (e.g. "RAH-42", "#42") or branch name.
   */
  private async fetchLinkedIssue(pr: PRInfo): Promise<{
    number: number;
    title: string;
    body: string | null;
  } | null> {
    const { owner, repo } = this.config;

    // Try to extract issue number from title (#NN) or branch (forge/NN-*)
    const titleMatch = /#(\d+)/.exec(pr.title);
    const branchMatch = /\/(\d+)[-_]/.exec(pr.branch) ?? /\/[A-Z]+-(\d+)/.exec(pr.branch);
    const issueNum = titleMatch?.[1] ?? branchMatch?.[1];

    if (!issueNum) return null;

    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${issueNum}`;
    try {
      const resp = await fetch(url, { headers: this.headers });
      if (resp.ok) {
        const data = (await resp.json()) as { number: number; title: string; body?: string | null };
        return { number: data.number, title: data.title, body: data.body ?? null };
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Enrich the PR description with full ticket context, diff stats, and acceptance criteria.
   * Only updates if the PR body is empty or was previously generated by forgectl.
   */
  async enrichPRDescription(pr: PRInfo, tmpDir: string): Promise<void> {
    const { owner, repo } = this.config;

    try {
      const existingBody = await this.fetchPRDescription(pr.number);

      // Skip if a human wrote the description (non-empty, no forgectl marker)
      if (existingBody && existingBody.trim() !== "" && !existingBody.includes("<!-- forgectl-generated -->")) {
        return;
      }

      const issue = await this.fetchLinkedIssue(pr);

      // Get diff stat
      let diffStat = "";
      try {
        diffStat = execSync("git diff --stat origin/main...HEAD", {
          cwd: tmpDir,
          encoding: "utf-8",
          timeout: 30_000,
        }).trim();
      } catch { /* ignore */ }

      // Get changed file list
      let changedFiles: string[] = [];
      try {
        changedFiles = execSync("git diff --name-only origin/main...HEAD", {
          cwd: tmpDir,
          encoding: "utf-8",
          timeout: 30_000,
        }).trim().split("\n").filter(Boolean);
      } catch { /* ignore */ }

      const lines: string[] = [];
      lines.push("<!-- forgectl-generated -->");
      lines.push("");

      if (issue) {
        lines.push(`Closes #${issue.number}`);
        lines.push("");
        lines.push("## Context");
        lines.push(`**Issue:** #${issue.number} — ${issue.title}`);
        lines.push(`**Repo:** ${owner}/${repo}`);
        lines.push("");

        if (issue.body) {
          lines.push("## Requirements (from ticket)");
          lines.push("");
          lines.push(issue.body);
          lines.push("");

          const ac = extractAcceptanceCriteria(issue.body);
          if (ac) {
            lines.push("## Acceptance Criteria");
            lines.push("");
            lines.push(ac);
            lines.push("");
          }
        }
      } else {
        lines.push(`**Repo:** ${owner}/${repo}`);
        lines.push("");
      }

      lines.push("## Changes");
      lines.push("");
      if (diffStat) {
        lines.push("```");
        lines.push(diffStat);
        lines.push("```");
        lines.push("");
      }
      for (const f of changedFiles.slice(0, 30)) {
        lines.push(`- \`${f}\``);
      }
      if (changedFiles.length > 30) {
        lines.push(`- _...and ${changedFiles.length - 30} more files_`);
      }
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push("_Generated by [forgectl](https://github.com/forgectl/forgectl)_");

      const body = lines.join("\n");
      const updateUrl = `${API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}`;
      await fetch(updateUrl, {
        method: "PATCH",
        headers: this.headers,
        body: JSON.stringify({ body }),
      });

      this.logger.info("merge-daemon", `PR #${pr.number}: Updated description with ticket context`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("merge-daemon", `PR #${pr.number}: Failed to enrich PR description: ${msg}`);
    }
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
    const errorLog = await this.fetchCIErrorLogWrapped(pr.number, failedSha);
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

  private async fetchCIErrorLogWrapped(prNumber: number, sha: string): Promise<string | null> {
    const { owner, repo } = this.config;
    const result = await fetchCIErrorLog(owner, repo, sha, this.headers);
    if (result) {
      this.logger.info("merge-daemon", `PR #${prNumber}: Extracted error lines from CI logs`);
    }
    return result;
  }

  /** Fetch PR data from the API. */
  private async fetchPRData(prNumber: number): Promise<{ head?: { sha?: string } } | null> {
    return this.fetchPRFull(prNumber);
  }

  /** Add a label to a PR. */
  private async addLabel(prNumber: number, label: string): Promise<void> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`;
    await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ labels: [label] }),
    }).catch((err) => {
      this.logger.warn("merge-daemon", `PR #${prNumber}: Failed to add label '${label}': ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Check if a PR has a specific label. */
  private async hasLabel(prNumber: number, label: string): Promise<boolean> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`;
    try {
      const resp = await fetch(url, { headers: this.headers });
      if (!resp.ok) return false;
      const labels = (await resp.json()) as Array<{ name?: string }>;
      return labels.some((l) => l.name === label);
    } catch {
      return false;
    }
  }

  /** Record a parse success/failure in metrics. */
  private recordParseResult(pr: PRInfo, success: boolean): void {
    if (this.metricsRepo) {
      const { owner, repo } = this.config;
      try {
        this.metricsRepo.recordParseResult(`${owner}/${repo}`, pr.number, success);
      } catch (err) {
        this.logger.warn("merge-daemon", `PR #${pr.number}: Failed to record parse result: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Check recent parse failure rate across all tracked PRs.
   * If >50% of the last 10 results are failures, log a warning.
   */
  private checkParseFailureRate(): void {
    if (this.metricsRepo) {
      const { owner, repo } = this.config;
      const stats = this.metricsRepo.computeStats(`${owner}/${repo}`);
      const total = stats.parseFailureCount + stats.parseSuccessCount;
      if (total >= 10 && stats.parseSuccessRate < 0.5) {
        this.logger.warn(
          "merge-daemon",
          `Parse failure rate is ${((1 - stats.parseSuccessRate) * 100).toFixed(0)}% over ${total} reviews — consider tuning the review prompt`,
        );
      }
    }
  }

  /** Post a comment on a PR. */
  private async postComment(prNumber: number, body: string): Promise<void> {
    const { owner, repo } = this.config;
    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
    await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ body }),
    }).catch((err) => {
      this.logger.warn("merge-daemon", `PR #${prNumber}: Failed to post comment: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private recordReviewMetrics(pr: PRInfo, review: StructuredReview): void {
    const round = (this.reviewRounds.get(pr.number) ?? 0) + 1;
    this.reviewRounds.set(pr.number, round);

    const mustFix = review.comments.filter(c => c.severity === "must_fix").length;
    const shouldFix = review.comments.filter(c => c.severity === "should_fix").length;
    const nit = review.comments.filter(c => c.severity === "nit").length;

    if (this.metricsRepo) {
      const { owner, repo } = this.config;
      this.metricsRepo.upsert({
        repo: `${owner}/${repo}`,
        prNumber: pr.number,
        reviewRound: round,
        reviewCommentsCount: review.comments.length,
        reviewMustFix: mustFix,
        reviewShouldFix: shouldFix,
        reviewNit: nit,
        reviewApprovedRound: review.approval === "approve" ? round : undefined,
        reviewEscalated: review.approval === "request_changes" && mustFix > 0,
      });
    }

    // Accumulate findings into the review_findings table
    if (this.findingsRepo) {
      for (const comment of review.comments) {
        const parts = comment.file.split("/");
        const module = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0] || "*";
        this.findingsRepo.upsertFinding({
          category: comment.severity,
          pattern: comment.severity,
          module,
          exampleComment: comment.body,
        });
      }
      this.findingsRepo.promoteEligible();
    }
  }

  private recordResult(pr: PRInfo, status: ProcessResult["status"], error?: string): ProcessResult {
    const result: ProcessResult = { prNumber: pr.number, branch: pr.branch, status, error };
    this.history.push(result);
    // Clean up tracking state on terminal outcomes
    if (status === "merged" || status === "failed") {
      this.lastReviewedSha.delete(pr.number);
      this.lastReviewVerdict.delete(pr.number);
      this.reviewRounds.delete(pr.number);
    }
    // Keep last 100 results
    if (this.history.length > 100) this.history.shift();

    // Update final outcome in review metrics
    if (this.metricsRepo) {
      const { owner, repo } = this.config;
      const fullRepo = `${owner}/${repo}`;
      const outcome = status === "request_changes" ? "escalated" : status;
      this.metricsRepo.updateOutcome(fullRepo, pr.number, outcome);
    }

    return result;
  }

  /**
   * Check if a PR was merged by a human after the review daemon requested changes.
   * If so, mark those review comments as potential false positives.
   */
  async detectFalsePositives(prNumber: number): Promise<boolean> {
    if (!this.metricsRepo) return false;

    const { owner, repo } = this.config;
    const fullRepo = `${owner}/${repo}`;
    const metrics = this.metricsRepo.findByPR(fullRepo, prNumber);
    if (metrics.length === 0) return false;

    // Check if any round had request_changes (must_fix > 0)
    const hadRequestChanges = metrics.some(m => m.reviewMustFix > 0 || m.reviewShouldFix > 0);
    if (!hadRequestChanges) return false;

    // Check if PR was merged externally (not by the merge daemon)
    const prData = await this.fetchPRFull(prNumber);
    if (!prData?.merged) return false;

    // If the PR is merged but the daemon didn't merge it (last outcome is "escalated" or no "merged" outcome)
    const lastOutcome = metrics[metrics.length - 1]?.finalOutcome;
    if (lastOutcome === "merged") return false; // Daemon merged it, not a false positive

    this.metricsRepo.markHumanOverride(fullRepo, prNumber);

    // Also record calibration data in findings repo
    if (this.findingsRepo) {
      const totalComments = metrics.reduce((s, m) => s + m.reviewCommentsCount, 0);
      this.findingsRepo.recordCalibration(`${owner}/${repo}`, totalComments, totalComments);
    }

    this.logger.info("merge-daemon", `PR #${prNumber}: Detected human override — marked as potential false positive`);
    return true;
  }

  /** Get processing history. */
  getHistory(): readonly ProcessResult[] {
    return this.history;
  }

  /** Get review failure states for all PRs. */
  getReviewFailures(): ReadonlyMap<number, ReviewFailureState> {
    return this.reviewFailures;
  }
}
