import { describe, it, expect, vi } from "vitest";
import {
  createCheckRun,
  updateCheckRun,
  completeCheckRun,
  buildCheckSummary,
} from "../../src/github/checks.js";
import type { RunResult } from "../../src/github/comments.js";

function mockOctokit() {
  return {
    rest: {
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 42 } }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("createCheckRun", () => {
  it("calls octokit.rest.checks.create with head_sha, name forgectl, status in_progress", async () => {
    const octokit = mockOctokit();
    const id = await createCheckRun(octokit as any, "owner", "repo", "abc123", "run-1");
    expect(octokit.rest.checks.create).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      head_sha: "abc123",
      name: "forgectl",
      status: "in_progress",
      external_id: "run-1",
    });
    expect(id).toBe(42);
  });
});

describe("completeCheckRun", () => {
  it("calls checks.update with conclusion success and output summary", async () => {
    const octokit = mockOctokit();
    await completeCheckRun(octokit as any, "owner", "repo", 42, true, "All passed");
    expect(octokit.rest.checks.update).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      check_run_id: 42,
      status: "completed",
      conclusion: "success",
      output: {
        title: "forgectl - success",
        summary: "All passed",
      },
    });
  });

  it("calls checks.update with conclusion failure on failure", async () => {
    const octokit = mockOctokit();
    await completeCheckRun(octokit as any, "owner", "repo", 42, false, "Tests failed");
    expect(octokit.rest.checks.update).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      check_run_id: 42,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "forgectl - failure",
        summary: "Tests failed",
      },
    });
  });
});

describe("updateCheckRun", () => {
  it("calls checks.update with status and optional output", async () => {
    const octokit = mockOctokit();
    await updateCheckRun(octokit as any, "owner", "repo", 42, "in_progress", {
      title: "Running",
      summary: "Step 2 of 3",
    });
    expect(octokit.rest.checks.update).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      check_run_id: 42,
      status: "in_progress",
      output: { title: "Running", summary: "Step 2 of 3" },
    });
  });

  it("calls checks.update without output when not provided", async () => {
    const octokit = mockOctokit();
    await updateCheckRun(octokit as any, "owner", "repo", 42, "in_progress");
    expect(octokit.rest.checks.update).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      check_run_id: 42,
      status: "in_progress",
    });
  });
});

describe("buildCheckSummary", () => {
  it("produces markdown summary from run result", () => {
    const result: RunResult = {
      runId: "run-1",
      status: "success",
      duration: "2m30s",
      cost: { input_tokens: 1000, output_tokens: 500, estimated_usd: "$0.01" },
      changes: ["src/foo.ts", "src/bar.ts"],
      validationResults: [
        { step: "typecheck", passed: true },
        { step: "test", passed: false, output: "1 test failed" },
      ],
      workflow: "code",
      agent: "claude",
    };
    const summary = buildCheckSummary(result);
    expect(summary).toContain("run-1");
    expect(summary).toContain("2m30s");
    expect(summary).toContain("$0.01");
    expect(summary).toContain("src/foo.ts");
    expect(summary).toContain("typecheck");
  });
});
