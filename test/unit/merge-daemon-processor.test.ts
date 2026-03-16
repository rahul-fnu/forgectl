import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRProcessor, type PRProcessorConfig, type PRInfo } from "../../src/merge-daemon/pr-processor.js";
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
});
