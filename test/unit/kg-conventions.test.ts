import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKGDatabase, saveModules } from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo } from "../../src/kg/types.js";
import {
  analyzeExportPatterns,
  analyzeImportPatterns,
  analyzeTestingPatterns,
  analyzeConventions,
  saveConventions,
  loadConventions,
  type Convention,
} from "../../src/kg/conventions.js";

function makeModule(overrides: Partial<ModuleInfo> & { path: string }): ModuleInfo {
  return {
    exports: [],
    imports: [],
    isTest: false,
    ...overrides,
  };
}

describe("KG Conventions", () => {
  let db: KGDatabase;

  beforeEach(() => {
    db = createKGDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("analyzeExportPatterns", () => {
    it("detects factory function pattern", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/storage/repositories/runs.ts",
          exports: [
            { name: "createRunRepository", kind: "function" },
            { name: "RunRepository", kind: "interface" },
          ],
        }),
        makeModule({
          path: "src/storage/repositories/costs.ts",
          exports: [
            { name: "createCostRepository", kind: "function" },
            { name: "CostRepository", kind: "interface" },
          ],
        }),
        makeModule({
          path: "src/storage/repositories/events.ts",
          exports: [
            { name: "createEventRepository", kind: "function" },
          ],
        }),
      ];

      const conventions = analyzeExportPatterns(modules);
      const factory = conventions.find(c => c.pattern.includes("factory function"));
      expect(factory).toBeDefined();
      expect(factory!.module).toBe("src/storage/repositories");
      expect(factory!.confidence).toBeGreaterThan(0);
      expect(factory!.examples.length).toBeGreaterThan(0);
    });

    it("detects class-based exports", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/orchestrator/state.ts",
          exports: [{ name: "SlotManager", kind: "class" }],
        }),
        makeModule({
          path: "src/orchestrator/metrics.ts",
          exports: [{ name: "MetricsCollector", kind: "class" }],
        }),
      ];

      const conventions = analyzeExportPatterns(modules);
      const classBased = conventions.find(c => c.pattern.includes("class-based"));
      expect(classBased).toBeDefined();
      expect(classBased!.module).toBe("src/orchestrator");
    });

    it("detects dedicated type definition files", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/tracker/types.ts",
          exports: [
            { name: "TrackerAdapter", kind: "interface" },
            { name: "TrackerConfig", kind: "interface" },
            { name: "TrackerIssue", kind: "interface" },
          ],
        }),
        makeModule({
          path: "src/tracker/github.ts",
          exports: [{ name: "createGitHubAdapter", kind: "function" }],
        }),
      ];

      const conventions = analyzeExportPatterns(modules);
      const typeDefs = conventions.find(c => c.pattern.includes("type definition"));
      expect(typeDefs).toBeDefined();
    });

    it("detects barrel exports", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/agent/index.ts",
          imports: [
            { source: "src/agent/session.js", names: ["createAgentSession"], isTypeOnly: false },
            { source: "src/agent/registry.js", names: ["getAgentAdapter"], isTypeOnly: false },
            { source: "src/agent/types.js", names: ["AgentAdapter"], isTypeOnly: true },
          ],
        }),
        makeModule({
          path: "src/agent/session.ts",
          exports: [{ name: "createAgentSession", kind: "function" }],
        }),
        makeModule({
          path: "src/agent/registry.ts",
          exports: [{ name: "getAgentAdapter", kind: "function" }],
        }),
      ];

      const conventions = analyzeExportPatterns(modules);
      const barrel = conventions.find(c => c.pattern.includes("barrel"));
      expect(barrel).toBeDefined();
      expect(barrel!.module).toBe("src/agent");
    });
  });

  describe("analyzeImportPatterns", () => {
    it("detects type-only import separation", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/orchestrator/dispatcher.ts",
          imports: [
            { source: "src/tracker/types.js", names: ["TrackerAdapter"], isTypeOnly: true },
            { source: "src/config/schema.js", names: ["ForgectlConfig"], isTypeOnly: false },
          ],
        }),
        makeModule({
          path: "src/orchestrator/worker.ts",
          imports: [
            { source: "src/workflow/types.js", names: ["RunPlan"], isTypeOnly: true },
            { source: "src/agent/session.js", names: ["createAgentSession"], isTypeOnly: false },
          ],
        }),
      ];

      const conventions = analyzeImportPatterns(modules);
      const typeOnly = conventions.find(c => c.pattern.includes("type-only"));
      expect(typeOnly).toBeDefined();
      expect(typeOnly!.confidence).toBeGreaterThan(0);
    });

    it("detects absolute import preference", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "src/orchestrator/a.ts",
          imports: [
            { source: "src/config/schema.js", names: ["ConfigSchema"], isTypeOnly: false },
            { source: "src/tracker/types.js", names: ["TrackerIssue"], isTypeOnly: true },
            { source: "src/logging/logger.js", names: ["Logger"], isTypeOnly: true },
          ],
        }),
        makeModule({
          path: "src/orchestrator/b.ts",
          imports: [
            { source: "src/config/loader.js", names: ["loadConfig"], isTypeOnly: false },
            { source: "src/storage/database.js", names: ["createDatabase"], isTypeOnly: false },
          ],
        }),
      ];

      const conventions = analyzeImportPatterns(modules);
      const absolute = conventions.find(c => c.pattern.includes("absolute"));
      expect(absolute).toBeDefined();
      expect(absolute!.confidence).toBeGreaterThan(0.5);
    });
  });

  describe("analyzeTestingPatterns", () => {
    it("detects test file naming convention", () => {
      const modules: ModuleInfo[] = [
        makeModule({ path: "test/unit/foo.test.ts", isTest: true }),
        makeModule({ path: "test/unit/bar.test.ts", isTest: true }),
        makeModule({ path: "test/unit/baz.test.ts", isTest: true }),
      ];

      const conventions = analyzeTestingPatterns(modules);
      const naming = conventions.find(c => c.pattern.includes("test file naming"));
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain("*.test.ts");
    });

    it("detects vitest describe/it pattern", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "test/unit/a.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "expect"], isTypeOnly: false }],
        }),
        makeModule({
          path: "test/unit/b.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "expect", "vi"], isTypeOnly: false }],
        }),
      ];

      const conventions = analyzeTestingPatterns(modules);
      const structure = conventions.find(c => c.pattern.includes("describe/it"));
      expect(structure).toBeDefined();
    });

    it("detects vi.fn() mocking pattern", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "test/unit/x.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "vi"], isTypeOnly: false }],
        }),
        makeModule({
          path: "test/unit/y.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "vi", "beforeEach"], isTypeOnly: false }],
        }),
      ];

      const conventions = analyzeTestingPatterns(modules);
      const mocking = conventions.find(c => c.pattern.includes("vi.fn()"));
      expect(mocking).toBeDefined();
    });

    it("detects beforeEach setup pattern", () => {
      const modules: ModuleInfo[] = [
        makeModule({
          path: "test/unit/c.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "beforeEach"], isTypeOnly: false }],
        }),
        makeModule({
          path: "test/unit/d.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "beforeEach", "afterEach"], isTypeOnly: false }],
        }),
      ];

      const conventions = analyzeTestingPatterns(modules);
      const setup = conventions.find(c => c.pattern.includes("beforeEach"));
      expect(setup).toBeDefined();
    });
  });

  describe("saveConventions / loadConventions", () => {
    it("round-trips conventions through kg_meta", () => {
      const conventions: Convention[] = [
        {
          pattern: "factory function pattern",
          module: "src/storage/repositories",
          confidence: 0.85,
          examples: ["createRunRepository", "createCostRepository"],
        },
      ];

      saveConventions(db, conventions);
      const loaded = loadConventions(db);

      expect(loaded).toEqual(conventions);
    });

    it("returns empty array when no conventions stored", () => {
      const loaded = loadConventions(db);
      expect(loaded).toEqual([]);
    });
  });

  describe("analyzeConventions (integration)", () => {
    it("discovers at least 5 conventions from rich module data", () => {
      const modules: ModuleInfo[] = [
        // Factory pattern modules
        makeModule({
          path: "src/storage/repositories/runs.ts",
          exports: [
            { name: "createRunRepository", kind: "function" },
            { name: "RunRepository", kind: "interface" },
          ],
          imports: [
            { source: "src/storage/schema.js", names: ["runs"], isTypeOnly: false },
            { source: "src/storage/database.js", names: ["AppDatabase"], isTypeOnly: true },
          ],
        }),
        makeModule({
          path: "src/storage/repositories/costs.ts",
          exports: [
            { name: "createCostRepository", kind: "function" },
            { name: "CostRepository", kind: "interface" },
          ],
          imports: [
            { source: "src/storage/schema.js", names: ["runCosts"], isTypeOnly: false },
            { source: "src/storage/database.js", names: ["AppDatabase"], isTypeOnly: true },
          ],
        }),
        makeModule({
          path: "src/storage/repositories/events.ts",
          exports: [
            { name: "createEventRepository", kind: "function" },
            { name: "EventRepository", kind: "interface" },
          ],
          imports: [
            { source: "src/storage/schema.js", names: ["runEvents"], isTypeOnly: false },
          ],
        }),
        // Type definition modules
        makeModule({
          path: "src/tracker/types.ts",
          exports: [
            { name: "TrackerAdapter", kind: "interface" },
            { name: "TrackerConfig", kind: "interface" },
            { name: "TrackerIssue", kind: "interface" },
          ],
        }),
        makeModule({
          path: "src/tracker/github.ts",
          imports: [
            { source: "src/tracker/types.js", names: ["TrackerAdapter"], isTypeOnly: true },
            { source: "src/tracker/token.js", names: ["resolveToken"], isTypeOnly: false },
          ],
          exports: [{ name: "createGitHubAdapter", kind: "function" }],
        }),
        // Class-based modules
        makeModule({
          path: "src/orchestrator/state.ts",
          exports: [
            { name: "SlotManager", kind: "class" },
            { name: "OrchestratorState", kind: "interface" },
          ],
        }),
        makeModule({
          path: "src/orchestrator/metrics.ts",
          exports: [{ name: "MetricsCollector", kind: "class" }],
        }),
        // Test modules
        makeModule({
          path: "test/unit/storage.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "expect", "vi", "beforeEach"], isTypeOnly: false }],
        }),
        makeModule({
          path: "test/unit/tracker.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "expect", "vi", "beforeEach"], isTypeOnly: false }],
        }),
        makeModule({
          path: "test/unit/metrics.test.ts",
          isTest: true,
          imports: [{ source: "vitest", names: ["describe", "it", "expect", "vi"], isTypeOnly: false }],
        }),
      ];

      saveModules(db, modules);
      // analyzeConventions reads from db but also needs repoRoot for error handling
      // Since these are synthetic modules without real files, error handling analysis
      // will be skipped, but the other patterns should produce enough conventions
      const conventions = analyzeConventions(db, "/nonexistent");

      expect(conventions.length).toBeGreaterThanOrEqual(5);

      // Verify each convention has required fields
      for (const conv of conventions) {
        expect(conv.pattern).toBeTruthy();
        expect(conv.module).toBeTruthy();
        expect(conv.confidence).toBeGreaterThan(0);
        expect(conv.confidence).toBeLessThanOrEqual(1);
        expect(conv.examples.length).toBeGreaterThan(0);
      }
    });
  });
});
