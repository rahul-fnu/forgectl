import { describe, it, expect } from "vitest";
import { detectIssueCycles, computeCriticalPath, IssueDAGNode } from "../../src/tracker/sub-issue-dag.js";

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

describe("computeCriticalPath", () => {
  it("returns empty map for empty input", () => {
    expect(computeCriticalPath([])).toEqual(new Map());
  });

  it("returns 0 for single node with no dependents", () => {
    const nodes: IssueDAGNode[] = [{ id: "A", blocked_by: [] }];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(0);
  });

  it("scores linear chain correctly (root unblocks most)", () => {
    // A <- B <- C  (B blocked_by A, C blocked_by B)
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["B"] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(2); // unblocks B and C
    expect(scores.get("B")).toBe(1); // unblocks C
    expect(scores.get("C")).toBe(0); // leaf
  });

  it("computes correct scores for diamond-shaped DAG", () => {
    // A is root; B and C depend on A; D depends on B and C
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "C", blocked_by: ["A"] },
      { id: "D", blocked_by: ["B", "C"] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(3); // unblocks B, C, D
    expect(scores.get("B")).toBe(1); // unblocks D
    expect(scores.get("C")).toBe(1); // unblocks D
    expect(scores.get("D")).toBe(0); // leaf
  });

  it("handles disconnected components", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: ["A"] },
      { id: "X", blocked_by: [] },
      { id: "Y", blocked_by: ["X"] },
      { id: "Z", blocked_by: ["X"] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(1);
    expect(scores.get("X")).toBe(2);
    expect(scores.get("B")).toBe(0);
    expect(scores.get("Y")).toBe(0);
    expect(scores.get("Z")).toBe(0);
  });

  it("ignores external refs not in the input set", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: ["external-99"] },
      { id: "B", blocked_by: ["A"] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(1);
    expect(scores.get("B")).toBe(0);
  });

  it("handles all independent nodes (no edges)", () => {
    const nodes: IssueDAGNode[] = [
      { id: "A", blocked_by: [] },
      { id: "B", blocked_by: [] },
      { id: "C", blocked_by: [] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("A")).toBe(0);
    expect(scores.get("B")).toBe(0);
    expect(scores.get("C")).toBe(0);
  });

  it("handles wide fan-out (one root, many dependents)", () => {
    const nodes: IssueDAGNode[] = [
      { id: "root", blocked_by: [] },
      { id: "c1", blocked_by: ["root"] },
      { id: "c2", blocked_by: ["root"] },
      { id: "c3", blocked_by: ["root"] },
      { id: "c4", blocked_by: ["root"] },
    ];
    const scores = computeCriticalPath(nodes);
    expect(scores.get("root")).toBe(4);
    expect(scores.get("c1")).toBe(0);
    expect(scores.get("c2")).toBe(0);
  });
});
