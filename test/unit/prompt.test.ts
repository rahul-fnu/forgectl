import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPrompt } from "../../src/context/prompt.js";
import type { RunPlan } from "../../src/workflow/types.js";

// Mock fs to control file reads
vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => path.endsWith("context.md")),
  readFileSync: vi.fn(() => "context file content"),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes the workflow system prompt", () => {
    const plan = makeMinimalPlan();
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("You are an expert software engineer.");
  });

  it("uses context.system override when provided", () => {
    const plan = makeMinimalPlan({
      context: { system: "Custom system prompt", files: [], inject: [] },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Custom system prompt");
  });

  it("includes the task", () => {
    const plan = makeMinimalPlan();
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Add a healthcheck endpoint");
    expect(prompt).toContain("--- Task ---");
  });

  it("includes available tools", () => {
    const plan = makeMinimalPlan();
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("node, npm");
    expect(prompt).toContain("Available tools");
  });

  it("omits tools section when no tools defined", () => {
    const plan = makeMinimalPlan();
    plan.workflow.tools = [];
    const prompt = buildPrompt(plan);
    expect(prompt).not.toContain("Available tools");
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
    expect(prompt).toContain("validation checks will run");
    expect(prompt).toContain("lint");
    expect(prompt).toContain("npm run lint");
    expect(prompt).toContain("test");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("If any check fails");
  });

  it("omits validation section when no steps", () => {
    const plan = makeMinimalPlan({ validation: { steps: [], onFailure: "abandon" } });
    const prompt = buildPrompt(plan);
    expect(prompt).not.toContain("validation checks will run");
  });

  it("includes output path instruction for files mode", () => {
    const plan = makeMinimalPlan({
      output: { mode: "files", path: "/output", collect: [], hostDir: "/host/output" },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).toContain("Save all output files to /output");
  });

  it("does not include output path instruction for git mode", () => {
    const plan = makeMinimalPlan({
      output: { mode: "git", path: "/workspace", collect: [], hostDir: "" },
    });
    const prompt = buildPrompt(plan);
    expect(prompt).not.toContain("Save all output files");
  });

  it("includes promoted review findings as conventions", () => {
    const plan = makeMinimalPlan();
    const prompt = buildPrompt(plan, {
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
    expect(prompt).toContain("Review Conventions");
    expect(prompt).toContain("Always handle errors in database calls with typed errors");
    expect(prompt).toContain("flagged 5 times in review");
    expect(prompt).toContain("module: src/storage");
  });

  it("omits conventions section when no promoted findings", () => {
    const plan = makeMinimalPlan();
    const prompt = buildPrompt(plan, { promotedFindings: [] });
    expect(prompt).not.toContain("Review Conventions");
  });

  it("still works with ContextResult as second argument (backward compat)", () => {
    const plan = makeMinimalPlan();
    const kgContext = {
      systemContext: "KG system context",
      taskContext: "KG task context",
      budget: { used: 100, max: 1000, reservedForAgent: 500 },
      merkleRoot: "abc123",
      includedFiles: [],
    };
    const prompt = buildPrompt(plan, kgContext);
    expect(prompt).toContain("KG system context");
    expect(prompt).toContain("KG task context");
  });
});
