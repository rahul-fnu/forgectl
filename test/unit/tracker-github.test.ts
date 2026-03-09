import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrackerConfig, TrackerIssue } from "../../src/tracker/types.js";

// --- Mock fetch globally before importing the module ---
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeGitHubIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 123456,
    number: 42,
    title: "Fix login bug",
    body: "Users cannot login",
    state: "open",
    labels: [{ name: "bug" }, { name: "priority:high" }],
    assignees: [{ login: "alice" }],
    html_url: "https://github.com/acme/repo/issues/42",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-15T12:00:00Z",
    reactions: { total_count: 5 },
    ...overrides,
  };
}

function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const defaultHeaders: Record<string, string> = {
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-reset": "1700000000",
    ...headers,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => defaultHeaders[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  };
}

const baseConfig: TrackerConfig = {
  kind: "github",
  token: "test-token-literal",
  repo: "acme/repo",
  active_states: ["open"],
  terminal_states: ["closed"],
  poll_interval_ms: 60000,
  auto_close: false,
};

describe("GitHub Tracker Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.TEST_GH_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.TEST_GH_TOKEN;
  });

  describe("factory: createGitHubAdapter", () => {
    it("throws on missing repo", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const config = { ...baseConfig, repo: undefined };
      expect(() => createGitHubAdapter(config)).toThrow(/repo/i);
    });

    it("throws on invalid repo format (no slash)", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const config = { ...baseConfig, repo: "noslash" };
      expect(() => createGitHubAdapter(config)).toThrow(/owner\/repo/i);
    });

    it("creates adapter with valid config", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);
      expect(adapter.kind).toBe("github");
    });

    it("resolves $ENV_VAR tokens", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const config = { ...baseConfig, token: "$TEST_GH_TOKEN" };
      const adapter = createGitHubAdapter(config);
      expect(adapter.kind).toBe("github");
    });
  });

  describe("fetchCandidateIssues", () => {
    it("fetches open issues and normalizes them", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue()]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("42");
      expect(issues[0].identifier).toBe("#42");
      expect(issues[0].title).toBe("Fix login bug");
      expect(issues[0].description).toBe("Users cannot login");
      expect(issues[0].priority).toBe("high");
      expect(issues[0].labels).toEqual(["bug", "priority:high"]);
      expect(issues[0].assignees).toEqual(["alice"]);
      expect(issues[0].url).toBe("https://github.com/acme/repo/issues/42");

      // Verify URL called
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("api.github.com/repos/acme/repo/issues");
      expect(url).toContain("state=open");
      expect(url).toContain("per_page=100");
    });

    it("filters out pull requests", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([
          makeGitHubIssue(),
          makeGitHubIssue({
            id: 999,
            number: 99,
            pull_request: { url: "..." },
          }),
        ]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0].identifier).toBe("#42");
    });

    it("paginates via Link header", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      // Page 1
      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue()], 200, {
          link: '<https://api.github.com/repos/acme/repo/issues?page=2>; rel="next"',
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1700000000",
        }),
      );
      // Page 2
      mockFetch.mockResolvedValueOnce(
        makeResponse([
          makeGitHubIssue({ id: 789, number: 43, title: "Page 2 issue" }),
        ]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns cached issues on 304 (ETag)", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      // First fetch sets ETag
      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue()], 200, {
          etag: '"abc123"',
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1700000000",
        }),
      );

      const first = await adapter.fetchCandidateIssues();
      expect(first).toHaveLength(1);

      // Second fetch returns 304
      mockFetch.mockResolvedValueOnce(
        makeResponse(null, 304, {
          "x-ratelimit-remaining": "4997",
          "x-ratelimit-reset": "1700000000",
        }),
      );

      const second = await adapter.fetchCandidateIssues();
      expect(second).toHaveLength(1);
      expect(second[0].identifier).toBe("#42");

      // Verify If-None-Match header was sent
      const headers = mockFetch.mock.calls[1][1].headers as Record<
        string,
        string
      >;
      expect(headers["If-None-Match"]).toBe('"abc123"');
    });

    it("sends since parameter for delta polling", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      // First fetch
      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue()]),
      );
      await adapter.fetchCandidateIssues();

      // Second fetch should include since
      mockFetch.mockResolvedValueOnce(makeResponse([]));
      await adapter.fetchCandidateIssues();

      const url = mockFetch.mock.calls[1][0] as string;
      expect(url).toContain("since=2026-01-15T12%3A00%3A00Z");
    });

    it("sends labels filter when configured", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const config = { ...baseConfig, labels: ["bug", "agent-ready"] };
      const adapter = createGitHubAdapter(config);

      mockFetch.mockResolvedValueOnce(makeResponse([]));
      await adapter.fetchCandidateIssues();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("labels=bug%2Cagent-ready");
    });

    it("defaults missing body to empty string", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue({ body: null })]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("");
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("fetches individual issues and returns state map", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse({ id: 1, number: 42, state: "open" }),
      );
      mockFetch.mockResolvedValueOnce(
        makeResponse({ id: 2, number: 43, state: "closed" }),
      );

      const result = await adapter.fetchIssueStatesByIds(["#42", "#43"]);
      expect(result.get("#42")).toBe("open");
      expect(result.get("#43")).toBe("closed");
    });
  });

  describe("fetchIssuesByStates", () => {
    it("fetches issues by state and normalizes", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue({ state: "closed" })]),
      );

      const issues = await adapter.fetchIssuesByStates(["closed"]);
      expect(issues).toHaveLength(1);
      expect(issues[0].state).toBe("closed");
    });
  });

  describe("postComment", () => {
    it("posts comment with correct URL and body", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(makeResponse({}, 201));

      await adapter.postComment("#42", "Work complete");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/repos/acme/repo/issues/42/comments");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ body: "Work complete" });
    });
  });

  describe("updateState", () => {
    it("patches issue state", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(makeResponse({}));

      await adapter.updateState("#42", "closed");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/repos/acme/repo/issues/42");
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body)).toEqual({ state: "closed" });
    });
  });

  describe("updateLabels", () => {
    it("adds and removes labels", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      // Add labels
      mockFetch.mockResolvedValueOnce(makeResponse({}, 200));
      // Remove label
      mockFetch.mockResolvedValueOnce(makeResponse({}, 200));

      await adapter.updateLabels("#42", ["in-progress"], ["backlog"]);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Add call
      const [addUrl, addOpts] = mockFetch.mock.calls[0];
      expect(addUrl).toContain("/repos/acme/repo/issues/42/labels");
      expect(addOpts.method).toBe("POST");
      expect(JSON.parse(addOpts.body)).toEqual({ labels: ["in-progress"] });

      // Remove call
      const [removeUrl, removeOpts] = mockFetch.mock.calls[1];
      expect(removeUrl).toContain(
        "/repos/acme/repo/issues/42/labels/backlog",
      );
      expect(removeOpts.method).toBe("DELETE");
    });
  });

  describe("parseIssueNumber hardening", () => {
    it("handles plain number string for mutation methods", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(makeResponse({}, 201));

      await adapter.postComment("42", "Test comment");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/repos/acme/repo/issues/42/comments");
    });

    it("throws on invalid input for mutation methods", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      await expect(adapter.postComment("not-a-number", "Test")).rejects.toThrow(
        /Invalid issue number/,
      );
    });
  });

  describe("normalizeIssue id semantics", () => {
    it("sets id to issue number not internal id", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([makeGitHubIssue({ id: 999999, number: 7 })]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].id).toBe("7");
      expect(issues[0].identifier).toBe("#7");
    });
  });

  describe("rate limiting", () => {
    it("throws when rate limit is exhausted", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse(
          { message: "rate limit exceeded" },
          403,
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000",
          },
        ),
      );

      await expect(adapter.fetchCandidateIssues()).rejects.toThrow(
        /rate limit/i,
      );
    });
  });

  describe("normalization", () => {
    it("maps all fields correctly", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      const ghIssue = makeGitHubIssue();
      mockFetch.mockResolvedValueOnce(makeResponse([ghIssue]));

      const issues = await adapter.fetchCandidateIssues();
      const issue = issues[0];

      expect(issue).toEqual({
        id: "42",
        identifier: "#42",
        title: "Fix login bug",
        description: "Users cannot login",
        state: "open",
        priority: "high",
        labels: ["bug", "priority:high"],
        assignees: ["alice"],
        url: "https://github.com/acme/repo/issues/42",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-15T12:00:00Z",
        blocked_by: [],
        metadata: { reactions: { total_count: 5 } },
      });
    });

    it("extracts priority from P0/P1 labels", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([
          makeGitHubIssue({
            labels: [{ name: "P0" }, { name: "enhancement" }],
          }),
        ]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].priority).toBe("P0");
    });

    it("returns null priority when no priority label", async () => {
      const { createGitHubAdapter } = await import(
        "../../src/tracker/github.js"
      );
      const adapter = createGitHubAdapter(baseConfig);

      mockFetch.mockResolvedValueOnce(
        makeResponse([
          makeGitHubIssue({
            labels: [{ name: "enhancement" }],
          }),
        ]),
      );

      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].priority).toBeNull();
    });
  });
});
