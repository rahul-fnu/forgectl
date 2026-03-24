import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRProcessor, type PRProcessorConfig, type PRInfo, parseStructuredReview, findCoverageGaps } from "../../src/merge-daemon/pr-processor.js";
import type { Logger } from "../../src/logging/logger.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKGDatabase, saveTestMappings } from "../../src/kg/storage.js";
import type { TestCoverageMapping } from "../../src/kg/types.js";

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

    it("posts COMMENT review with issues in body (not inline)", async () => {
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
      expect(body.event).toBe("COMMENT");
      expect(body.comments).toHaveLength(0);
      expect(body.body).toContain("[MUST_FIX]");
      expect(body.body).toContain("src/foo.ts:10");
      expect(body.body).toContain("Missing error handling");
      expect(body.body).toContain("Changes requested");
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

  it("returns undefined for completely unparseable text", () => {
    expect(parseStructuredReview("just some random words with no structure")).toBeUndefined();
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

  it("handles JSON with trailing commas", () => {
    const raw = `{"summary": "Looks good", "approval": "approve", "comments": [],}`;
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.summary).toBe("Looks good");
  });

  it("handles JSON wrapped in ```json fences with leading prose", () => {
    const raw = [
      "Here is my review of the changes:",
      "",
      "```json",
      `{"summary": "Code looks clean", "approval": "approve", "comments": []}`,
      "```",
      "",
      "Let me know if you have questions.",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.summary).toBe("Code looks clean");
  });

  it("handles JSON with leading prose (no fences)", () => {
    const raw = `Here is my review:\n{"summary":"issues found","approval":"request_changes","comments":[{"file":"src/a.ts","line":1,"severity":"must_fix","body":"bug"}]}`;
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.comments).toHaveLength(1);
  });

  it("falls back to keyword extraction for unparseable text with approve", () => {
    const raw = "I would approve this PR. The changes look reasonable and well-tested.";
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.comments).toHaveLength(0);
  });

  it("falls back to keyword extraction for unparseable text with request_changes", () => {
    const raw = "This PR has issues. I would request_changes due to a must_fix security problem.";
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.comments).toHaveLength(0);
  });

  it("handles single quotes instead of double quotes", () => {
    const raw = `{'summary': 'LGTM', 'approval': 'approve', 'comments': []}`;
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("extracts fields line-by-line when JSON is broken", () => {
    const raw = [
      `Here is the review:`,
      `"summary": "Needs work",`,
      `"approval": "request_changes",`,
      `"comments": []`,
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.summary).toBe("Needs work");
  });

  it("parses YAML output as fallback", () => {
    const raw = [
      "summary: Clean implementation with good test coverage",
      'approval: approve',
      "comments: []",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.summary).toBe("Clean implementation with good test coverage");
    expect(result!.comments).toHaveLength(0);
  });

  it("parses YAML with comments array", () => {
    const raw = [
      "summary: Issues found",
      "approval: request_changes",
      "comments:",
      "  - file: src/foo.ts",
      "    line: 42",
      "    severity: must_fix",
      "    body: Missing null check",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].file).toBe("src/foo.ts");
  });

  it("parses YAML inside markdown fences", () => {
    const raw = [
      "Here is my review:",
      "",
      "```yaml",
      "summary: Looks good",
      "approval: approve",
      "comments: []",
      "```",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("parses YAML with leading prose", () => {
    const raw = [
      "After reviewing the diff, here is my assessment:",
      "",
      "summary: Code is clean",
      "approval: approve",
      "comments: []",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("unwraps Claude --output-format json envelope", () => {
    const inner = JSON.stringify({
      summary: "All good",
      approval: "approve",
      comments: [],
    });
    const envelope = JSON.stringify({ type: "result", result: inner });
    const result = parseStructuredReview(envelope);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
    expect(result!.summary).toBe("All good");
  });

  it("unwraps Claude envelope with nested JSON in result string", () => {
    const envelope = JSON.stringify({
      result: `{"summary":"Issues found","approval":"request_changes","comments":[{"file":"src/a.ts","line":1,"severity":"must_fix","body":"bug"}]}`,
    });
    const result = parseStructuredReview(envelope);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("request_changes");
    expect(result!.comments).toHaveLength(1);
  });

  it("handles multiple markdown fence blocks (picks the JSON one)", () => {
    const raw = [
      "Here is my analysis:",
      "",
      "```",
      "Some general notes about the code",
      "```",
      "",
      "```json",
      '{"summary": "LGTM", "approval": "approve", "comments": []}',
      "```",
    ].join("\n");
    const result = parseStructuredReview(raw);
    expect(result).toBeDefined();
    expect(result!.approval).toBe("approve");
  });

  it("parses suggested_fix from comments", () => {
    const json = JSON.stringify({
      summary: "Issues found",
      approval: "request_changes",
      comments: [
        { file: "src/foo.ts", line: 10, severity: "must_fix", body: "Missing null check", suggested_fix: "Add if (x != null) guard" },
        { file: "src/bar.ts", line: 5, severity: "nit", body: "Style issue" },
      ],
    });
    const result = parseStructuredReview(json);
    expect(result).toBeDefined();
    expect(result!.comments[0].suggested_fix).toBe("Add if (x != null) guard");
    expect(result!.comments[1].suggested_fix).toBeUndefined();
  });
});

describe("PRProcessor.enrichPRDescription", () => {
  it("updates PR description with ticket context when body is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      // fetchPRFull (fetchPRDescription calls fetchPRFull)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ body: "" }),
      } as Response)
      // fetchLinkedIssue
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 42, title: "Fix the widget", body: "The widget is broken\n\n## Acceptance Criteria\n- Widget works" }),
      } as Response)
      // PATCH to update PR
      .mockResolvedValueOnce({ ok: true } as Response);

    const processor = new PRProcessor(makeConfig(), makeLogger());
    const pr = makePR({ title: "Fix #42 widget bug", number: 7 });

    await processor.enrichPRDescription(pr, "/tmp/fake");

    // Should have called PATCH to update PR body
    const patchCall = fetchSpy.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.body).toContain("<!-- forgectl-generated -->");
    expect(patchBody.body).toContain("#42");
    expect(patchBody.body).toContain("Fix the widget");
    expect(patchBody.body).toContain("Requirements (from ticket)");
    expect(patchBody.body).toContain("Acceptance Criteria");
  });

  it("skips update when PR has human-written description", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ body: "Human wrote this description" }),
      } as Response);

    const processor = new PRProcessor(makeConfig(), makeLogger());
    const pr = makePR({ title: "Fix #42 widget bug", number: 7 });

    await processor.enrichPRDescription(pr, "/tmp/fake");

    // No PATCH call expected
    const patchCall = fetchSpy.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeUndefined();
  });

  it("overwrites forgectl-generated description", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ body: "<!-- forgectl-generated -->\nOld content" }),
      } as Response)
      // fetchLinkedIssue — no issue found
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      // PATCH
      .mockResolvedValueOnce({ ok: true } as Response);

    const processor = new PRProcessor(makeConfig(), makeLogger());
    const pr = makePR({ title: "Some change", number: 7 });

    await processor.enrichPRDescription(pr, "/tmp/fake");

    const patchCall = fetchSpy.mock.calls.find(c => (c[1] as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.body).toContain("<!-- forgectl-generated -->");
  });
});

