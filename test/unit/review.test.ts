import { describe, it, expect } from "vitest";
import {
  parseReviewResult,
  parseReviewComments,
  filterActionableComments,
  buildReviewPrompt,
  buildFixPrompt,
  buildStructuredFixPrompt,
  buildDiffScopedReviewPrompt,
} from "../../src/orchestration/review.js";
import type { ReviewComment } from "../../src/orchestration/review.js";
import type { RunPlan } from "../../src/workflow/types.js";

function makePlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    runId: "forge-test-001",
    task: "Add rate limiting to the API",
    workflow: {
      name: "code",
      description: "Code workflow",
      container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: ["git", "node/npm"],
      system: "You are an expert software engineer.",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: {
        enabled: true,
        system: "You are a senior code reviewer.",
      },
    },
    agent: {
      type: "claude-code",
      model: "claude-sonnet-4-20250514",
      maxTurns: 50,
      timeout: 300000,
      flags: [],
    },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: {
      mode: "repo",
      sources: ["/tmp/test-repo"],
      mountPath: "/workspace",
      exclude: ["node_modules"],
    },
    context: { system: "", files: [], inject: [] },
    validation: { steps: [], onFailure: "abandon" },
    output: {
      mode: "git",
      path: "/workspace",
      collect: [],
      hostDir: "/tmp/output",
    },
    orchestration: {
      mode: "review",
      review: {
        enabled: true,
        system: "You are a senior code reviewer. Check for bugs and security issues.",
        maxRounds: 3,
        agent: "claude-code",
        model: "claude-sonnet-4-20250514",
      },
    },
    commit: {
      message: { prefix: "forge:", template: "{{task}}", includeTask: true },
      author: { name: "forgectl", email: "forgectl@localhost" },
      sign: false,
    },
    ...overrides,
  } as RunPlan;
}

describe("parseReviewResult", () => {
  it("detects LGTM at end of output", () => {
    const result = parseReviewResult("Everything looks good.\n\nLGTM");
    expect(result.approved).toBe(true);
    expect(result.feedback).toBe("");
  });

  it("detects LGTM on its own line", () => {
    const result = parseReviewResult("LGTM");
    expect(result.approved).toBe(true);
  });

  it("detects LGTM case-insensitively", () => {
    const result = parseReviewResult("lgtm");
    expect(result.approved).toBe(true);
  });

  it("detects Lgtm mixed case", () => {
    const result = parseReviewResult("Lgtm");
    expect(result.approved).toBe(true);
  });

  it("detects APPROVED", () => {
    const result = parseReviewResult("The code is well-written.\n\nAPPROVED");
    expect(result.approved).toBe(true);
    expect(result.feedback).toBe("");
  });

  it("detects Approved case-insensitively", () => {
    const result = parseReviewResult("Approved");
    expect(result.approved).toBe(true);
  });

  it("detects LGTM with surrounding text in last lines", () => {
    const result = parseReviewResult("Reviewed the changes.\nAll checks pass.\nLGTM - ship it!");
    expect(result.approved).toBe(true);
  });

  it("returns approved=false when issues are listed", () => {
    const issues = `1. Missing error handling in /api/upload
2. No rate limit tests
3. Hardcoded timeout value`;
    const result = parseReviewResult(issues);
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe(issues);
  });

  it("returns full output as feedback when not approved", () => {
    const output = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nIssues found.";
    const result = parseReviewResult(output);
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe(output);
  });

  it("does not approve when LGTM appears early but issues are at the end", () => {
    const output = "Initially LGTM but then:\n\n\n\n\n\n1. Found a security issue\n2. Missing validation";
    const result = parseReviewResult(output);
    expect(result.approved).toBe(false);
  });

  it("handles empty output", () => {
    const result = parseReviewResult("");
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe("");
  });

  it("handles output with only whitespace", () => {
    const result = parseReviewResult("   \n\n   ");
    expect(result.approved).toBe(false);
  });

  it("trims whitespace around output", () => {
    const result = parseReviewResult("  \n  LGTM  \n  ");
    expect(result.approved).toBe(true);
  });

  it("detects LGTM as word boundary (not partial match)", () => {
    // "LGTM" should match as a word
    const result = parseReviewResult("LGTM");
    expect(result.approved).toBe(true);
  });
});

