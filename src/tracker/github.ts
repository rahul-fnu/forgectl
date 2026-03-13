import type { TrackerAdapter, TrackerConfig, TrackerIssue } from "./types.js";
import { resolveToken } from "./token.js";
import { SubIssueCache } from "./sub-issue-cache.js";
import { detectIssueCycles } from "./sub-issue-dag.js";

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
export function createGitHubAdapter(config: TrackerConfig): TrackerAdapter & { subIssueCache: SubIssueCache } {
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

  // Sub-issue TTL cache (5min default)
  const subIssueCache = new SubIssueCache();

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

  const adapter: TrackerAdapter & { subIssueCache: SubIssueCache } = {
    kind: "github",
    subIssueCache,

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

      // Update lastUpdatedAt for delta polling
      if (enriched.length > 0) {
        const maxUpdated = enriched.reduce((max, issue) =>
          issue.updated_at > max ? issue.updated_at : max,
          enriched[0].updated_at,
        );
        if (maxUpdated) {
          lastUpdatedAt = maxUpdated;
        }
      }

      cachedIssues = enriched;
      return enriched;
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
