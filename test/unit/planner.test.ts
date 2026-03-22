import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadGoal,
  buildPlanningPrompt,
  parsePlanResponse,
} from "../../src/planner/planner.js";
import { validatePlan } from "../../src/planner/validator.js";
import { createKGDatabase, saveModules } from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo } from "../../src/kg/types.js";
import type { ExecutionPlan } from "../../src/planner/types.js";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    tasks: [
      {
        id: "task-1",
        title: "First task",
        spec: {
          id: "task-1",
          title: "First task",
          context: { files: ["src/**/*.ts"] },
          constraints: ["No breaking changes"],
          acceptance: [{ run: "npm test", description: "Tests pass" }],
          decomposition: { strategy: "forbidden" },
          effort: { max_turns: 10 },
        },
        dependsOn: [],
        estimatedTurns: 10,
        riskNotes: "",
      },
    ],
    estimatedTurns: 10,
    riskLevel: "LOW",
    rationale: "Simple single-task plan",
    ...overrides,
  };
}

describe("parsePlanResponse", () => {
  it("parses valid JSON response", () => {
    const plan = makePlan();
    const json = JSON.stringify(plan);
    const parsed = parsePlanResponse(json);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe("task-1");
    expect(parsed.riskLevel).toBe("LOW");
    expect(parsed.estimatedTurns).toBe(10);
  });

  it("strips markdown code fences", () => {
    const plan = makePlan();
    const wrapped = "```json\n" + JSON.stringify(plan) + "\n```";
    const parsed = parsePlanResponse(wrapped);
    expect(parsed.tasks).toHaveLength(1);
  });

  it("extracts JSON from surrounding text", () => {
    const plan = makePlan();
    const withText = "Here is the plan:\n" + JSON.stringify(plan) + "\nDone.";
    const parsed = parsePlanResponse(withText);
    expect(parsed.tasks).toHaveLength(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePlanResponse("not json")).toThrow();
  });

  it("throws if tasks array is missing", () => {
    expect(() => parsePlanResponse(JSON.stringify({ estimatedTurns: 1, riskLevel: "LOW", rationale: "x" }))).toThrow("missing 'tasks'");
  });

  it("throws on invalid riskLevel", () => {
    const plan = makePlan({ riskLevel: "UNKNOWN" as never });
    expect(() => parsePlanResponse(JSON.stringify(plan))).toThrow("Invalid riskLevel");
  });

  it("defaults missing dependsOn to empty array", () => {
    const plan = makePlan();
    const raw = JSON.parse(JSON.stringify(plan));
    delete raw.tasks[0].dependsOn;
    const parsed = parsePlanResponse(JSON.stringify(raw));
    expect(parsed.tasks[0].dependsOn).toEqual([]);
  });

  it("defaults missing estimatedTurns on task to 10", () => {
    const plan = makePlan();
    const raw = JSON.parse(JSON.stringify(plan));
    delete raw.tasks[0].estimatedTurns;
    const parsed = parsePlanResponse(JSON.stringify(raw));
    expect(parsed.tasks[0].estimatedTurns).toBe(10);
  });
});

