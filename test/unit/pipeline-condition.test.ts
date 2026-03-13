import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  expandShorthands,
  ConditionSyntaxError,
  ConditionVariableError,
} from "../../src/pipeline/condition.js";
import { validateDAG } from "../../src/pipeline/dag.js";
import { parsePipelineYaml } from "../../src/pipeline/parser.js";
import type { PipelineDefinition } from "../../src/pipeline/types.js";

function makePipeline(nodes: PipelineDefinition["nodes"]): PipelineDefinition {
  return { name: "test", nodes };
}

// ─── evaluateCondition ────────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  it('returns true when build == "completed" and build is "completed"', () => {
    expect(evaluateCondition('build == "completed"', { build: "completed" })).toBe(true);
  });

  it('returns false when build == "completed" and build is "failed"', () => {
    expect(evaluateCondition('build == "completed"', { build: "failed" })).toBe(false);
  });

  it("returns true for compound and expression when both match", () => {
    expect(
      evaluateCondition('build == "completed" and test == "completed"', {
        build: "completed",
        test: "completed",
      }),
    ).toBe(true);
  });

  it("returns false for compound and expression when one does not match", () => {
    expect(
      evaluateCondition('build == "completed" and test == "completed"', {
        build: "completed",
        test: "failed",
      }),
    ).toBe(false);
  });

  it('returns true for not (build == "failed") when build is "completed"', () => {
    expect(evaluateCondition('not (build == "failed")', { build: "completed" })).toBe(true);
  });

  it('returns false for not (build == "failed") when build is "failed"', () => {
    expect(evaluateCondition('not (build == "failed")', { build: "failed" })).toBe(false);
  });

  it("throws ConditionSyntaxError for a malformed expression", () => {
    expect(() => evaluateCondition("build ===", { build: "completed" })).toThrow(
      ConditionSyntaxError,
    );
  });

  it("throws ConditionVariableError when referencing unknown variable", () => {
    expect(() => evaluateCondition('unknown == "completed"', { build: "completed" })).toThrow(
      ConditionVariableError,
    );
  });

  it("returns a boolean (not 0/1 numbers)", () => {
    const result = evaluateCondition('build == "completed"', { build: "completed" });
    expect(typeof result).toBe("boolean");
  });
});

// ─── expandShorthands ─────────────────────────────────────────────────────────

describe("expandShorthands", () => {
  it('converts if_failed: "test" to condition: test == "failed"', () => {
    const pipeline = makePipeline([
      { id: "test", task: "run tests" },
      { id: "notify", task: "notify failure", if_failed: "test", depends_on: ["test"] },
    ]);
    const expanded = expandShorthands(pipeline);
    const notifyNode = expanded.nodes.find(n => n.id === "notify")!;
    expect(notifyNode.condition).toBe('test == "failed"');
    expect(notifyNode.if_failed).toBeUndefined();
  });

  it('converts if_passed: "build" to condition: build == "completed"', () => {
    const pipeline = makePipeline([
      { id: "build", task: "build app" },
      { id: "deploy", task: "deploy app", if_passed: "build", depends_on: ["build"] },
    ]);
    const expanded = expandShorthands(pipeline);
    const deployNode = expanded.nodes.find(n => n.id === "deploy")!;
    expect(deployNode.condition).toBe('build == "completed"');
    expect(deployNode.if_passed).toBeUndefined();
  });

  it("auto-adds target to depends_on when if_failed is set and target not already listed", () => {
    const pipeline = makePipeline([
      { id: "test", task: "run tests" },
      { id: "notify", task: "notify failure", if_failed: "test" },
    ]);
    const expanded = expandShorthands(pipeline);
    const notifyNode = expanded.nodes.find(n => n.id === "notify")!;
    expect(notifyNode.depends_on).toContain("test");
  });

  it("does not duplicate target in depends_on if already present", () => {
    const pipeline = makePipeline([
      { id: "test", task: "run tests" },
      { id: "notify", task: "notify failure", if_failed: "test", depends_on: ["test"] },
    ]);
    const expanded = expandShorthands(pipeline);
    const notifyNode = expanded.nodes.find(n => n.id === "notify")!;
    const testOccurrences = (notifyNode.depends_on ?? []).filter(d => d === "test").length;
    expect(testOccurrences).toBe(1);
  });

  it("throws when both condition and if_failed are set on same node", () => {
    const pipeline = makePipeline([
      { id: "test", task: "run tests" },
      {
        id: "notify",
        task: "notify",
        condition: 'test == "failed"',
        if_failed: "test",
      },
    ]);
    expect(() => expandShorthands(pipeline)).toThrow();
  });

  it("throws when both condition and if_passed are set on same node", () => {
    const pipeline = makePipeline([
      { id: "build", task: "build" },
      {
        id: "deploy",
        task: "deploy",
        condition: 'build == "completed"',
        if_passed: "build",
      },
    ]);
    expect(() => expandShorthands(pipeline)).toThrow();
  });

  it("leaves nodes without shorthands unchanged", () => {
    const pipeline = makePipeline([
      { id: "build", task: "build app" },
      { id: "test", task: "run tests", depends_on: ["build"] },
    ]);
    const expanded = expandShorthands(pipeline);
    const testNode = expanded.nodes.find(n => n.id === "test")!;
    expect(testNode.condition).toBeUndefined();
    expect(testNode.if_failed).toBeUndefined();
    expect(testNode.if_passed).toBeUndefined();
    expect(testNode.depends_on).toEqual(["build"]);
  });

  it("returns a new PipelineDefinition without mutating the original", () => {
    const pipeline = makePipeline([
      { id: "test", task: "run tests" },
      { id: "notify", task: "notify failure", if_failed: "test" },
    ]);
    const originalNotify = pipeline.nodes.find(n => n.id === "notify")!;
    expandShorthands(pipeline);
    // Original should be unchanged
    expect(originalNotify.if_failed).toBe("test");
    expect(originalNotify.condition).toBeUndefined();
  });
});

