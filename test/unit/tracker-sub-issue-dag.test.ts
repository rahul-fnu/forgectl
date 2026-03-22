import { describe, it, expect } from "vitest";
import { detectIssueCycles, computeDescendantCounts, buildIssueDependentsMap, IssueDAGNode } from "../../src/tracker/sub-issue-dag.js";

describe("detectIssueCycles", () => {
  it("returns null for empty graph", () => {
    expect(detectIssueCycles([])).toBeNull();
  });

  it("returns null for single node with no dependencies", () => {
    const nodes: IssueDAGNode[] = [{ id: "1", blocked_by: [] }];
    expect(detectIssueCycles(nodes)).toBeNull();
  });

  it("returns null for linear acyclic chain A->B->C", () => {
    const nodes: IssueDAGNode[] = [
      { id: "1", blocked_by: [] },
      { id: "2", blocked_by: ["1"] },
      { id: "3", blocked_by: ["2"] },
    ];
    expect(detectIssueCycles(nodes)).toBeNull();
  });

  it("returns null for nodes with no blocked_by (root nodes)", () => {
    const nodes: IssueDAGNode[] = [
      { id: "1", blocked_by: [] },
      { id: "2", blocked_by: [] },
      { id: "3", blocked_by: [] },
    ];
    expect(detectIssueCycles(nodes)).toBeNull();
  });

  it("detects simple A->B->A cycle and returns descriptive string", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: ["B"] },
      { id: "B", blocked_by: ["A"] },
    ];
    const result = detectIssueCycles(nodes);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result).toMatch(/cycle/i);
    // Should mention both nodes
    expect(result).toContain("A");
    expect(result).toContain("B");
  });

  it("detects longer A->B->C->A cycle", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: ["C"] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["B"] },
    ];
    const result = detectIssueCycles(nodes);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result).toMatch(/cycle/i);
  });

  it("ignores references to unknown nodes (cross-repo refs) - does NOT report as error", () => {
    // Node 1 is blocked by "external-999" which is not in the input set
    const nodes: IssueDAGNode[] = [
      { id: "1", blocked_by: ["external-999", "external-888"] },
      { id: "2", blocked_by: ["1"] },
    ];
    // Should return null (no cycle), not an error about unknown refs
    expect(detectIssueCycles(nodes)).toBeNull();
  });

  it("handles diamond dependency without false positive (A->B, A->C, B->D, C->D)", () => {
    // D is blocked by B and C; B and C are both blocked by A
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["A"] },
      { id: "D", blocked_by: ["B", "C"] },
    ];
    expect(detectIssueCycles(nodes)).toBeNull();
  });

  it("detects cycle in graph where some nodes are valid", () => {
    const nodes: IssueDAGNode[] = [
      { id: "1", blocked_by: [] },
      { id: "2", blocked_by: ["1"] },
      { id: "3", blocked_by: ["4"] }, // part of cycle
      { id: "4", blocked_by: ["3"] }, // part of cycle
    ];
    const result = detectIssueCycles(nodes);
    expect(result).not.toBeNull();
    expect(result).toMatch(/cycle/i);
  });

  it("handles self-referencing node (A blocked_by A)", () => {
    const nodes: IssueDAGNode[] = [{ id: "A", blocked_by: ["A"] }];
    const result = detectIssueCycles(nodes);
    expect(result).not.toBeNull();
    expect(result).toMatch(/cycle/i);
  });

  it("handles mixed external refs and valid internal graph", () => {
    const nodes: IssueDAGNode[] = [
      { id: "10", blocked_by: ["external-1", "external-2"] },
      { id: "20", blocked_by: ["10", "external-3"] },
      { id: "30", blocked_by: ["20"] },
    ];
    expect(detectIssueCycles(nodes)).toBeNull();
  });
});

describe("buildIssueDependentsMap", () => {
  it("returns empty map for empty input", () => {
    const result = buildIssueDependentsMap([]);
    expect(result.size).toBe(0);
  });

  it("builds correct forward adjacency for linear chain", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["B"] },
    ];
    const result = buildIssueDependentsMap(nodes);
    expect(result.get("A")).toEqual(["B"]);
    expect(result.get("B")).toEqual(["C"]);
    expect(result.get("C")).toEqual([]);
  });

  it("ignores external references not in the input set", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: ["external-1"] },
      { id: "B", blocked_by: ["A"] },
    ];
    const result = buildIssueDependentsMap(nodes);
    expect(result.get("A")).toEqual(["B"]);
    expect(result.has("external-1")).toBe(false);
  });
});

describe("computeDescendantCounts", () => {
  it("returns empty map for empty input", () => {
    const result = computeDescendantCounts([]);
    expect(result.size).toBe(0);
  });

  it("returns 0 for isolated nodes", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: [] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(0);
    expect(result.get("B")).toBe(0);
  });

  it("counts correctly for linear chain A->B->C", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["B"] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(2); // B, C
    expect(result.get("B")).toBe(1); // C
    expect(result.get("C")).toBe(0);
  });

  it("counts correctly for diamond DAG (A->B, A->C, B+C->D)", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["A"] },
      { id: "D", blocked_by: ["B", "C"] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(3); // B, C, D
    expect(result.get("B")).toBe(1); // D
    expect(result.get("C")).toBe(1); // D
    expect(result.get("D")).toBe(0);
  });

  it("counts correctly for fan-out (A->B, A->C, A->D)", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["A"] },
      { id: "D", blocked_by: ["A"] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(3);
    expect(result.get("B")).toBe(0);
    expect(result.get("C")).toBe(0);
    expect(result.get("D")).toBe(0);
  });

  it("handles complex DAG with multiple paths", () => {
    // A -> B -> D -> E
    // A -> C -> D -> E
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["A"] },
      { id: "D", blocked_by: ["B", "C"] },
      { id: "E", blocked_by: ["D"] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(4); // B, C, D, E
    expect(result.get("B")).toBe(2); // D, E
    expect(result.get("C")).toBe(2); // D, E
    expect(result.get("D")).toBe(1); // E
    expect(result.get("E")).toBe(0);
  });

  it("ignores external references", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: ["external-1"] },
      { id: "B", blocked_by: ["A"] },
    ];
    const result = computeDescendantCounts(nodes);
    expect(result.get("A")).toBe(1); // B
    expect(result.get("B")).toBe(0);
  });
});
