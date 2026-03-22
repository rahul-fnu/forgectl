import { describe, it, expect } from "vitest";
import {
  buildReviewAgentPrompt,
  parseReviewOutput,
  serializeReviewOutput,
} from "../../src/validation/review-agent.js";
import type { ReviewOutput } from "../../src/validation/review-agent.js";

describe("buildReviewAgentPrompt", () => {
  it("includes the task description", () => {
    const prompt = buildReviewAgentPrompt("Add rate limiting", "/workspace");
    expect(prompt).toContain("Add rate limiting");
  });

  it("includes the working directory", () => {
    const prompt = buildReviewAgentPrompt("Fix bug", "/workspace");
    expect(prompt).toContain("/workspace");
  });

  it("mentions git diff for reviewing changes", () => {
    const prompt = buildReviewAgentPrompt("Fix bug", "/workspace");
    expect(prompt).toContain("git diff HEAD~1");
  });

  it("includes all five review categories", () => {
    const prompt = buildReviewAgentPrompt("task", "/workspace");
    expect(prompt).toContain("architectural patterns");
    expect(prompt).toContain("edge cases");
    expect(prompt).toContain("error handling");
    expect(prompt).toContain("abstraction level");
    expect(prompt).toContain("coupling");
  });

  it("includes severity level definitions", () => {
    const prompt = buildReviewAgentPrompt("task", "/workspace");
    expect(prompt).toContain("MUST_FIX");
    expect(prompt).toContain("SHOULD_FIX");
    expect(prompt).toContain("NIT");
  });

  it("includes YAML format example", () => {
    const prompt = buildReviewAgentPrompt("task", "/workspace");
    expect(prompt).toContain("comments:");
    expect(prompt).toContain("summary:");
    expect(prompt).toContain("severity:");
  });

  it("mentions code has already passed linting", () => {
    const prompt = buildReviewAgentPrompt("task", "/workspace");
    expect(prompt).toContain("passed linting");
  });
});

describe("parseReviewOutput", () => {
  it("parses valid YAML with comments and summary", () => {
    const yaml = `comments:
  - file: src/auth/middleware.ts
    line: 47
    severity: MUST_FIX
    category: error_handling
    comment: "OAuth token refresh failure silently swallowed"
    suggested_fix: "Wrap in try/catch and throw AuthRefreshError"
  - file: src/utils/hash.ts
    line: 12
    severity: NIT
    category: naming
    comment: "Function name could be more descriptive"
summary:
  must_fix: 1
  should_fix: 0
  nit: 1
  overall: "Functional but needs error handling fix"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments).toHaveLength(2);
    expect(result!.comments[0].file).toBe("src/auth/middleware.ts");
    expect(result!.comments[0].line).toBe(47);
    expect(result!.comments[0].severity).toBe("MUST_FIX");
    expect(result!.comments[0].category).toBe("error_handling");
    expect(result!.comments[0].comment).toBe("OAuth token refresh failure silently swallowed");
    expect(result!.comments[0].suggested_fix).toBe("Wrap in try/catch and throw AuthRefreshError");
    expect(result!.comments[1].severity).toBe("NIT");
    expect(result!.summary.must_fix).toBe(1);
    expect(result!.summary.should_fix).toBe(0);
    expect(result!.summary.nit).toBe(1);
    expect(result!.summary.overall).toBe("Functional but needs error handling fix");
  });

  it("parses YAML wrapped in markdown fences", () => {
    const yaml = "```yaml\ncomments: []\nsummary:\n  must_fix: 0\n  should_fix: 0\n  nit: 0\n  overall: \"Clean\"\n```";
    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments).toHaveLength(0);
    expect(result!.summary.must_fix).toBe(0);
  });

  it("parses empty comments list", () => {
    const yaml = `comments: []
summary:
  must_fix: 0
  should_fix: 0
  nit: 0
  overall: "Code looks good"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments).toHaveLength(0);
    expect(result!.summary.overall).toBe("Code looks good");
  });

  it("returns undefined for empty input", () => {
    expect(parseReviewOutput("")).toBeUndefined();
  });

  it("returns undefined for invalid YAML", () => {
    expect(parseReviewOutput("not: [valid: yaml: {{")).toBeUndefined();
  });

  it("returns undefined for non-object YAML", () => {
    expect(parseReviewOutput("just a string")).toBeUndefined();
  });

  it("skips comments with missing required fields", () => {
    const yaml = `comments:
  - file: src/foo.ts
    line: 10
    severity: MUST_FIX
    comment: "Valid comment"
  - file: src/bar.ts
    severity: MUST_FIX
    comment: "Missing line"
  - file: src/baz.ts
    line: 20
    severity: INVALID
    comment: "Invalid severity"
summary:
  must_fix: 1
  should_fix: 0
  nit: 0
  overall: "Test"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].file).toBe("src/foo.ts");
  });

  it("normalizes severity to uppercase", () => {
    const yaml = `comments:
  - file: src/foo.ts
    line: 10
    severity: must_fix
    comment: "lowercase severity"
summary:
  must_fix: 1
  should_fix: 0
  nit: 0
  overall: "Test"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments[0].severity).toBe("MUST_FIX");
  });

  it("defaults category to general when missing", () => {
    const yaml = `comments:
  - file: src/foo.ts
    line: 10
    severity: SHOULD_FIX
    comment: "No category"
summary:
  must_fix: 0
  should_fix: 1
  nit: 0
  overall: "Test"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments[0].category).toBe("general");
  });

  it("computes summary from comments when summary is missing", () => {
    const yaml = `comments:
  - file: a.ts
    line: 1
    severity: MUST_FIX
    comment: "issue"
  - file: b.ts
    line: 2
    severity: SHOULD_FIX
    comment: "issue"
  - file: c.ts
    line: 3
    severity: NIT
    comment: "issue"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.summary.must_fix).toBe(1);
    expect(result!.summary.should_fix).toBe(1);
    expect(result!.summary.nit).toBe(1);
    expect(result!.summary.overall).toBe("No summary provided");
  });

  it("does not include suggested_fix when absent", () => {
    const yaml = `comments:
  - file: src/foo.ts
    line: 10
    severity: NIT
    comment: "Minor style issue"
summary:
  must_fix: 0
  should_fix: 0
  nit: 1
  overall: "Clean"`;

    const result = parseReviewOutput(yaml);
    expect(result).toBeDefined();
    expect(result!.comments[0]).not.toHaveProperty("suggested_fix");
  });
});

describe("serializeReviewOutput", () => {
  it("produces valid JSON", () => {
    const output: ReviewOutput = {
      comments: [
        {
          file: "src/foo.ts",
          line: 10,
          severity: "MUST_FIX",
          category: "error_handling",
          comment: "Missing error handler",
          suggested_fix: "Add try/catch",
        },
      ],
      summary: {
        must_fix: 1,
        should_fix: 0,
        nit: 0,
        overall: "Needs fix",
      },
    };

    const json = serializeReviewOutput(output);
    const parsed = JSON.parse(json);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].file).toBe("src/foo.ts");
    expect(parsed.summary.must_fix).toBe(1);
  });

  it("round-trips through JSON", () => {
    const output: ReviewOutput = {
      comments: [],
      summary: { must_fix: 0, should_fix: 0, nit: 0, overall: "Clean" },
    };

    const json = serializeReviewOutput(output);
    const parsed = JSON.parse(json) as ReviewOutput;
    expect(parsed).toEqual(output);
  });
});
