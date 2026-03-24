import type { TrackerAdapter, TrackerConfig, TrackerIssue } from "./types.js";
import { resolveToken } from "./token.js";
import { SubIssueCache } from "./sub-issue-cache.js";
import { detectIssueCycles } from "./sub-issue-dag.js";
import { MergeQueue } from "../orchestrator/merge-queue.js";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const API_BASE = "https://api.github.com";
const RATE_LIMIT_WARNING_THRESHOLD = 100;

interface GitHubLabel {
  name: string;
}

interface GitHubAssignee {
  login: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: GitHubLabel[];
  assignees: GitHubAssignee[];
  html_url: string;
  created_at: string;
  updated_at: string;
  reactions?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
}

/**
 * Extract priority from labels.
 * Looks for "priority:X" or "P0"/"P1"/etc patterns.
 */
function extractPriority(labels: GitHubLabel[]): string | null {
  for (const label of labels) {
    const colonMatch = label.name.match(/^priority:(.+)$/i);
    if (colonMatch) {
      return colonMatch[1];
    }
    if (/^P\d$/i.test(label.name)) {
      return label.name;
    }
  }
  return null;
}

/**
 * Normalize a GitHub issue JSON object to TrackerIssue.
 * Returns null for pull requests (items with pull_request key).
 *
 * id is set to ghIssue.number (the API-addressable issue number),
 * not ghIssue.id (GitHub's internal numeric ID).
 *
 * Optional subIssues param: if provided, populates blocked_by from child
 * issue numbers (excluding PRs). Also always stores ghInternalId (SUBISSUE-02).
 */
function normalizeIssue(ghIssue: GitHubIssue, subIssues?: GitHubIssue[]): TrackerIssue | null {
  if (ghIssue.pull_request) {
    return null;
  }

  const metadata: Record<string, unknown> = {
    ghInternalId: ghIssue.id,
  };
  if (ghIssue.reactions) {
    metadata.reactions = ghIssue.reactions;
  }

  const blockedBy = subIssues
    ? subIssues.filter((s) => !s.pull_request).map((s) => String(s.number))
    : [];

  return {
    id: String(ghIssue.number),
    identifier: `#${ghIssue.number}`,
    title: ghIssue.title,
    description: ghIssue.body ?? "",
    state: ghIssue.state,
    priority: extractPriority(ghIssue.labels),
    labels: ghIssue.labels.map((l) => l.name),
    assignees: ghIssue.assignees.map((a) => a.login),
    url: ghIssue.html_url,
    created_at: ghIssue.created_at,
    updated_at: ghIssue.updated_at,
    blocked_by: blockedBy,
    metadata,
  };
}

/**
 * Parse a Link header and extract the URL with rel="next".
 */
function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Parse an issue ID or identifier (e.g. "42" or "#42") to a number.
 * Throws on invalid input.
 */
