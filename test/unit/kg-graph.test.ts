import { describe, it, expect } from "vitest";
import {
  buildDependencyGraph,
  getDependents,
  getTransitiveDependents,
  getDependencies,
} from "../../src/kg/graph.js";
import type { ModuleInfo, DependencyEdge } from "../../src/kg/types.js";

function makeModule(path: string, imports: Array<{ source: string; names: string[]; isTypeOnly?: boolean }>): ModuleInfo {
  return {
    path,
    exports: [],
    imports: imports.map(i => ({
      source: i.source,
      names: i.names,
      isTypeOnly: i.isTypeOnly ?? false,
    })),
    isTest: false,
  };
}

describe("buildDependencyGraph", () => {
  it("creates edges for internal dependencies", () => {
    const modules = [
      makeModule("src/a.ts", [{ source: "src/b.ts", names: ["foo"] }]),
      makeModule("src/b.ts", []),
    ];

    const edges = buildDependencyGraph(modules);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from: "src/a.ts",
      to: "src/b.ts",
      imports: ["foo"],
      isTypeOnly: false,
    });
  });

  it("ignores external dependencies", () => {
    const modules = [
      makeModule("src/a.ts", [{ source: "chalk", names: ["default"] }]),
    ];

    const edges = buildDependencyGraph(modules);
    expect(edges).toHaveLength(0);
  });

  it("builds multiple edges", () => {
    const modules = [
      makeModule("src/a.ts", [
        { source: "src/b.ts", names: ["foo"] },
        { source: "src/c.ts", names: ["bar"] },
      ]),
      makeModule("src/b.ts", [{ source: "src/c.ts", names: ["baz"] }]),
      makeModule("src/c.ts", []),
    ];

    const edges = buildDependencyGraph(modules);
    expect(edges).toHaveLength(3);
  });

  it("preserves type-only flag", () => {
    const modules = [
      makeModule("src/a.ts", [
        { source: "src/b.ts", names: ["Foo"], isTypeOnly: true },
      ]),
      makeModule("src/b.ts", []),
    ];

    const edges = buildDependencyGraph(modules);
    expect(edges[0].isTypeOnly).toBe(true);
  });
});

describe("getDependents", () => {
  it("returns direct importers", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/c.ts", imports: ["x"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/c.ts", imports: ["y"], isTypeOnly: false },
      { from: "src/a.ts", to: "src/d.ts", imports: ["z"], isTypeOnly: false },
    ];

    const result = getDependents(edges, "src/c.ts");
    expect(result).toHaveLength(2);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
  });

  it("returns empty for no dependents", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
    ];

    const result = getDependents(edges, "src/a.ts");
    expect(result).toHaveLength(0);
  });
});

describe("getTransitiveDependents", () => {
  it("finds transitive dependents (A->B->C)", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/c.ts", imports: ["y"], isTypeOnly: false },
    ];

    const result = getTransitiveDependents(edges, "src/c.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toContain("src/a.ts");
  });

  it("handles diamond dependencies", () => {
    // A -> B, A -> C, B -> D, C -> D
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      { from: "src/a.ts", to: "src/c.ts", imports: ["y"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/d.ts", imports: ["z"], isTypeOnly: false },
      { from: "src/c.ts", to: "src/d.ts", imports: ["w"], isTypeOnly: false },
    ];

    const result = getTransitiveDependents(edges, "src/d.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toContain("src/c.ts");
    expect(result).toContain("src/a.ts");
  });

  it("handles circular dependencies without infinite loop", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/a.ts", imports: ["y"], isTypeOnly: false },
    ];

    const result = getTransitiveDependents(edges, "src/a.ts");
    expect(result).toContain("src/b.ts");
    // a.ts should also appear because b imports a, and a imports b
    expect(result).toContain("src/a.ts");
  });

  it("returns empty for leaf module with no dependents", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
    ];

    const result = getTransitiveDependents(edges, "src/a.ts");
    expect(result).toHaveLength(0);
  });
});

describe("getDependencies", () => {
  it("returns direct dependencies", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      { from: "src/a.ts", to: "src/c.ts", imports: ["y"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/c.ts", imports: ["z"], isTypeOnly: false },
    ];

    const result = getDependencies(edges, "src/a.ts");
    expect(result).toHaveLength(2);
    expect(result).toContain("src/b.ts");
    expect(result).toContain("src/c.ts");
  });

  it("returns empty for module with no dependencies", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
    ];

    const result = getDependencies(edges, "src/b.ts");
    expect(result).toHaveLength(0);
  });
});
