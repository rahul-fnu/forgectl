import { describe, it, expect } from "vitest";
import { validateDAG, topologicalSort, getParallelGroups } from "../../src/pipeline/dag.js";
import { parsePipelineYaml } from "../../src/pipeline/parser.js";
import type { PipelineDefinition } from "../../src/pipeline/types.js";

function makePipeline(nodes: PipelineDefinition["nodes"]): PipelineDefinition {
  return { name: "test", nodes };
}

describe("validateDAG", () => {
  it("accepts a valid linear DAG (A → B → C)", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid fan-out (A → B, A → C)", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });

  it("accepts a valid fan-in (A + B → C)", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b" },
      { id: "c", task: "do c", depends_on: ["a", "b"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });

  it("accepts a valid diamond (A → B, A → C, B + C → D)", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
      { id: "d", task: "do d", depends_on: ["b", "c"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(true);
  });

  it("rejects a cycle (A → B → A)", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a", depends_on: ["b"] },
      { id: "b", task: "do b", depends_on: ["a"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/[Cc]ycle/);
  });

  it("rejects a missing dependency reference", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a", depends_on: ["nonexistent"] },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown node "nonexistent"/);
  });

  it("rejects duplicate node IDs", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "a", task: "do a again" },
    ]);
    const result = validateDAG(pipeline);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/[Dd]uplicate.*"a"/);
  });
});

describe("topologicalSort", () => {
  it("produces valid order for linear DAG", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["b"] },
    ]);
    const order = topologicalSort(pipeline);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("produces valid order for diamond DAG", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
      { id: "d", task: "do d", depends_on: ["b", "c"] },
    ]);
    const order = topologicalSort(pipeline);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("roots come first", () => {
    const pipeline = makePipeline([
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "a", task: "do a" },
    ]);
    const order = topologicalSort(pipeline);
    expect(order[0]).toBe("a");
  });
});

describe("getParallelGroups", () => {
  it("single root is level 0", () => {
    const pipeline = makePipeline([{ id: "a", task: "do a" }]);
    const groups = getParallelGroups(pipeline);
    expect(groups).toEqual([["a"]]);
  });

  it("independent nodes are in the same group", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b" },
    ]);
    const groups = getParallelGroups(pipeline);
    expect(groups).toEqual([["a", "b"]]);
  });

  it("fan-out nodes are in the same group", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
    ]);
    const groups = getParallelGroups(pipeline);
    expect(groups).toEqual([["a"], ["b", "c"]]);
  });

  it("diamond DAG has correct groups", () => {
    const pipeline = makePipeline([
      { id: "a", task: "do a" },
      { id: "b", task: "do b", depends_on: ["a"] },
      { id: "c", task: "do c", depends_on: ["a"] },
      { id: "d", task: "do d", depends_on: ["b", "c"] },
    ]);
    const groups = getParallelGroups(pipeline);
    expect(groups).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("parsePipelineYaml", () => {
  it("parses valid YAML", () => {
    const yaml = `
name: test
nodes:
  - id: step-1
    task: "First step"
  - id: step-2
    task: "Second step"
    depends_on: [step-1]
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.name).toBe("test");
    expect(pipeline.nodes).toHaveLength(2);
    expect(pipeline.nodes[1].depends_on).toEqual(["step-1"]);
  });

  it("parses pipeline with defaults", () => {
    const yaml = `
name: test
defaults:
  workflow: code
  agent: codex
nodes:
  - id: step-1
    task: "First step"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.defaults?.workflow).toBe("code");
    expect(pipeline.defaults?.agent).toBe("codex");
  });

  it("rejects invalid node IDs", () => {
    const yaml = `
name: test
nodes:
  - id: "INVALID_ID"
    task: "First step"
`;
    expect(() => parsePipelineYaml(yaml)).toThrow();
  });

  it("rejects empty nodes", () => {
    const yaml = `
name: test
nodes: []
`;
    expect(() => parsePipelineYaml(yaml)).toThrow();
  });

  it("rejects missing name", () => {
    const yaml = `
nodes:
  - id: step-1
    task: "First step"
`;
    expect(() => parsePipelineYaml(yaml)).toThrow();
  });
});
