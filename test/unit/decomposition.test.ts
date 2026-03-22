import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ModuleBoundaryStrategy,
  decompose,
} from "../../src/task/decomposition.js";
import type { DecompositionStrategy } from "../../src/task/decomposition.js";
import {
  createKGDatabase,
  saveModules,
  saveEdges,
  saveChangeCoupling,
  saveTestMappings,
} from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo, DependencyEdge, ChangeCoupling, TestCoverageMapping } from "../../src/kg/types.js";
import type { PlannedTask } from "../../src/planner/types.js";

function makeModule(path: string, imports: Array<{ source: string; names: string[] }> = [], isTest = false): ModuleInfo {
  return {
    path,
    exports: [{ name: "default", kind: "function" as const }],
    imports: imports.map(i => ({ ...i, isTypeOnly: false })),
    isTest,
  };
}

function makeTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id: "big-task",
    title: "Implement feature X",
    spec: {
      id: "big-task",
      title: "Implement feature X",
      description: "A large task spanning multiple modules",
      context: { files: ["src/**/*.ts"] },
      constraints: ["No breaking changes"],
      acceptance: [{ run: "npm test", description: "Tests pass" }],
      decomposition: { strategy: "auto" },
      effort: { max_turns: 30 },
    },
    dependsOn: [],
    estimatedTurns: 30,
    riskNotes: "",
    ...overrides,
  };
}

