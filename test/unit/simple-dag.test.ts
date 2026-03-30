import { describe, it, expect } from "vitest";
import { SimpleDAG } from "../../src/pipeline/simple-dag.js";

function buildDiamond(): SimpleDAG {
  const dag = new SimpleDAG();
  dag.addNode({ id: "a", issueId: "issue-1", dependsOn: [] });
  dag.addNode({ id: "b", issueId: "issue-2", dependsOn: ["a"] });
  dag.addNode({ id: "c", issueId: "issue-3", dependsOn: ["a"] });
  dag.addNode({ id: "d", issueId: "issue-4", dependsOn: ["b", "c"] });
  return dag;
}

describe("SimpleDAG", () => {
  it("validates a valid diamond DAG", () => {
    const dag = buildDiamond();
    expect(dag.validate()).toEqual([]);
  });

  it("rejects duplicate node IDs", () => {
    const dag = new SimpleDAG();
    dag.addNode({ id: "a", issueId: "i1", dependsOn: [] });
    expect(() => dag.addNode({ id: "a", issueId: "i2", dependsOn: [] })).toThrow(
      /Duplicate/,
    );
  });

  it("rejects unknown dependencies", () => {
    const dag = new SimpleDAG();
    dag.addNode({ id: "a", issueId: "i1", dependsOn: ["missing"] });
    expect(dag.validate()[0]).toMatch(/unknown node/);
  });

  it("detects cycles", () => {
    const dag = new SimpleDAG();
    dag.addNode({ id: "a", issueId: "i1", dependsOn: ["b"] });
    dag.addNode({ id: "b", issueId: "i2", dependsOn: ["a"] });
    expect(dag.validate()[0]).toMatch(/Cycle/);
  });

  it("4-node diamond executes in correct order", () => {
    const dag = buildDiamond();
    const executionOrder: string[] = [];

    // Round 1: only A is ready
    let ready = dag.getReady();
    expect(ready.map((n) => n.id)).toEqual(["a"]);
    dag.markRunning("a");
    dag.markDone("a");
    executionOrder.push("a");

    // Round 2: B and C are ready in parallel
    ready = dag.getReady();
    expect(ready.map((n) => n.id).sort()).toEqual(["b", "c"]);
    dag.markRunning("b");
    dag.markRunning("c");
    dag.markDone("b");
    dag.markDone("c");
    executionOrder.push("b", "c");

    // Round 3: D is ready
    ready = dag.getReady();
    expect(ready.map((n) => n.id)).toEqual(["d"]);
    dag.markRunning("d");
    dag.markDone("d");
    executionOrder.push("d");

    // Complete
    expect(dag.getReady()).toEqual([]);
    expect(dag.isComplete()).toBe(true);
    expect(executionOrder).toEqual(["a", "b", "c", "d"]);
  });

  it("isComplete returns false while tasks are pending or running", () => {
    const dag = buildDiamond();
    expect(dag.isComplete()).toBe(false);

    dag.markRunning("a");
    expect(dag.isComplete()).toBe(false);
  });

  it("isComplete returns true when all tasks are done or failed", () => {
    const dag = new SimpleDAG();
    dag.addNode({ id: "a", issueId: "i1", dependsOn: [] });
    dag.addNode({ id: "b", issueId: "i2", dependsOn: [] });
    dag.markRunning("a");
    dag.markDone("a");
    dag.markRunning("b");
    dag.markFailed("b");
    expect(dag.isComplete()).toBe(true);
  });

  it("failed dependency blocks downstream nodes", () => {
    const dag = buildDiamond();
    dag.markRunning("a");
    dag.markFailed("a");
    // B and C depend on A which failed, so nothing is ready
    expect(dag.getReady()).toEqual([]);
  });

  it("markDone throws on non-running node", () => {
    const dag = buildDiamond();
    expect(() => dag.markDone("a")).toThrow(/status is "pending"/);
  });

  it("markRunning throws on non-pending node", () => {
    const dag = buildDiamond();
    dag.markRunning("a");
    dag.markDone("a");
    expect(() => dag.markRunning("a")).toThrow(/status is "done"/);
  });
});
