import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrompt } from "../../src/context/prompt.js";
import type { RunPlan } from "../../src/workflow/types.js";

function makePlan(contextFiles: string[]): RunPlan {
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
    context: { system: "", files: contextFiles, inject: [] },
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

describe("buildPrompt binary/large context behavior", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("inlines text context and keeps binary as artifact manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "forgectl-prompt-"));
    dirs.push(dir);
    const textPath = join(dir, "notes.md");
    const binaryPath = join(dir, "diagram.png");
    writeFileSync(textPath, "# Notes\nHello\n", "utf-8");
    writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

    const prompt = buildPrompt(makePlan([textPath, binaryPath]));
    expect(prompt).toContain("--- Context: notes.md ---");
    expect(prompt).toContain("Hello");
    expect(prompt).toContain("Context Artifacts Manifest");
    expect(prompt).toContain("diagram.png");
    expect(prompt).toContain("binary");
  });

  it("does not inline large text files and lists them in artifact manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "forgectl-prompt-large-"));
    dirs.push(dir);
    const largePath = join(dir, "large.md");
    writeFileSync(largePath, "a".repeat(70 * 1024), "utf-8");

    const prompt = buildPrompt(makePlan([largePath]));
    expect(prompt).toContain("Context Artifacts Manifest");
    expect(prompt).toContain("large.md");
    expect(prompt).toContain("large-text");
    expect(prompt).not.toContain("a".repeat(200));
  });
});
