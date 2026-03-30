import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../src/context/prompt.js";
import type { RunPlan } from "../../src/workflow/types.js";

function makePlan(): RunPlan {
  return {
    runId: "run-1",
    task: "test task",
    workflow: {
      name: "code",
      description: "code",
      container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: ["node"],
      system: "system prompt",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
    },
    agent: { type: "codex", model: "gpt-5", maxTurns: 10, timeout: 60_000, flags: [] },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: { mode: "repo", sources: ["/repo"], mountPath: "/workspace", exclude: [] },
    context: { system: "", files: ["/tmp/nonexistent.md"], inject: [] },
    validation: { steps: [], onFailure: "abandon" },
    output: { mode: "git", path: "/workspace", collect: [], hostDir: "/tmp/out" },
    orchestration: {
      mode: "single",
      review: { enabled: false, system: "", maxRounds: 1, agent: "codex", model: "gpt-5" },
    },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", includeTask: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
  };
}

describe("buildPrompt simplified (no context file inlining)", () => {
  it("does not inline context files — agent reads CLAUDE.md natively", () => {
    const prompt = buildPrompt(makePlan());
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("test task");
    expect(prompt).not.toContain("Context:");
    expect(prompt).not.toContain("Artifacts Manifest");
  });
});
