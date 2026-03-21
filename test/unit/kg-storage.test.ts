import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createKGDatabase,
  saveModules,
  saveEdges,
  saveTestMappings,
  saveChangeCoupling,
  getModule,
  getDependents,
  getTestsFor,
  getCoupledFiles,
  getStats,
  saveMeta,
  getMeta,
  deleteEdgesFrom,
  deleteTestMappingsFor,
} from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo, DependencyEdge, TestCoverageMapping, ChangeCoupling } from "../../src/kg/types.js";

describe("KG Storage", () => {
  let db: KGDatabase;

  beforeEach(() => {
    // Use in-memory SQLite
    db = createKGDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("saveModules / getModule", () => {
    it("saves and retrieves a module", () => {
      const mod: ModuleInfo = {
        path: "src/foo.ts",
        exports: [{ name: "foo", kind: "function" }],
        imports: [{ source: "src/bar.ts", names: ["bar"], isTypeOnly: false }],
        isTest: false,
        lastModified: "2024-01-01T00:00:00Z",
      };

      saveModules(db, [mod]);
      const result = getModule(db, "src/foo.ts");

      expect(result).toBeDefined();
      expect(result!.path).toBe("src/foo.ts");
      expect(result!.exports).toEqual([{ name: "foo", kind: "function" }]);
      expect(result!.imports).toEqual([{ source: "src/bar.ts", names: ["bar"], isTypeOnly: false }]);
      expect(result!.isTest).toBe(false);
      expect(result!.lastModified).toBe("2024-01-01T00:00:00Z");
    });

    it("upserts existing modules", () => {
      saveModules(db, [{
        path: "src/foo.ts",
        exports: [{ name: "old", kind: "function" }],
        imports: [],
        isTest: false,
      }]);

      saveModules(db, [{
        path: "src/foo.ts",
        exports: [{ name: "new", kind: "class" }],
        imports: [],
        isTest: false,
      }]);

      const result = getModule(db, "src/foo.ts");
      expect(result!.exports).toEqual([{ name: "new", kind: "class" }]);
    });

    it("returns undefined for non-existent module", () => {
      expect(getModule(db, "nonexistent.ts")).toBeUndefined();
    });
  });

  describe("saveEdges / getDependents", () => {
    it("saves and retrieves edges", () => {
      const edges: DependencyEdge[] = [
        { from: "src/a.ts", to: "src/b.ts", imports: ["foo"], isTypeOnly: false },
        { from: "src/c.ts", to: "src/b.ts", imports: ["bar"], isTypeOnly: true },
      ];

      saveEdges(db, edges);
      const result = getDependents(db, "src/b.ts");

      expect(result).toHaveLength(2);
      expect(result.map(e => e.from).sort()).toEqual(["src/a.ts", "src/c.ts"]);
    });

    it("replaces all edges on save", () => {
      saveEdges(db, [
        { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      ]);

      saveEdges(db, [
        { from: "src/c.ts", to: "src/b.ts", imports: ["y"], isTypeOnly: false },
      ]);

      const result = getDependents(db, "src/b.ts");
      expect(result).toHaveLength(1);
      expect(result[0].from).toBe("src/c.ts");
    });
  });

  describe("saveTestMappings / getTestsFor", () => {
    it("saves and retrieves test mappings", () => {
      const mappings: TestCoverageMapping[] = [
        { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts", "test/foo.spec.ts"], confidence: "import" },
      ];

      saveTestMappings(db, mappings);
      const result = getTestsFor(db, "src/foo.ts");

      expect(result).toHaveLength(1);
      expect(result[0].testFiles).toHaveLength(2);
      expect(result[0].testFiles).toContain("test/foo.test.ts");
      expect(result[0].testFiles).toContain("test/foo.spec.ts");
    });

    it("returns empty for unmapped source", () => {
      expect(getTestsFor(db, "src/unknown.ts")).toHaveLength(0);
    });
  });

  describe("saveChangeCoupling / getCoupledFiles", () => {
    it("saves and retrieves coupling data", () => {
      const couplings: ChangeCoupling[] = [
        { fileA: "src/a.ts", fileB: "src/b.ts", cochangeCount: 5, totalCommits: 10, couplingScore: 0.8 },
      ];

      saveChangeCoupling(db, couplings);
      const result = getCoupledFiles(db, "src/a.ts");

      expect(result).toHaveLength(1);
      expect(result[0].couplingScore).toBe(0.8);
    });

    it("finds coupling from either side", () => {
      const couplings: ChangeCoupling[] = [
        { fileA: "src/a.ts", fileB: "src/b.ts", cochangeCount: 5, totalCommits: 10, couplingScore: 0.8 },
      ];

      saveChangeCoupling(db, couplings);

      const fromA = getCoupledFiles(db, "src/a.ts");
      const fromB = getCoupledFiles(db, "src/b.ts");

      expect(fromA).toHaveLength(1);
      expect(fromB).toHaveLength(1);
    });
  });

  describe("getStats", () => {
    it("returns accurate counts", () => {
      saveModules(db, [
        { path: "src/a.ts", exports: [], imports: [], isTest: false },
        { path: "src/b.ts", exports: [], imports: [], isTest: false },
        { path: "test/a.test.ts", exports: [], imports: [], isTest: true },
      ]);

      saveEdges(db, [
        { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
      ]);

      saveTestMappings(db, [
        { sourceFile: "src/a.ts", testFiles: ["test/a.test.ts"], confidence: "import" },
      ]);

      saveChangeCoupling(db, [
        { fileA: "src/a.ts", fileB: "src/b.ts", cochangeCount: 3, totalCommits: 6, couplingScore: 0.5 },
      ]);

      const stats = getStats(db);
      expect(stats.totalModules).toBe(3);
      expect(stats.totalEdges).toBe(1);
      expect(stats.totalTestMappings).toBe(1);
      expect(stats.totalCouplingPairs).toBe(1);
    });
  });

  describe("saveMeta / getMeta", () => {
    it("saves and retrieves metadata", () => {
      saveMeta(db, "last_full_build", "2024-01-01T00:00:00Z");
      expect(getMeta(db, "last_full_build")).toBe("2024-01-01T00:00:00Z");
    });

    it("returns null for missing key", () => {
      expect(getMeta(db, "nonexistent")).toBeNull();
    });

    it("upserts metadata", () => {
      saveMeta(db, "key", "old");
      saveMeta(db, "key", "new");
      expect(getMeta(db, "key")).toBe("new");
    });
  });

  describe("deleteEdgesFrom", () => {
    it("deletes edges from specified paths", () => {
      saveEdges(db, [
        { from: "src/a.ts", to: "src/b.ts", imports: ["x"], isTypeOnly: false },
        { from: "src/c.ts", to: "src/b.ts", imports: ["y"], isTypeOnly: false },
      ]);

      deleteEdgesFrom(db, ["src/a.ts"]);

      const deps = getDependents(db, "src/b.ts");
      expect(deps).toHaveLength(1);
      expect(deps[0].from).toBe("src/c.ts");
    });
  });

  describe("deleteTestMappingsFor", () => {
    it("deletes test mappings for specified source files", () => {
      saveTestMappings(db, [
        { sourceFile: "src/a.ts", testFiles: ["test/a.test.ts"], confidence: "import" },
        { sourceFile: "src/b.ts", testFiles: ["test/b.test.ts"], confidence: "import" },
      ]);

      deleteTestMappingsFor(db, ["src/a.ts"]);

      expect(getTestsFor(db, "src/a.ts")).toHaveLength(0);
      expect(getTestsFor(db, "src/b.ts")).toHaveLength(1);
    });
  });
});