function parseIssueNumber(idOrIdentifier: string): number {
  const stripped = idOrIdentifier.replace(/^#/, "");
  const num = parseInt(stripped, 10);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid issue number: "${idOrIdentifier}"`);
  }
  return num;
}

/**
 * Create a GitHub Issues TrackerAdapter.
 */
/**
 * Sanitize Claude's merge output before writing it to a file.
 * Returns cleaned content, or null if the output is invalid.
 */
function sanitizeMergeOutput(raw: string, filename: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  // Reject obvious error messages
  if (/^error:/i.test(text) || text.startsWith("Error: Reached max turns")) return null;
  if (text.startsWith("I ") || text.startsWith("Here ") || text.startsWith("The merged")) return null;

  // Strip ALL markdown code fences — opening and closing, anywhere in the text.
  // Claude sometimes wraps output in ```lang ... ``` even when told not to.
  // Match opening fence at start of a line: ```optional-lang
  text = text.replace(/^```\w*\r?\n/gm, "");
  // Match closing fence at start of a line: ```
  text = text.replace(/^```\s*$/gm, "");
  text = text.trim();

  if (!text) return null;

  // Validate file-type-specific syntax as a sanity check
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "toml" && !text.includes("[")) return null;
  if (ext === "json" && !text.startsWith("{") && !text.startsWith("[")) return null;
  if (ext === "rs" && !text.includes("fn ") && !text.includes("mod ") && !text.includes("use ") && !text.includes("struct ")) return null;

  // Final check: reject if it still contains code fence markers
  if (/^```/m.test(text)) return null;

  return text + "\n";
}

/**
 * Resolve merge conflicts on a PR branch using Claude Code, then merge.
 * Clones the repo, merges main into the branch with Claude resolving conflicts,
 * force-pushes the resolved branch, and retries the merge.
 */
async function resolveAndMerge(
  owner: string,
  repo: string,
  branch: string,
  prNumber: number,
  ghToken: string,
  rawToken: string,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "forgectl-conflict-"));
  const repoUrl = `https://x-access-token:${resolveToken(rawToken)}@github.com/${owner}/${repo}.git`;

  try {
    // Clone and checkout the PR branch
    execFileSync("git", ["clone", "--depth=50", repoUrl, "."], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "forgectl"], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "forge@localhost"], { cwd: tmpDir, stdio: "pipe" });
    execFileSync("git", ["checkout", branch], { cwd: tmpDir, stdio: "pipe" });

    // Try merging main into the branch
    try {
      execFileSync("git", ["merge", "origin/main", "--no-edit"], { cwd: tmpDir, stdio: "pipe" });
      // No conflicts — just push
    } catch {
      // Get conflicted files
      const conflictOutput = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: tmpDir,
        encoding: "utf-8",
      }).trim();

      if (!conflictOutput) return; // No conflicts found somehow

      const conflicts = conflictOutput.split("\n");

      for (const file of conflicts) {
        // Extract three-way versions
        let base = "", ours = "", theirs = "";
        try { base = execFileSync("git", ["show", `:1:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* new file */ }
        try { ours = execFileSync("git", ["show", `:2:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* deleted */ }
        try { theirs = execFileSync("git", ["show", `:3:${file}`], { cwd: tmpDir, encoding: "utf-8" }); } catch { /* deleted */ }

        // Use Claude to resolve
        const prompt = [
          `Merge these three versions of ${file}. Output ONLY the merged file content, no explanation.`,
          `=== BASE (common ancestor) ===`,
          base,
          `=== OURS (main branch) ===`,
          ours,
          `=== THEIRS (feature branch - new code to keep) ===`,
          theirs,
          `Rules: Include ALL content from both sides. Combine imports, merge function lists. Do not duplicate identical lines.`,
        ].join("\n");

        try {
          const promptFile = join(tmpDir, ".forgectl-merge-prompt.txt");
          writeFileSync(promptFile, prompt);
          const resolved = execFileSync(
            "claude",
            ["-p", "-", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "1"],
            { cwd: tmpDir, encoding: "utf-8", timeout: 60000, input: readFileSync(promptFile, "utf-8") },
          );
          // Sanitize Claude output before writing to file
          const cleaned = sanitizeMergeOutput(resolved, file);
          if (cleaned) {
            writeFileSync(join(tmpDir, file), cleaned);
          } else {
            execFileSync("git", ["checkout", "--theirs", file], { cwd: tmpDir, stdio: "pipe" });
          }
        } catch {
          execFileSync("git", ["checkout", "--theirs", file], { cwd: tmpDir, stdio: "pipe" });
        }
        execFileSync("git", ["add", file], { cwd: tmpDir, stdio: "pipe" });
      }

      // Post-resolve verification: ask Claude to review the merge result
      try {
        const diffOutput = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: tmpDir, encoding: "utf-8" });
        const changedFiles = conflicts.join(", ");
        const verifyPrompt = [
          `You just resolved merge conflicts in: ${changedFiles}`,
          `Here is the staged diff summary:\n${diffOutput}`,
          `Review the resolved files for these problems:`,
          `1. Markdown code fences (\`\`\`) that don't belong in source code`,
          `2. Duplicate function/struct/mod declarations`,
          `3. Missing imports or module declarations`,
          `4. Syntax errors (unclosed braces, missing semicolons)`,
          `5. Conflict markers (<<<<<<, ======, >>>>>>)`,
          ``,
          `For each file, run: cat <file> and check.`,
          `If you find problems, fix them and run: git add <file>`,
          `If everything looks clean, just say "LGTM".`,
        ].join("\n");
        const verifyFile = join(tmpDir, ".forgectl-verify-prompt.txt");
        writeFileSync(verifyFile, verifyPrompt);
        execFileSync(
          "claude",
          ["-p", "-", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "5"],
          { cwd: tmpDir, encoding: "utf-8", timeout: 120000, input: readFileSync(verifyFile, "utf-8") },
        );
      } catch {
        // Verification is best-effort — don't block the merge
      }

      execFileSync("git", ["commit", "--no-edit"], { cwd: tmpDir, stdio: "pipe" });
    }

    // Push the resolved branch
    execFileSync("git", ["push", "origin", branch, "--force"], { cwd: tmpDir, stdio: "pipe" });

    // Retry the merge via API
    const mergeUrl = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
    await fetch(mergeUrl, {
      method: "PUT",
      headers: {
        Authorization: `token ${ghToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: "squash" }),
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Wait for CI checks to pass on a PR, then merge. Resolves conflicts first if needed.
 * Polls check status every 30s for up to 15 minutes.
 */
async function autoMergeWithCI(
  owner: string,
  repo: string,
  branch: string,
  prNumber: number,
  ghToken: string,
  rawToken: string,
): Promise<void> {
  const headers = {
    Authorization: `token ${ghToken}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  };

  // Step 1: Check if PR is mergeable, resolve conflicts if not
  const prUrl = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const prData = await (await fetch(prUrl, { headers })).json() as { mergeable?: boolean; mergeable_state?: string; head?: { sha?: string } };

  if (prData.mergeable === false) {
    await resolveAndMerge(owner, repo, branch, prNumber, ghToken, rawToken);
  }

  // Step 2: Wait for CI checks to pass (poll every 30s, max 15 min)
  const headSha = prData.head?.sha;
  if (headSha) {
    const maxWaitMs = 15 * 60 * 1000;
    const pollMs = 30_000;
    const start = Date.now();
    let ciResolved = false;

    while (Date.now() - start < maxWaitMs) {
      const statusUrl = `${API_BASE}/repos/${owner}/${repo}/commits/${headSha}/check-runs`;
      const checks = await (await fetch(statusUrl, { headers })).json() as {
        check_runs?: Array<{ status: string; conclusion: string | null }>;
      };

      const runs = checks.check_runs ?? [];
      if (runs.length === 0) {
        // No CI configured — proceed to merge
        ciResolved = true;
        break;
      }

      const allComplete = runs.every((r) => r.status === "completed");
      if (allComplete) {
        const allPassed = runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped");
        if (!allPassed) {
          // CI failed — leave PR open with comment, do NOT merge
          const commentUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
          await fetch(commentUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ body: "**forgectl:** CI checks failed. Leaving PR open for manual review." }),
          }).catch(() => {});
          return;
        }
        ciResolved = true;
        break;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    // CI polling timed out — leave PR open, do NOT merge
    if (!ciResolved) {
      const commentUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
      await fetch(commentUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "**forgectl:** CI checks timed out after 15 minutes. Leaving PR open for manual review." }),
      }).catch(() => {});
      return;
    }
  }

  // Step 3: Merge — if merge API fails, try conflict resolution then re-wait for CI
  const mergeUrl = `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
  const mergeResponse = await fetch(mergeUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ merge_method: "squash" }),
  });

  if (!mergeResponse.ok) {
    // Merge failed (likely conflicts with main) — resolve and retry
    try {
      await resolveAndMerge(owner, repo, branch, prNumber, ghToken, rawToken);
      // resolveAndMerge force-pushed resolved branch and retried merge API internally.
      // The internal merge may fail if CI hasn't run on the new head yet.
      // Re-check: fetch new head SHA and wait for CI before final merge attempt.
      const prRefetch = await (await fetch(prUrl, { headers })).json() as { head?: { sha?: string } };
      const newSha = prRefetch.head?.sha;
      if (newSha && newSha !== headSha) {
        // New head from conflict resolution — wait for CI on it
        const ciMaxWait = 15 * 60 * 1000;
        const ciPoll = 30_000;
        const ciStart = Date.now();
        let ciOk = false;

        while (Date.now() - ciStart < ciMaxWait) {
          const checksUrl = `${API_BASE}/repos/${owner}/${repo}/commits/${newSha}/check-runs`;
          const checks = await (await fetch(checksUrl, { headers })).json() as {
            check_runs?: Array<{ status: string; conclusion: string | null }>;
          };
          const runs = checks.check_runs ?? [];
          if (runs.length === 0) { ciOk = true; break; }
          const allDone = runs.every((r) => r.status === "completed");
          if (allDone) {
            ciOk = runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped");
            break;
          }
          await new Promise((r) => setTimeout(r, ciPoll));
        }

        if (ciOk) {
          // CI passed on resolved branch — final merge attempt
          await fetch(mergeUrl, {
            method: "PUT",
            headers,
            body: JSON.stringify({ merge_method: "squash" }),
          });
        } else {
          const commentUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
          await fetch(commentUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ body: "**forgectl:** Conflicts resolved but CI failed on rebased branch. Leaving PR open." }),
          }).catch(() => {});
        }
      }
    } catch {
      // Conflict resolution itself failed — leave PR open with comment
      const commentUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
      await fetch(commentUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "**forgectl:** Merge failed and conflict resolution failed. Leaving PR open for manual review." }),
      }).catch(() => {});
    }
  }
}

export function createGitHubAdapter(config: TrackerConfig, externalCache?: SubIssueCache): TrackerAdapter & { subIssueCache: SubIssueCache; mergeQueue: MergeQueue } {
  if (!config.repo) {
    throw new Error("GitHub adapter: repo is required");
  }
  if (!config.repo.includes("/")) {
    throw new Error(
      "GitHub adapter: repo must be in owner/repo format",
    );
  }

  const token = resolveToken(config.token);
  const [owner, repo] = config.repo.split("/");
  const labelsFilter = config.labels ?? [];

  // Internal state
  let lastETag: string | null = null;
  let cachedIssues: TrackerIssue[] = [];
  let rateLimitRemaining = Infinity;
  let rateLimitReset = 0;

  // Sub-issue TTL cache (5min default) — use external cache if provided (singleton pattern)
  const subIssueCache = externalCache ?? new SubIssueCache();

  // Sequential merge queue — serializes PR merges to prevent parallel corruption
  const mergeQueue = new MergeQueue(async (prNumber: number, branch: string) => {
    await autoMergeWithCI(owner, repo, branch, prNumber, token, config.token);
  });

  /**
   * Perform an authenticated fetch against the GitHub API.
   * Reads rate limit headers, enforces limits, and retries on transient errors.
   */
  async function githubFetch(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "forgectl",
      ...(options.headers as Record<string, string> | undefined),
    };

    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [1000, 3000, 5000]; // ms

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { ...options, headers });
      } catch (err) {
        // Network error (DNS, connection refused, etc.)
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        throw lastError;
      }

      // Update rate limit state
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      if (remaining !== null) {
        rateLimitRemaining = parseInt(remaining, 10);
      }
      if (reset !== null) {
        rateLimitReset = parseInt(reset, 10);
      }

      // Enforce rate limit
      if (response.status === 403 && rateLimitRemaining === 0) {
        const resetDate = new Date(rateLimitReset * 1000).toISOString();
        throw new Error(
          `GitHub rate limit exhausted. Resets at ${resetDate}`,
        );
      }

      // Retry on 5xx server errors
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }

      if (rateLimitRemaining < RATE_LIMIT_WARNING_THRESHOLD && rateLimitRemaining > 0) {
        // Log warning — using console.warn since this is a library module
      }

      return response;
    }

    throw lastError ?? new Error(`GitHub API request failed after ${MAX_RETRIES} retries`);
  }

  /**
   * Fetch all pages of issues from a given URL.
   */
  async function fetchAllPages(
    initialUrl: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ issues: GitHubIssue[]; response: Response } | null> {
    const response = await githubFetch(initialUrl, {
      headers: extraHeaders,
    });

    if (response.status === 304) {
      return null; // Not modified
    }

    const issues: GitHubIssue[] = (await response.json()) as GitHubIssue[];
    let nextUrl = parseLinkHeader(response.headers.get("link"));

    while (nextUrl) {
      const nextResponse = await githubFetch(nextUrl);
      const nextIssues = (await nextResponse.json()) as GitHubIssue[];
      issues.push(...nextIssues);
      nextUrl = parseLinkHeader(nextResponse.headers.get("link"));
    }

    return { issues, response };
  }

  /**
   * Fetch sub-issues for a given issue number from the GitHub sub_issues endpoint.
   */
  async function fetchSubIssues(issueNumber: number): Promise<GitHubIssue[]> {
    const url = `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`;
    const result = await fetchAllPages(url);
    return result ? result.issues : [];
  }

  const adapter: TrackerAdapter & { subIssueCache: SubIssueCache; mergeQueue: MergeQueue } = {
    kind: "github",
    subIssueCache,
    mergeQueue,

    async fetchCandidateIssues(): Promise<TrackerIssue[]> {
      const params = new URLSearchParams({
        state: config.active_states[0] ?? "open",
        per_page: "100",
        sort: "updated",
        direction: "desc",
      });

      if (labelsFilter.length > 0) {
        params.set("labels", labelsFilter.join(","));
      }

      // Delta polling disabled — always fetch full candidate list.
      // The `since` param caused stale cache entries for auto-closed issues
      // (closed issues disappear from state:open queries, leaving stale
      // open entries in the cache that caused infinite re-dispatch loops).

      const url = `${API_BASE}/repos/${owner}/${repo}/issues?${params.toString()}`;

      const extraHeaders: Record<string, string> = {};
      if (lastETag) {
        extraHeaders["If-None-Match"] = lastETag;
      }

      const result = await fetchAllPages(url, extraHeaders);

      if (result === null) {
        // 304 — return cached
        return cachedIssues;
      }

      // Store ETag for next request
      const etag = result.response.headers.get("etag");
      if (etag) {
        lastETag = etag;
      }

      // First pass: normalize without sub-issues (basic normalization)
      const ghIssueMap = new Map<string, GitHubIssue>();
      const normalized: TrackerIssue[] = [];
      for (const ghIssue of result.issues) {
        const issue = normalizeIssue(ghIssue);
        if (issue) {
          normalized.push(issue);
          ghIssueMap.set(issue.id, ghIssue);
        }
      }

      // Second pass: enrich with sub-issues (SUBISSUE-01)
      // Collect all candidate issue numbers seen so far for auto-discovery dedup
      const candidateIds = new Set<string>(normalized.map((i) => i.id));
      const enriched: TrackerIssue[] = [];
      const pendingEnrichment: Array<{ ghIssue: GitHubIssue; subIssues: GitHubIssue[] }> = [];

      for (const issue of normalized) {
        const ghIssue = ghIssueMap.get(issue.id)!;
        const issueNum = Number(issue.id);

        // Check cache first
        const cached = subIssueCache.get(issue.id);
        if (cached) {
          // Cache hit: rebuild sub-issues from childIds/childStates (reconstruct minimal GitHubIssue[])
          // We only need the number to populate blocked_by
          const cachedSubIssues: GitHubIssue[] = cached.childIds.map((childId) => ({
            id: 0, // internal id not needed for blocked_by
            number: Number(childId),
            title: "",
            body: null,
            state: cached.childStates.get(childId) ?? "open",
            labels: [],
            assignees: [],
            html_url: "",
            created_at: "",
            updated_at: "",
          }));
          pendingEnrichment.push({ ghIssue, subIssues: cachedSubIssues });
          continue;
        }

        // Cache miss: fetch if rate limit allows
        if (rateLimitRemaining >= RATE_LIMIT_WARNING_THRESHOLD) {
          const subIssues = await fetchSubIssues(issueNum);

          // Store in cache
          const childStates = new Map<string, string>();
          for (const si of subIssues) {
            if (!si.pull_request) {
              childStates.set(String(si.number), si.state);
            }
          }
          subIssueCache.set({
            parentId: issue.id,
            childIds: subIssues.filter((s) => !s.pull_request).map((s) => String(s.number)),
            childStates,
            fetchedAt: Date.now(),
          });

          pendingEnrichment.push({ ghIssue, subIssues });
        } else {
          // Rate limit low: graceful degradation, serve with empty sub-issues
          console.warn(
            `[forgectl] Rate limit low (${rateLimitRemaining} remaining), skipping sub-issue fetch for issue #${issueNum}`,
          );
          pendingEnrichment.push({ ghIssue, subIssues: [] });
        }
      }

      // Auto-discovery: add sub-issues not already in candidates
      for (const { subIssues } of pendingEnrichment) {
        for (const si of subIssues) {
          if (!si.pull_request && !candidateIds.has(String(si.number))) {
            candidateIds.add(String(si.number));
            // Enqueue auto-discovered issue for its own enrichment
            // Use the sub-issue data directly as a basic GitHubIssue
            ghIssueMap.set(String(si.number), si);
            // Fetch sub-issues for auto-discovered child (if rate allows)
            let childSubIssues: GitHubIssue[] = [];
            const cached = subIssueCache.get(String(si.number));
            if (cached) {
              childSubIssues = cached.childIds.map((childId) => ({
                id: 0,
                number: Number(childId),
                title: "",
                body: null,
                state: cached.childStates.get(childId) ?? "open",
                labels: [],
                assignees: [],
                html_url: "",
                created_at: "",
                updated_at: "",
              }));
            } else if (rateLimitRemaining >= RATE_LIMIT_WARNING_THRESHOLD) {
              childSubIssues = await fetchSubIssues(si.number);
              const childStates = new Map<string, string>();
              for (const csi of childSubIssues) {
                if (!csi.pull_request) {
                  childStates.set(String(csi.number), csi.state);
                }
              }
              subIssueCache.set({
                parentId: String(si.number),
                childIds: childSubIssues.filter((s) => !s.pull_request).map((s) => String(s.number)),
                childStates,
                fetchedAt: Date.now(),
              });
            }
            const discoveredIssue = normalizeIssue(si, childSubIssues);
            if (discoveredIssue) {
              enriched.push(discoveredIssue);
            }
          }
        }
      }

      // Re-normalize original issues with their sub-issues
      for (const { ghIssue, subIssues } of pendingEnrichment) {
        const enrichedIssue = normalizeIssue(ghIssue, subIssues);
        if (enrichedIssue) {
          enriched.push(enrichedIssue);
        }
      }

      // Cycle detection: run on all enriched candidates (SUBISSUE-04)
      const cycleError = detectIssueCycles(enriched.map((i) => ({ id: i.id, blocked_by: i.blocked_by })));
      if (cycleError) {
        console.warn(`[forgectl] Sub-issue dependency cycle detected: ${cycleError}`);
      }

      cachedIssues = enriched;
      return cachedIssues;
    },

    async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
      const stateMap = new Map<string, string>();

      for (const id of ids) {
        const num = parseIssueNumber(id);
        const url = `${API_BASE}/repos/${owner}/${repo}/issues/${num}`;
        const response = await githubFetch(url);
        const data = (await response.json()) as GitHubIssue;
        stateMap.set(id, data.state);
      }

      return stateMap;
    },

    async fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]> {
      const allIssues: TrackerIssue[] = [];

      for (const state of states) {
        const params = new URLSearchParams({
          state,
          per_page: "100",
          sort: "updated",
          direction: "desc",
        });

        const url = `${API_BASE}/repos/${owner}/${repo}/issues?${params.toString()}`;
        const result = await fetchAllPages(url);

        if (result) {
          for (const ghIssue of result.issues) {
            const issue = normalizeIssue(ghIssue);
            if (issue) {
              allIssues.push(issue);
            }
          }
        }
      }

      return allIssues;
    },

    async postComment(issueId: string, body: string): Promise<void> {
      const num = parseIssueNumber(issueId);
      const url = `${API_BASE}/repos/${owner}/${repo}/issues/${num}/comments`;
      await githubFetch(url, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async updateState(issueId: string, state: string): Promise<void> {
      const num = parseIssueNumber(issueId);
      const url = `${API_BASE}/repos/${owner}/${repo}/issues/${num}`;
      await githubFetch(url, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
    },

    async updateLabels(
      issueId: string,
      add: string[],
      remove: string[],
    ): Promise<void> {
      const num = parseIssueNumber(issueId);

      if (add.length > 0) {
        const url = `${API_BASE}/repos/${owner}/${repo}/issues/${num}/labels`;
        await githubFetch(url, {
          method: "POST",
          body: JSON.stringify({ labels: add }),
        });
      }

      for (const label of remove) {
        const url = `${API_BASE}/repos/${owner}/${repo}/issues/${num}/labels/${encodeURIComponent(label)}`;
        await githubFetch(url, { method: "DELETE" });
      }
    },

    async createPullRequest(
      branch: string,
      title: string,
      body: string,
    ): Promise<string | undefined> {
      const url = `${API_BASE}/repos/${owner}/${repo}/pulls`;
      const response = await githubFetch(url, {
        method: "POST",
        body: JSON.stringify({ title, body, head: branch, base: "main" }),
      });
      const data = await response.json() as { html_url?: string; number?: number };

      // Enqueue for sequential merge — waits for CI, merges one at a time
      if (data.number) {
        void mergeQueue.enqueue(branch, data.number).catch(() => {
          // Non-fatal — PR stays open for manual merge
        });
      }

      return data.html_url;
    },

    async createAndMergePullRequest(
      branch: string,
      title: string,
      body: string,
    ): Promise<{ merged: boolean; prUrl?: string; error?: string }> {
      const url = `${API_BASE}/repos/${owner}/${repo}/pulls`;
      const response = await githubFetch(url, {
        method: "POST",
        body: JSON.stringify({ title, body, head: branch, base: "main" }),
      });
      const data = await response.json() as { html_url?: string; number?: number };

      if (!data.number) {
        return { merged: false, prUrl: data.html_url, error: "Failed to create PR" };
      }

      // Await the full merge lifecycle (CI wait + merge)
      const mergeResult = await mergeQueue.enqueue(branch, data.number);
      return {
        merged: mergeResult.merged,
        prUrl: data.html_url,
        error: mergeResult.error,
      };
    },
  };

  return adapter;
}