describe("buildReviewPrompt", () => {
  it("includes reviewer system prompt", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("You are a senior code reviewer");
  });

  it("includes original task", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("Add rate limiting to the API");
    expect(prompt).toContain("--- Original Task ---");
  });

  it("includes round number", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 2);
    expect(prompt).toContain("review round 2");
  });

  it("includes git diff instruction for git output mode", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("git diff HEAD~1");
  });

  it("includes file path instruction for files output mode", () => {
    const plan = makePlan({
      output: { mode: "files", path: "/output", collect: ["*"], hostDir: "/tmp/out" },
    });
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("/output");
    expect(prompt).toContain("output files");
  });

  it("includes LGTM instruction", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("LGTM");
  });

  it("includes structured output instructions", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain("MUST_FIX");
    expect(prompt).toContain("SHOULD_FIX");
    expect(prompt).toContain("NIT");
  });
});

describe("buildFixPrompt", () => {
  it("includes round number", () => {
    const prompt = buildFixPrompt("Some issue found", 1);
    expect(prompt).toContain("round 1");
  });

  it("includes review feedback", () => {
    const feedback = "1. Missing error handling\n2. No tests";
    const prompt = buildFixPrompt(feedback, 2);
    expect(prompt).toContain("Missing error handling");
    expect(prompt).toContain("No tests");
  });

  it("includes REVIEW FEEDBACK header", () => {
    const prompt = buildFixPrompt("issue", 1);
    expect(prompt).toContain("REVIEW FEEDBACK");
  });

  it("includes fix instruction", () => {
    const prompt = buildFixPrompt("issue", 1);
    expect(prompt).toContain("Fix all issues listed above");
  });

  it("mentions reviewer will check again", () => {
    const prompt = buildFixPrompt("issue", 1);
    expect(prompt).toContain("reviewer will check again");
  });
});

describe("parseReviewComments", () => {
  it("parses valid structured JSON comments", () => {
    const output = `Some preamble text\n\`\`\`json\n[{"file":"src/foo.ts","line":42,"severity":"MUST_FIX","message":"Missing null check","suggested_fix":"Add guard"}]\n\`\`\``;
    const comments = parseReviewComments(output);
    expect(comments).toHaveLength(1);
    expect(comments[0].file).toBe("src/foo.ts");
    expect(comments[0].line).toBe(42);
    expect(comments[0].severity).toBe("MUST_FIX");
    expect(comments[0].message).toBe("Missing null check");
    expect(comments[0].suggested_fix).toBe("Add guard");
  });

  it("parses multiple comments", () => {
    const output = '```json\n[{"file":"a.ts","line":1,"severity":"MUST_FIX","message":"bug"},{"file":"b.ts","line":2,"severity":"SHOULD_FIX","message":"style"},{"file":"c.ts","line":3,"severity":"NIT","message":"nit"}]\n```';
    const comments = parseReviewComments(output);
    expect(comments).toHaveLength(3);
  });

  it("returns empty array for no JSON block", () => {
    expect(parseReviewComments("Just plain text feedback")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseReviewComments("```json\nnot json\n```")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseReviewComments('```json\n{"file":"a.ts"}\n```')).toEqual([]);
  });

  it("filters out comments with invalid severity", () => {
    const output = '```json\n[{"file":"a.ts","line":1,"severity":"CRITICAL","message":"bug"}]\n```';
    expect(parseReviewComments(output)).toEqual([]);
  });

  it("filters out comments with missing required fields", () => {
    const output = '```json\n[{"file":"a.ts","severity":"MUST_FIX","message":"bug"}]\n```';
    expect(parseReviewComments(output)).toEqual([]);
  });
});

