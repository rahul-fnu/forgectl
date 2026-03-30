import { describe, it, expect } from "vitest";
import { buildPrompt, buildHandoffContext, type HandoffEntry } from "../../src/context/prompt.js";
import type { RunPlan } from "../../src/workflow/types.js";

function makeMinimalPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    runId: "forge-test-001",
    task: "Add a healthcheck endpoint",
    workflow: {
      name: "code",
      description: "Code workflow",
      container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: ["node", "npm"],
      system: "You are an expert software engineer.",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
    },
    agent: { type: "claude-code", model: "", maxTurns: 50, timeout: 1800000, flags: [] },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: { mode: "repo", sources: ["/repo"], mountPath: "/workspace", exclude: [] },
    context: { system: "", files: [], inject: [] },
    validation: { steps: [], onFailure: "abandon" },
    output: { mode: "git", path: "/workspace", collect: [], hostDir: "/output" },
    orchestration: {
      mode: "single",
      review: { enabled: false, system: "", maxRounds: 3, agent: "claude-code", model: "" },
    },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", includeTask: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    ...overrides,
  } as RunPlan;
}

describe("buildPrompt", () => {
  it("includes the task", () => {
    const prompt = buildPrompt(makeMinimalPlan());
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("Add a healthcheck endpoint");
  });

  it("does not include system prompt, tools, or context files", () => {
    const prompt = buildPrompt(makeMinimalPlan());
    expect(prompt).not.toContain("expert software engineer");
    expect(prompt).not.toContain("Available tools");
    expect(prompt).not.toContain("Context:");
  });

  it("includes validation instructions when steps exist", () => {
    const plan = makeMinimalPlan({
      validation: {
        steps: [
          { name: "lint", command: "npm run lint", retries: 3, description: "ESLint check" },
          { name: "test", command: "npm test", retries: 3, description: "Unit tests" },
        ],
        onFailure: "abandon",
      },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Verification");
    expect(prompt).toContain("must ALL pass");
    expect(prompt).toContain("lint");
    expect(prompt).toContain("`npm run lint`");
    expect(prompt).toContain("test");
    expect(prompt).toContain("`npm test`");
  });

  it("omits validation section when no steps", () => {
    const prompt = buildPrompt(makeMinimalPlan({ validation: { steps: [], onFailure: "abandon" } }));
    expect(prompt).not.toContain("Verification");
    expect(prompt).not.toContain("Reproduce");
  });

  it("splits reproduction and verification steps", () => {
    const plan = makeMinimalPlan({
      validation: {
        steps: [
          { name: "repro", command: "npm test -- --grep bug", retries: 0, description: "Reproduce the bug", expect_failure: true, before_fix: true },
          { name: "lint", command: "npm run lint", retries: 3, description: "ESLint check", expect_failure: false, before_fix: false },
        ],
        onFailure: "abandon",
      },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Reproduce");
    expect(prompt).toContain("should FAIL before your fix");
    expect(prompt).toContain("repro");
    expect(prompt).toContain("Verification");
    expect(prompt).toContain("must ALL pass");
    expect(prompt).toContain("lint");
  });

  it("shows only verification section when no before_fix steps", () => {
    const plan = makeMinimalPlan({
      validation: {
        steps: [
          { name: "test", command: "npm test", retries: 3, description: "Unit tests", expect_failure: false, before_fix: false },
        ],
        onFailure: "abandon",
      },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Verification");
    expect(prompt).not.toContain("Reproduce");
  });

  it("includes output path instruction for files mode", () => {
    const plan = makeMinimalPlan({
      output: { mode: "files", path: "/output", collect: [], hostDir: "/host/output" },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Save all output files to /output");
  });

  it("does not include output path instruction for git mode", () => {
    const prompt = buildPrompt(makeMinimalPlan());
    expect(prompt).not.toContain("Save all output files");
  });

  it("accepts promotedFindings option without error (ignored)", () => {
    const prompt = buildPrompt(makeMinimalPlan(), {
      promotedFindings: [
        {
          id: 1,
          category: "error_handling",
          pattern: "error_handling",
          module: "src/storage",
          occurrenceCount: 5,
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-03-01T00:00:00Z",
          promotedToConvention: true,
          exampleComment: "Always handle errors in database calls with typed errors",
        },
      ],
    });
    expect(prompt).toContain("## Task");
  });

  it("prepends handoff context when provided", () => {
    const prompt = buildPrompt(makeMinimalPlan(), {
      handoffContext: "## Previous Work\n- user-model merged; 3 file(s) changed",
    });
    expect(prompt).toContain("## Previous Work");
    expect(prompt).toContain("user-model merged");
    // Handoff context should appear before the task
    const handoffIdx = prompt.indexOf("## Previous Work");
    const taskIdx = prompt.indexOf("## Task");
    expect(handoffIdx).toBeLessThan(taskIdx);
  });
});

describe("buildHandoffContext", () => {
  it("returns empty string for no entries", () => {
    expect(buildHandoffContext([])).toBe("");
  });

  it("returns empty string when all entries are non-completed", () => {
    const entries: HandoffEntry[] = [
      { nodeId: "task-a", status: "failed" },
      { nodeId: "task-b", status: "skipped" },
    ];
    expect(buildHandoffContext(entries)).toBe("");
  });

  it("includes completed entry with diffStat", () => {
    const entries: HandoffEntry[] = [
      {
        nodeId: "user-model",
        status: "completed",
        filesChanged: 3,
        diffStat: "3 files changed, 50 insertions(+), 10 deletions(-)",
        branch: "forge/user-model/abc",
      },
    ];
    const result = buildHandoffContext(entries);
    expect(result).toContain("## Previous Work");
    expect(result).toContain("user-model merged");
    expect(result).toContain("3 files changed, 50 insertions(+), 10 deletions(-)");
    expect(result).toContain("branch: forge/user-model/abc");
  });

  it("uses filesChanged when diffStat is missing", () => {
    const entries: HandoffEntry[] = [
      { nodeId: "auth-routes", status: "completed", filesChanged: 5 },
    ];
    const result = buildHandoffContext(entries);
    expect(result).toContain("5 file(s) changed");
  });

  it("includes output files for files mode", () => {
    const entries: HandoffEntry[] = [
      {
        nodeId: "research",
        status: "completed",
        outputFiles: ["report.md", "data.csv", "chart.png", "extra.txt"],
      },
    ];
    const result = buildHandoffContext(entries);
    expect(result).toContain("files: report.md, data.csv, chart.png +1 more");
  });

  it("limits output to 5 lines", () => {
    const entries: HandoffEntry[] = Array.from({ length: 8 }, (_, i) => ({
      nodeId: `task-${i}`,
      status: "completed" as const,
      filesChanged: i + 1,
    }));
    const result = buildHandoffContext(entries);
    const lines = result.split("\n").filter(l => l.startsWith("- "));
    expect(lines.length).toBe(5);
  });

  it("task 2 prompt includes task 1 summary", () => {
    // Verification scenario from the issue: Task 2 prompt includes Task 1 summary
    const task1Result: HandoffEntry = {
      nodeId: "RAH-300",
      status: "completed",
      filesChanged: 1,
      diffStat: "1 file changed, 42 insertions(+)",
      branch: "forge/rah-300/impl",
    };
    const handoff = buildHandoffContext([task1Result]);

    const plan = makeMinimalPlan({ task: "Build on the billing module from RAH-300" });
    const prompt = buildPrompt(plan, { handoffContext: handoff });

    expect(prompt).toContain("RAH-300 merged");
    expect(prompt).toContain("1 file changed, 42 insertions(+)");
    expect(prompt).toContain("Build on the billing module from RAH-300");
  });
});
