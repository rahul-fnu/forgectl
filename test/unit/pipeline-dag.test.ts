import { describe, it, expect } from "vitest";
import {
  validateDAG,
  topologicalSort,
  getParallelGroups,
  collectAncestors,
  collectDescendants,
  isAncestor,
} from "../../src/pipeline/dag.js";
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

describe("graph helpers", () => {
  const pipeline = makePipeline([
    { id: "a", task: "a" },
    { id: "b", task: "b", depends_on: ["a"] },
    { id: "c", task: "c" },
    { id: "d", task: "d", depends_on: ["b", "c"] },
    { id: "e", task: "e", depends_on: ["d"] },
  ]);

  it("collectAncestors returns full transitive ancestry", () => {
    expect([...collectAncestors(pipeline, "e")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...collectAncestors(pipeline, "a")]).toEqual([]);
  });

  it("collectDescendants returns full transitive descendants", () => {
    expect([...collectDescendants(pipeline, "a")].sort()).toEqual(["b", "d", "e"]);
    expect([...collectDescendants(pipeline, "c")].sort()).toEqual(["d", "e"]);
  });

  it("isAncestor detects transitive ancestor relationships", () => {
    expect(isAncestor(pipeline, "a", "e")).toBe(true);
    expect(isAncestor(pipeline, "c", "e")).toBe(true);
    expect(isAncestor(pipeline, "e", "a")).toBe(false);
    expect(isAncestor(pipeline, "b", "c")).toBe(false);
  });
});

// ── Complex DAG: parallel tracks converging into shared integration ──────────
//
//   Track A:          Track B:
//     A1                 B1
//      |                  |
//     A2                 B2
//      \                /
//       +--- C1 ---+
//            |
//           C2
//
describe("complex DAG — parallel tracks with diamond convergence", () => {
  const complexPipeline = makePipeline([
    { id: "a1", task: "Auth middleware" },
    { id: "a2", task: "Rate limiter", depends_on: ["a1"] },
    { id: "b1", task: "History/undo system" },
    { id: "b2", task: "Pipe stdin support", depends_on: ["b1"] },
    { id: "c1", task: "Shared SDK", depends_on: ["a2", "b2"] },
    { id: "c2", task: "Integration test", depends_on: ["c1"] },
  ]);

  it("validates as a legal DAG", () => {
    const result = validateDAG(complexPipeline);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("topological sort respects all dependency edges", () => {
    const order = topologicalSort(complexPipeline);
    expect(order).toHaveLength(6);
    // Within track A
    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    // Within track B
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("b2"));
    // Diamond convergence: c1 after both track tails
    expect(order.indexOf("a2")).toBeLessThan(order.indexOf("c1"));
    expect(order.indexOf("b2")).toBeLessThan(order.indexOf("c1"));
    // Final integration
    expect(order.indexOf("c1")).toBeLessThan(order.indexOf("c2"));
  });

  it("parallel groups: independent tracks in same level, convergence in own level", () => {
    const groups = getParallelGroups(complexPipeline);
    // Level 0: a1, b1 (roots)
    // Level 1: a2, b2 (stacked on respective roots)
    // Level 2: c1 (fan-in)
    // Level 3: c2 (final)
    expect(groups).toEqual([
      expect.arrayContaining(["a1", "b1"]),
      expect.arrayContaining(["a2", "b2"]),
      ["c1"],
      ["c2"],
    ]);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(2);
  });

  it("collectAncestors of c1 includes both full tracks", () => {
    const ancestors = collectAncestors(complexPipeline, "c1");
    expect([...ancestors].sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("collectAncestors of c2 includes every other node", () => {
    const ancestors = collectAncestors(complexPipeline, "c2");
    expect([...ancestors].sort()).toEqual(["a1", "a2", "b1", "b2", "c1"]);
  });

  it("collectDescendants of a1 follows through convergence to c2", () => {
    const desc = collectDescendants(complexPipeline, "a1");
    expect([...desc].sort()).toEqual(["a2", "c1", "c2"]);
  });

  it("collectDescendants of b1 follows through convergence to c2", () => {
    const desc = collectDescendants(complexPipeline, "b1");
    expect([...desc].sort()).toEqual(["b2", "c1", "c2"]);
  });

  it("tracks are not ancestors of each other", () => {
    expect(isAncestor(complexPipeline, "a1", "b1")).toBe(false);
    expect(isAncestor(complexPipeline, "a1", "b2")).toBe(false);
    expect(isAncestor(complexPipeline, "b1", "a1")).toBe(false);
    expect(isAncestor(complexPipeline, "b1", "a2")).toBe(false);
  });

  it("both track roots are ancestors of the convergence node", () => {
    expect(isAncestor(complexPipeline, "a1", "c1")).toBe(true);
    expect(isAncestor(complexPipeline, "b1", "c1")).toBe(true);
    expect(isAncestor(complexPipeline, "a1", "c2")).toBe(true);
    expect(isAncestor(complexPipeline, "b1", "c2")).toBe(true);
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