// ─── validateDAG — else_node extensions ──────────────────────────────────────

describe("validateDAG — else_node validation", () => {
  it("accepts a valid else_node reference", () => {
    const pipeline = makePipeline([
      { id: "build", task: "build app" },
      { id: "deploy", task: "deploy", depends_on: ["build"], condition: 'build == "completed"', else_node: "notify" },
      { id: "notify", task: "notify failure" },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });

  it("rejects else_node referencing an unknown node", () => {
    const pipeline = makePipeline([
      { id: "build", task: "build app" },
      { id: "deploy", task: "deploy", depends_on: ["build"], else_node: "nonexistent" },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("nonexistent"))).toBe(true);
  });

  it("rejects else_node referencing itself", () => {
    const pipeline = makePipeline([
      { id: "build", task: "build app" },
      { id: "deploy", task: "deploy", depends_on: ["build"], else_node: "deploy" },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("cannot reference itself"))).toBe(true);
  });

  it("detects cycle through else_node edges", () => {
    // a -> b (else_node: a) creates a cycle a -> b -> a
    const pipeline = makePipeline([
      { id: "a", task: "task a" },
      { id: "b", task: "task b", depends_on: ["a"], else_node: "a" },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes("cycle"))).toBe(true);
  });
});

// ─── parsePipelineYaml — expandShorthands integration ────────────────────────

describe("parsePipelineYaml — shorthand expansion", () => {
  it("expands if_failed shorthand to condition at parse time", () => {
    const yaml = `
name: test pipeline
nodes:
  - id: test
    task: run tests
  - id: notify
    task: notify failure
    if_failed: test
`;
    const pipeline = parsePipelineYaml(yaml);
    const notifyNode = pipeline.nodes.find(n => n.id === "notify")!;
    expect(notifyNode.condition).toBe('test == "failed"');
    expect(notifyNode.if_failed).toBeUndefined();
    expect(notifyNode.depends_on).toContain("test");
  });

  it("expands if_passed shorthand to condition at parse time", () => {
    const yaml = `
name: test pipeline
nodes:
  - id: build
    task: build app
  - id: deploy
    task: deploy app
    if_passed: build
`;
    const pipeline = parsePipelineYaml(yaml);
    const deployNode = pipeline.nodes.find(n => n.id === "deploy")!;
    expect(deployNode.condition).toBe('build == "completed"');
    expect(deployNode.if_passed).toBeUndefined();
    expect(deployNode.depends_on).toContain("build");
  });

  it("returns pipeline unchanged when no shorthands are present", () => {
    const yaml = `
name: simple pipeline
nodes:
  - id: build
    task: build
  - id: test
    task: test
    depends_on: [build]
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.nodes).toHaveLength(2);
    const testNode = pipeline.nodes.find(n => n.id === "test")!;
    expect(testNode.condition).toBeUndefined();
  });
});
