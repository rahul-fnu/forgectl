import { describe, it, expect } from "vitest";
import { detectIssueCycles, IssueDAGNode } from "../../src/tracker/sub-issue-dag.js";

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
