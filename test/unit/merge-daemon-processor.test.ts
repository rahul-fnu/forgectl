import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRProcessor, type PRProcessorConfig, type PRInfo, parseStructuredReview } from "../../src/merge-daemon/pr-processor.js";
import type { Logger } from "../../src/logging/logger.js";

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Logger;
}

function makeConfig(overrides: Partial<PRProcessorConfig> = {}): PRProcessorConfig {
  return {
    owner: "test-owner",
    repo: "test-repo",
    token: "test-token",
    rawToken: "test-token",
    branchPattern: "forge/*",
    ciTimeoutMs: 5000, // Short for tests
    enableReview: false,
    enableBuildFix: false,
    validationCommands: [],
    ...overrides,
  };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 1,
    branch: "forge/fix-bug",
    title: "Fix bug",
    sha: "abc123",
    url: "https://github.com/test-owner/test-repo/pull/1",
    ...overrides,
  };
}

describe("PRProcessor", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchOpenForgePRs", () => {
    it("filters PRs by branch pattern", async () => {
      const mockPRs = [
        { number: 1, head: { ref: "forge/fix-bug", sha: "abc" }, title: "Fix bug", html_url: "url1" },
        { number: 2, head: { ref: "feature/other", sha: "def" }, title: "Other", html_url: "url2" },
        { number: 3, head: { ref: "forge/add-feature", sha: "ghi" }, title: "Add feature", html_url: "url3" },
      ];

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockPRs,
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      const prs = await processor.fetchOpenForgePRs();

      expect(prs).toHaveLength(2);
      expect(prs[0].branch).toBe("forge/fix-bug");
      expect(prs[1].branch).toBe("forge/add-feature");
    });

    it("throws on API failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      await expect(processor.fetchOpenForgePRs()).rejects.toThrow("Failed to fetch PRs: 403");
    });
  });

  describe("waitForCI", () => {
    it("returns true when no CI is configured", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ check_runs: [] }),
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      const result = await processor.waitForCI(1, "sha123");
      expect(result).toBe(true);
    });

    it("returns true when all checks pass", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
          ],
        }),
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      const result = await processor.waitForCI(1, "sha123");
      expect(result).toBe(true);
    });

    it("returns false when checks fail", async () => {
      // Mock the check-runs response (failure) and the comment POST
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            check_runs: [
              { status: "completed", conclusion: "failure" },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({ ok: true } as Response); // comment POST

      const processor = new PRProcessor(makeConfig(), logger);
      const result = await processor.waitForCI(1, "sha123");
      expect(result).toBe(false);
    });
  });

  describe("getHistory", () => {
    it("starts empty", () => {
      const processor = new PRProcessor(makeConfig(), logger);
      expect(processor.getHistory()).toHaveLength(0);
    });
  });

  describe("processPR", () => {
    it("records result in history on failure", async () => {
      // Mock cloneAndRebase to throw
      vi.mock("../../src/merge-daemon/git-operations.js", async (importOriginal) => {
        const orig = await importOriginal<typeof import("../../src/merge-daemon/git-operations.js")>();
        return {
          ...orig,
          cloneAndRebase: vi.fn(() => { throw new Error("clone failed"); }),
          cleanupTmpDir: vi.fn(),
        };
      });

      // Re-import to get mocked version
      const { PRProcessor: MockedProcessor } = await import("../../src/merge-daemon/pr-processor.js");
      const processor = new MockedProcessor(makeConfig(), logger);
      const pr = makePR();

      const result = await processor.processPR(pr);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("clone failed");
      expect(processor.getHistory()).toHaveLength(1);
    });
  });

  describe("submitPRReview", () => {
    it("posts APPROVE review with LGTM body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      await processor.submitPRReview(42, {
        summary: "Looks good",
        approval: "approve",
        comments: [],
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/pulls/42/reviews"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"APPROVE"'),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.event).toBe("APPROVE");
      expect(body.body).toContain("LGTM");
    });

    it("posts REQUEST_CHANGES review with inline comments", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      await processor.submitPRReview(42, {
        summary: "Found issues",
        approval: "request_changes",
        comments: [
          { file: "src/foo.ts", line: 10, severity: "must_fix", body: "Missing error handling" },
        ],
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.event).toBe("REQUEST_CHANGES");
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0].path).toBe("src/foo.ts");
      expect(body.comments[0].line).toBe(10);
      expect(body.comments[0].body).toContain("[MUST_FIX]");
    });
  });
});

describe("parseStructuredReview", () => {
  it("parses valid JSON review", () => {
    const json = JSON.stringify({
      summary: "All good",
      approval: "approve",
      comments: [],
    });
    const result = parseStructuredReview(json);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.summary).toBe("All good");
    expect(result!.comments).toHaveLength(0);
  });

  it("parses JSON with comments", () => {
    const json = JSON.stringify({
      summary: "Issues found",
      approval: "request_changes",
      comments: [
        { file: "src/foo.ts", line: 42, severity: "must_fix", body: "Missing null check" },
        { file: "src/bar.ts", line: 10, severity: "nit", body: "Unnecessary import" },
      ],
    });
    const result = parseStructuredReview(json);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.comments).toHaveLength(2);
    expect(result!.comments[0].severity).toBe("must_fix");
    expect(result!.comments[1].severity).toBe("nit");
  });

  it("extracts JSON from markdown fences", () => {
    const raw = `Here is my review:\n\n\`\`\`json\n{"summary":"LGTM","approval":"approve","comments":[]}\n\`\`\``;
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("extracts JSON object from surrounding text", () => {
    const raw = `Some preamble text\n{"summary":"ok","approval":"approve","comments":[]}\nSome trailing text`;
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("returns undefined for empty input", () => {
    expect(parseStructuredReview("")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseStructuredReview("not json at all")).toBeUndefined();
  });

  it("skips malformed comments", () => {
    const json = JSON.stringify({
      summary: "Review",
      approval: "approve",
      comments: [
        { file: "src/foo.ts", line: 10, severity: "must_fix", body: "Good comment" },
        { file: "missing-line" }, // missing line and body
        { severity: "nit" }, // missing file and body
      ],
    });
    const result = parseStructuredReview(json);
    expect(result).toBeDefined();
    expect(result!.comments).toHaveLength(1);
  });

  it("normalizes unknown severity to nit", () => {
    const json = JSON.stringify({
      summary: "Review",
      approval: "approve",
      comments: [
        { file: "src/foo.ts", line: 5, severity: "critical", body: "Something wrong" },
      ],
    });
    const result = parseStructuredReview(json);
    expect(result!.comments[0].severity).toBe("nit");
  });

  it("defaults approval to approve for unknown values", () => {
    const json = JSON.stringify({
      summary: "Review",
      approval: "banana",
      comments: [],
    });
    const result = parseStructuredReview(json);
    expect(result!.approval).toBe("approve");
  });
});