describe("Decomposition Engine", () => {
  let db: KGDatabase;

  beforeEach(() => {
    db = createKGDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("ModuleBoundaryStrategy", () => {
    it("returns original task when only one module boundary", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/kg/graph.ts", [{ source: "src/kg/parser.ts", names: ["parse"] }]),
        makeModule("src/kg/storage.ts"),
      ];
      const edges: DependencyEdge[] = [
        { from: "src/kg/graph.ts", to: "src/kg/parser.ts", imports: ["parse"], isTypeOnly: false },
      ];

      saveModules(db, modules);
      saveEdges(db, edges);

      const task = makeTask({
        spec: {
          ...makeTask().spec,
          context: { files: ["src/kg/**/*.ts"] },
        },
      });

      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("big-task");
    });

    it("splits task across module boundaries", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/kg/graph.ts", [{ source: "src/kg/parser.ts", names: ["parse"] }]),
        makeModule("src/task/types.ts"),
        makeModule("src/task/loader.ts", [{ source: "src/task/types.ts", names: ["TaskSpec"] }]),
        makeModule("src/planner/planner.ts", [
          { source: "src/task/types.ts", names: ["TaskSpec"] },
          { source: "src/kg/graph.ts", names: ["buildGraph"] },
        ]),
      ];
      const edges: DependencyEdge[] = [
        { from: "src/kg/graph.ts", to: "src/kg/parser.ts", imports: ["parse"], isTypeOnly: false },
        { from: "src/task/loader.ts", to: "src/task/types.ts", imports: ["TaskSpec"], isTypeOnly: false },
        { from: "src/planner/planner.ts", to: "src/task/types.ts", imports: ["TaskSpec"], isTypeOnly: false },
        { from: "src/planner/planner.ts", to: "src/kg/graph.ts", imports: ["buildGraph"], isTypeOnly: false },
      ];

      saveModules(db, modules);
      saveEdges(db, edges);

      const task = makeTask();
      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      expect(result.length).toBeGreaterThan(1);

      // Each subtask should have files from one module boundary
      const subtaskIds = result.map(t => t.id);
      expect(subtaskIds).toContain("big-task-kg");
      expect(subtaskIds).toContain("big-task-task");
      expect(subtaskIds).toContain("big-task-planner");
    });

    it("respects dependency ordering between modules", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/task/loader.ts", [{ source: "src/kg/parser.ts", names: ["parse"] }]),
      ];
      const edges: DependencyEdge[] = [
        { from: "src/task/loader.ts", to: "src/kg/parser.ts", imports: ["parse"], isTypeOnly: false },
      ];

      saveModules(db, modules);
      saveEdges(db, edges);

      const task = makeTask();
      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      expect(result.length).toBe(2);

      // task module depends on kg module
      const taskSubtask = result.find(t => t.id === "big-task-task");
      expect(taskSubtask).toBeDefined();
      expect(taskSubtask!.dependsOn).toContain("big-task-kg");
    });

    it("merges groups with high change coupling", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/task/types.ts"),
      ];
      const edges: DependencyEdge[] = [];
      const couplings: ChangeCoupling[] = [
        { fileA: "src/kg/parser.ts", fileB: "src/task/types.ts", cochangeCount: 10, totalCommits: 15, couplingScore: 0.8 },
      ];

      saveModules(db, modules);
      saveEdges(db, edges);
      saveChangeCoupling(db, couplings);

      const task = makeTask();
      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      // Highly coupled files across modules should be merged into one group
      expect(result).toHaveLength(1);
    });

    it("marks low-coverage subtasks with risk notes", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/task/types.ts"),
      ];
      const edges: DependencyEdge[] = [];
      const testMappings: TestCoverageMapping[] = [
        { sourceFile: "src/kg/parser.ts", testFiles: ["test/kg-parser.test.ts"], confidence: "import" },
        // No test mapping for src/task/types.ts
      ];

      saveModules(db, modules);
      saveEdges(db, edges);
      saveTestMappings(db, testMappings);

      const task = makeTask();
      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      expect(result.length).toBe(2);
      const taskSubtask = result.find(t => t.id === "big-task-task");
      expect(taskSubtask).toBeDefined();
      expect(taskSubtask!.riskNotes).toContain("higher risk");
    });

    it("sets decomposition to forbidden on subtasks", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/task/types.ts"),
      ];

      saveModules(db, modules);
      saveEdges(db, []);

      const task = makeTask();
      const strategy = new ModuleBoundaryStrategy();
      const result = await strategy.decompose(task, db);

      for (const subtask of result) {
        expect(subtask.spec.decomposition.strategy).toBe("forbidden");
      }
    });
  });

  describe("decompose()", () => {
    it("produces valid acyclic DAG", async () => {
      const modules = [
        makeModule("src/kg/parser.ts"),
        makeModule("src/kg/graph.ts", [{ source: "src/kg/parser.ts", names: ["parse"] }]),
        makeModule("src/task/types.ts"),
        makeModule("src/task/loader.ts", [{ source: "src/task/types.ts", names: ["TaskSpec"] }]),
      ];
      const edges: DependencyEdge[] = [
        { from: "src/kg/graph.ts", to: "src/kg/parser.ts", imports: ["parse"], isTypeOnly: false },
        { from: "src/task/loader.ts", to: "src/task/types.ts", imports: ["TaskSpec"], isTypeOnly: false },
      ];

      saveModules(db, modules);
      saveEdges(db, edges);

      const task = makeTask();
      const result = await decompose(task, db);

      expect(result.valid).toBe(true);
      expect(result.strategy).toBe("module-boundary");
      expect(result.subtasks.length).toBeGreaterThanOrEqual(1);
      expect(result.error).toBeUndefined();
    });

    it("allows custom strategy", async () => {
      saveModules(db, [makeModule("src/foo/a.ts")]);
      saveEdges(db, []);

      const customStrategy: DecompositionStrategy = {
        name: "custom-test",
        async decompose(task) {
          return [
            { ...task, id: `${task.id}-sub1`, dependsOn: [] },
            { ...task, id: `${task.id}-sub2`, dependsOn: [`${task.id}-sub1`] },
          ];
        },
      };

      const task = makeTask();
      const result = await decompose(task, db, customStrategy);

      expect(result.valid).toBe(true);
      expect(result.strategy).toBe("custom-test");
      expect(result.subtasks).toHaveLength(2);
    });

    it("detects cycles in custom strategy output", async () => {
      saveModules(db, [makeModule("src/foo/a.ts")]);
      saveEdges(db, []);

      const cyclicStrategy: DecompositionStrategy = {
        name: "cyclic-test",
        async decompose(task) {
          return [
            { ...task, id: "a", dependsOn: ["b"] },
            { ...task, id: "b", dependsOn: ["a"] },
          ];
        },
      };

      const task = makeTask();
      const result = await decompose(task, db, cyclicStrategy);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Cycle detected");
    });

    it("detects invalid dependency references", async () => {
      saveModules(db, [makeModule("src/foo/a.ts")]);
      saveEdges(db, []);

      const badRefStrategy: DecompositionStrategy = {
        name: "bad-ref-test",
        async decompose(task) {
          return [
            { ...task, id: "a", dependsOn: ["nonexistent"] },
          ];
        },
      };

      const task = makeTask();
      const result = await decompose(task, db, badRefStrategy);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("unknown task");
    });

    it("returns original task when files are too few to decompose", async () => {
      const modules = [makeModule("src/kg/parser.ts")];
      saveModules(db, modules);
      saveEdges(db, []);

      const task = makeTask({
        spec: {
          ...makeTask().spec,
          context: { files: ["src/kg/parser.ts"] },
        },
      });

      const result = await decompose(task, db);
      expect(result.valid).toBe(true);
      expect(result.subtasks).toHaveLength(1);
      expect(result.subtasks[0].id).toBe("big-task");
    });
  });
});