describe("PRProcessor.submitPRReview with suggested_fix", () => {
  it("includes suggested fix in review body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const processor = new PRProcessor(makeConfig(), makeLogger());
    await processor.submitPRReview(42, {
      summary: "Issues found",
      approval: "request_changes",
      comments: [
        { file: "src/foo.ts", line: 10, severity: "must_fix", body: "Missing error handling", suggested_fix: "Wrap in try/catch" },
      ],
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.comments).toHaveLength(0);
    expect(body.body).toContain("[MUST_FIX]");
    expect(body.body).toContain("Suggested fix:");
    expect(body.body).toContain("Wrap in try/catch");
  });
});

describe("findCoverageGaps", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coverage-gaps-"));
    mkdirSync(join(tmpDir, ".forgectl"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all files when KG has no test mappings", () => {
    const dbPath = join(tmpDir, ".forgectl", "kg.db");
    createKGDatabase(dbPath).close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts"], tmpDir);
    expect(gaps).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("excludes files that have test mappings", () => {
    const dbPath = join(tmpDir, ".forgectl", "kg.db");
    const db = createKGDatabase(dbPath);
    const mappings: TestCoverageMapping[] = [
      { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "import" },
    ];
    saveTestMappings(db, mappings);
    db.close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts"], tmpDir);
    expect(gaps).toEqual(["src/bar.ts"]);
  });

  it("returns empty when all files have coverage", () => {
    const dbPath = join(tmpDir, ".forgectl", "kg.db");
    const db = createKGDatabase(dbPath);
    saveTestMappings(db, [
      { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "import" },
      { sourceFile: "src/bar.ts", testFiles: ["test/bar.test.ts"], confidence: "name_match" },
    ]);
    db.close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts"], tmpDir);
    expect(gaps).toEqual([]);
  });

  it("returns empty when KG database does not exist", () => {
    const nonExistent = join(tmpDir, "no-such-dir");
    const gaps = findCoverageGaps(["src/foo.ts"], nonExistent);
    expect(gaps).toEqual([]);
  });
});

describe("PRProcessor.postMergeAnalysis", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw on error (try/catch)", async () => {
    const processor = new PRProcessor(makeConfig(), logger);
    const pr = makePR();

    // postMergeAnalysis with a non-existent tmpDir should not throw
    await expect(processor.postMergeAnalysis(pr, "/nonexistent-dir")).resolves.toBeUndefined();
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "merge-daemon",
      expect.stringContaining("Post-merge analysis failed"),
    );
  });

  it("posts comment when coverage gaps found", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pma-test-"));
    try {
      // Set up a git repo with one commit
      const { execSync } = await import("node:child_process");
      execSync("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
      const { writeFileSync } = await import("node:fs");
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(join(tmpDir, "src", "foo.ts"), "export const x = 1;");
      execSync("git add -A && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
      writeFileSync(join(tmpDir, "src", "bar.ts"), "export const y = 2;");
      execSync("git add -A && git commit -m 'add bar'", { cwd: tmpDir, stdio: "pipe" });

      // Create KG database with mapping for foo only
      mkdirSync(join(tmpDir, ".forgectl"), { recursive: true });
      const db = createKGDatabase(join(tmpDir, ".forgectl", "kg.db"));
      saveTestMappings(db, [
        { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "import" },
      ]);
      db.close();

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

      const processor = new PRProcessor(makeConfig(), logger);
      const pr = makePR();
      await processor.postMergeAnalysis(pr, tmpDir);

      // Should have posted a comment about src/bar.ts
      expect(fetchSpy).toHaveBeenCalled();
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const commentBody = JSON.parse((lastCall[1] as RequestInit).body as string).body;
      expect(commentBody).toContain("src/bar.ts");
      expect(commentBody).toContain("no test coverage mapping found");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