describe("filterActionableComments", () => {
  const comments: ReviewComment[] = [
    { file: "a.ts", line: 1, severity: "MUST_FIX", message: "bug" },
    { file: "b.ts", line: 2, severity: "SHOULD_FIX", message: "style" },
    { file: "c.ts", line: 3, severity: "NIT", message: "nit" },
  ];

  it("keeps MUST_FIX and SHOULD_FIX, drops NIT", () => {
    const result = filterActionableComments(comments);
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe("MUST_FIX");
    expect(result[1].severity).toBe("SHOULD_FIX");
  });

  it("returns empty array when all are NITs", () => {
    const nits: ReviewComment[] = [
      { file: "a.ts", line: 1, severity: "NIT", message: "nit1" },
      { file: "b.ts", line: 2, severity: "NIT", message: "nit2" },
    ];
    expect(filterActionableComments(nits)).toEqual([]);
  });
});

describe("buildStructuredFixPrompt", () => {
  it("includes file:line for each comment", () => {
    const comments: ReviewComment[] = [
      { file: "src/foo.ts", line: 42, severity: "MUST_FIX", message: "Missing null check", suggested_fix: "Add guard" },
    ];
    const prompt = buildStructuredFixPrompt(comments, 1);
    expect(prompt).toContain("src/foo.ts:42");
    expect(prompt).toContain("MUST_FIX");
    expect(prompt).toContain("Missing null check");
    expect(prompt).toContain("Suggested fix: Add guard");
  });

  it("includes round number", () => {
    const prompt = buildStructuredFixPrompt([], 2);
    expect(prompt).toContain("round 2");
  });

  it("includes fix instruction", () => {
    const prompt = buildStructuredFixPrompt([], 1);
    expect(prompt).toContain("Fix all MUST_FIX and SHOULD_FIX issues");
  });
});

describe("buildDiffScopedReviewPrompt", () => {
  it("lists changed files", () => {
    const plan = makePlan();
    const prompt = buildDiffScopedReviewPrompt(plan, 2, ["src/foo.ts", "src/bar.ts"], []);
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("src/bar.ts");
    expect(prompt).toContain("re-review round 2");
  });

  it("lists previously flagged issues", () => {
    const plan = makePlan();
    const prev: ReviewComment[] = [
      { file: "src/foo.ts", line: 42, severity: "MUST_FIX", message: "Missing null check" },
    ];
    const prompt = buildDiffScopedReviewPrompt(plan, 2, ["src/foo.ts"], prev);
    expect(prompt).toContain("Previously flagged issues");
    expect(prompt).toContain("src/foo.ts:42");
    expect(prompt).toContain("Missing null check");
  });

  it("instructs not to review files outside the list", () => {
    const plan = makePlan();
    const prompt = buildDiffScopedReviewPrompt(plan, 2, ["src/foo.ts"], []);
    expect(prompt).toContain("Do NOT review files outside the list");
  });

  it("includes reviewer system prompt", () => {
    const plan = makePlan();
    const prompt = buildDiffScopedReviewPrompt(plan, 2, [], []);
    expect(prompt).toContain("You are a senior code reviewer");
  });
});

describe("parseReviewResult with structured comments", () => {
  it("extracts structured comments from non-approved output", () => {
    const output = 'Issues found:\n```json\n[{"file":"src/foo.ts","line":42,"severity":"MUST_FIX","message":"Missing null check"}]\n```';
    const result = parseReviewResult(output);
    expect(result.approved).toBe(false);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].severity).toBe("MUST_FIX");
  });

  it("returns empty comments array when approved", () => {
    const result = parseReviewResult("LGTM");
    expect(result.approved).toBe(true);
    expect(result.comments).toEqual([]);
  });

  it("returns empty comments array when no JSON block present", () => {
    const result = parseReviewResult("1. Issue A\n2. Issue B");
    expect(result.approved).toBe(false);
    expect(result.comments).toEqual([]);
    expect(result.feedback).toContain("Issue A");
  });
});
