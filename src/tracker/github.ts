import type { TrackerAdapter, TrackerConfig, TrackerIssue } from "./types.js";
import { resolveToken } from "./token.js";

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
 */
function normalizeIssue(ghIssue: GitHubIssue): TrackerIssue | null {
  if (ghIssue.pull_request) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  if (ghIssue.reactions) {
    metadata.reactions = ghIssue.reactions;
  }

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
    blocked_by: [],
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
export function createGitHubAdapter(config: TrackerConfig): TrackerAdapter {
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
  let lastUpdatedAt: string | null = null;
  let cachedIssues: TrackerIssue[] = [];
  let rateLimitRemaining = Infinity;
  let rateLimitReset = 0;

  /**
   * Perform an authenticated fetch against the GitHub API.
   * Reads rate limit headers and enforces limits.
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

    const response = await fetch(url, { ...options, headers });

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

    if (rateLimitRemaining < RATE_LIMIT_WARNING_THRESHOLD && rateLimitRemaining > 0) {
      // Log warning — using console.warn since this is a library module
      // In production, the caller can configure proper logging
    }

    return response;
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

  const adapter: TrackerAdapter = {
    kind: "github",

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

      if (lastUpdatedAt) {
        params.set("since", lastUpdatedAt);
      }

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

      // Normalize and filter out PRs
      const normalized: TrackerIssue[] = [];
      for (const ghIssue of result.issues) {
        const issue = normalizeIssue(ghIssue);
        if (issue) {
          normalized.push(issue);
        }
      }

      // Update lastUpdatedAt for delta polling
      if (normalized.length > 0) {
        const maxUpdated = normalized.reduce((max, issue) =>
          issue.updated_at > max ? issue.updated_at : max,
          normalized[0].updated_at,
        );
        lastUpdatedAt = maxUpdated;
      }

      cachedIssues = normalized;
      return normalized;
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
      const data = await response.json() as { html_url?: string };
      return data.html_url;
    },
  };

  return adapter;
}