describe("validatePlan", () => {
  it("validates a correct plan", () => {
    const plan = makePlan();
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty plan", () => {
    const plan = makePlan({ tasks: [] });
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan has no tasks");
  });

  it("detects duplicate task IDs", () => {
    const plan = makePlan();
    plan.tasks.push({ ...plan.tasks[0] });
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Duplicate task ID"))).toBe(true);
  });

  it("detects dependency cycles", () => {
    const plan = makePlan({
      tasks: [
        {
          id: "a",
          title: "Task A",
          spec: {
            id: "a",
            title: "Task A",
            context: { files: ["src/**/*.ts"] },
            constraints: [],
            acceptance: [{ run: "npm test" }],
            decomposition: { strategy: "forbidden" },
            effort: { max_turns: 5 },
          },
          dependsOn: ["b"],
          estimatedTurns: 5,
          riskNotes: "",
        },
        {
          id: "b",
          title: "Task B",
          spec: {
            id: "b",
            title: "Task B",
            context: { files: ["src/**/*.ts"] },
            constraints: [],
            acceptance: [{ run: "npm test" }],
            decomposition: { strategy: "forbidden" },
            effort: { max_turns: 5 },
          },
          dependsOn: ["a"],
          estimatedTurns: 5,
          riskNotes: "",
        },
      ],
    });
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("cycle") || e.includes("Cycle"))).toBe(true);
  });

  it("detects unknown dependency references", () => {
    const plan = makePlan();
    plan.tasks[0].dependsOn = ["nonexistent"];
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("unknown task"))).toBe(true);
  });

  it("validates multi-task DAG without cycles", () => {
    const plan = makePlan({
      tasks: [
        {
          id: "a",
          title: "Task A",
          spec: {
            id: "a",
            title: "Task A",
            context: { files: ["src/**/*.ts"] },
            constraints: [],
            acceptance: [{ run: "npm test" }],
            decomposition: { strategy: "forbidden" },
            effort: { max_turns: 5 },
          },
          dependsOn: [],
          estimatedTurns: 5,
          riskNotes: "",
        },
        {
          id: "b",
          title: "Task B",
          spec: {
            id: "b",
            title: "Task B",
            context: { files: ["src/**/*.ts"] },
            constraints: [],
            acceptance: [{ run: "npm test" }],
            decomposition: { strategy: "forbidden" },
            effort: { max_turns: 5 },
          },
          dependsOn: ["a"],
          estimatedTurns: 5,
          riskNotes: "",
        },
        {
          id: "c",
          title: "Task C",
          spec: {
            id: "c",
            title: "Task C",
            context: { files: ["src/**/*.ts"] },
            constraints: [],
            acceptance: [{ run: "npm test" }],
            decomposition: { strategy: "forbidden" },
            effort: { max_turns: 5 },
          },
          dependsOn: ["a", "b"],
          estimatedTurns: 5,
          riskNotes: "",
        },
      ],
    });
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
  });

  it("warns about files not found in KG", () => {
    const db = createKGDatabase(":memory:");
    const plan = makePlan();
    plan.tasks[0].spec.context.files = ["src/nonexistent.ts"];
    const result = validatePlan(plan, db);
    expect(result.warnings.some(w => w.includes("not found in knowledge graph"))).toBe(true);
  });

  it("skips glob patterns for KG file check", () => {
    const db = createKGDatabase(":memory:");
    const plan = makePlan();
    plan.tasks[0].spec.context.files = ["src/**/*.ts"];
    const result = validatePlan(plan, db);
    // Should not warn about glob patterns
    expect(result.warnings.filter(w => w.includes("not found")).length).toBe(0);
  });

  it("validates files that exist in KG without warnings", () => {
    const db = createKGDatabase(":memory:");
    const modules: ModuleInfo[] = [
      {
        path: "src/foo.ts",
        exports: [{ name: "foo", kind: "function" }],
        imports: [],
        isTest: false,
      },
    ];
    saveModules(db, modules);

    const plan = makePlan();
    plan.tasks[0].spec.context.files = ["src/foo.ts"];
    const result = validatePlan(plan, db);
    expect(result.warnings.filter(w => w.includes("not found")).length).toBe(0);
  });
});

describe("buildPlanningPrompt", () => {
  it("includes the goal text", () => {
    const prompt = buildPlanningPrompt("Add a new feature");
    expect(prompt).toContain("Add a new feature");
  });

  it("includes KG context when provided", () => {
    const prompt = buildPlanningPrompt("Fix bug", "## src/foo.ts\nexport function bar");
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("Codebase Context");
  });

  it("includes ExecutionPlan schema", () => {
    const prompt = buildPlanningPrompt("Do something");
    expect(prompt).toContain("ExecutionPlan");
    expect(prompt).toContain("PlannedTask");
    expect(prompt).toContain("riskLevel");
  });

  it("instructs JSON-only output", () => {
    const prompt = buildPlanningPrompt("Goal");
    expect(prompt).toContain("Respond with the ExecutionPlan JSON only");
  });
});

describe("loadGoal", () => {
  it("treats non-file string as free text", () => {
    const result = loadGoal("Add authentication to the API");
    expect(result.text).toBe("Add authentication to the API");
    expect(result.taskSpec).toBeUndefined();
  });

  it("treats non-existent path as free text", () => {
    const result = loadGoal("/nonexistent/file.yaml");
    expect(result.text).toBe("/nonexistent/file.yaml");
  });
});
