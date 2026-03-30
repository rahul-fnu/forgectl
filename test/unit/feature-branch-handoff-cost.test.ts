import { describe, it, expect } from "vitest";
import { isComplexTask, type RunPlan } from "../../src/workflow/types.js";
import { predictCost, buildPlanPreview } from "../../src/analysis/cost-predictor.js";
import { buildHandoffContext, type HandoffEntry } from "../../src/context/prompt.js";

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
    validation: { steps: [], lintSteps: [], onFailure: "abandon", maxSameFailures: 2, onRepeatedFailure: "abort" },
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

describe("isComplexTask", () => {
  it("returns false for simple task with no validation steps", () => {
    const plan = makeMinimalPlan();
    expect(isComplexTask(plan)).toBe(false);
  });

  it("returns false for task with only validation steps but no lint steps", () => {
    const plan = makeMinimalPlan({
      validation: {
        steps: [
          { name: "test", command: "npm test", retries: 3, description: "" },
          { name: "build", command: "npm run build", retries: 3, description: "" },
        ],
        lintSteps: [],
        onFailure: "abandon",
        maxSameFailures: 2,
        onRepeatedFailure: "abort",
      },
    });
    expect(isComplexTask(plan)).toBe(false);
  });

  it("returns true for task with multiple validation steps AND lint steps", () => {
    const plan = makeMinimalPlan({
      validation: {
        steps: [
          { name: "test", command: "npm test", retries: 3, description: "" },
          { name: "build", command: "npm run build", retries: 3, description: "" },
        ],
        lintSteps: [
          { name: "lint", command: "npm run lint", retries: 3, description: "" },
        ],
        onFailure: "abandon",
        maxSameFailures: 2,
        onRepeatedFailure: "abort",
      },
    });
    expect(isComplexTask(plan)).toBe(true);
  });

  it("returns true for long task descriptions (>500 chars)", () => {
    const longTask = "x".repeat(501);
    const plan = makeMinimalPlan({ task: longTask });
    expect(isComplexTask(plan)).toBe(true);
  });

  it("returns false for task at exactly 500 chars", () => {
    const plan = makeMinimalPlan({ task: "x".repeat(500) });
    expect(isComplexTask(plan)).toBe(false);
  });
});

describe("RunPlan featureBranch field", () => {
  it("is undefined by default", () => {
    const plan = makeMinimalPlan();
    expect(plan.featureBranch).toBeUndefined();
  });

  it("can be set explicitly", () => {
    const plan = makeMinimalPlan({ featureBranch: "feature/my-feature" });
    expect(plan.featureBranch).toBe("feature/my-feature");
  });
});

describe("RunPlan handoffEntries field", () => {
  it("is undefined by default", () => {
    const plan = makeMinimalPlan();
    expect(plan.handoffEntries).toBeUndefined();
  });

  it("can be set with handoff entries", () => {
    const entries: HandoffEntry[] = [
      { nodeId: "task-1", status: "completed", filesChanged: 3 },
    ];
    const plan = makeMinimalPlan({ handoffEntries: entries });
    expect(plan.handoffEntries).toHaveLength(1);
    expect(plan.handoffEntries![0].nodeId).toBe("task-1");
  });

  it("handoff context integrates with buildHandoffContext", () => {
    const entries: HandoffEntry[] = [
      { nodeId: "auth-module", status: "completed", filesChanged: 5, branch: "forge/auth/001" },
    ];
    const ctx = buildHandoffContext(entries);
    expect(ctx).toContain("## Previous Work");
    expect(ctx).toContain("auth-module merged");
  });
});

describe("cost prediction (predictCost)", () => {
  it("returns default prediction with no historical data", () => {
    const prediction = predictCost([], new Map());
    expect(prediction.confidence).toBe(0.1);
    expect(prediction.basedOnRuns).toBe(0);
    expect(prediction.estimatedCostUsd).toBeGreaterThan(0);
    expect(prediction.estimatedTurns).toBeGreaterThan(0);
  });

  it("scales prediction by complexity label", () => {
    const low = predictCost([], new Map(), "low");
    const high = predictCost([], new Map(), "high");
    expect(high.estimatedCostUsd).toBeGreaterThan(low.estimatedCostUsd);
    expect(high.estimatedTurns).toBeGreaterThan(low.estimatedTurns);
  });

  it("uses historical data when available", () => {
    const outcomes = [
      {
        id: "run-1",
        taskId: null,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:05:00Z",
        status: "success",
        totalTurns: 10,
        lintIterations: null,
        reviewRounds: null,
        reviewCommentsJson: null,
        failureMode: null,
        failureDetail: null,
        humanReviewResult: null,
        humanReviewComments: null,
        modulesTouched: null,
        filesChanged: null,
        testsAdded: null,
        rawEventsJson: null,
        contextEnabled: null,
        contextFilesJson: null,
        contextHitRate: null,
        recovered: null,
      },
    ];
    const costs = new Map([
      ["run-1", { totalCostUsd: 0.25, totalInputTokens: 50000, totalOutputTokens: 10000, recordCount: 1 }],
    ]);
    const prediction = predictCost(outcomes, costs);
    expect(prediction.basedOnRuns).toBe(1);
    expect(prediction.confidence).toBeGreaterThan(0);
    expect(prediction.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe("buildPlanPreview", () => {
  it("builds a plan preview with prediction data", () => {
    const prediction = predictCost([], new Map());
    const preview = buildPlanPreview("run-1", "Add authentication module", prediction);
    expect(preview.runId).toBe("run-1");
    expect(preview.task).toBe("Add authentication module");
    expect(preview.prediction).toBe(prediction);
    expect(preview.planBullets.length).toBeGreaterThan(0);
  });

  it("extracts bullet points from task description", () => {
    const prediction = predictCost([], new Map());
    const task = `Implement the following:
- Add user model
- Create auth routes
- Write tests`;
    const preview = buildPlanPreview("run-2", task, prediction);
    expect(preview.planBullets).toContain("Add user model");
    expect(preview.planBullets).toContain("Create auth routes");
    expect(preview.planBullets).toContain("Write tests");
  });
});
