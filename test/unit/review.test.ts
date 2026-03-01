import { describe, it, expect } from "vitest";
import {
  parseReviewResult,
  buildReviewPrompt,
  buildFixPrompt,
} from "../../src/orchestration/review.js";
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

  it("includes instruction to list issues", () => {
    const plan = makePlan();
    const prompt = buildReviewPrompt(plan, 1);
    expect(prompt).toContain("list them numbered");
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
