import { describe, it, expect } from "vitest";
import { buildTestMappings } from "../../src/kg/test-mapping.js";
import type { ModuleInfo } from "../../src/kg/types.js";

function makeModule(
  path: string,
  opts: { isTest?: boolean; imports?: Array<{ source: string }> } = {},
): ModuleInfo {
  return {
    path,
    exports: [],
    imports: (opts.imports || []).map(i => ({
      source: i.source,
      names: ["*"],
      isTypeOnly: false,
    })),
    isTest: opts.isTest ?? false,
  };
}

describe("buildTestMappings", () => {
  describe("import-based mapping", () => {
    it("maps test to source when test imports source", () => {
      const modules = [
        makeModule("src/config/loader.ts"),
        makeModule("test/unit/config.test.ts", {
          isTest: true,
          imports: [{ source: "src/config/loader.ts" }],
        }),
      ];

      const mappings = buildTestMappings(modules);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceFile).toBe("src/config/loader.ts");
      expect(mappings[0].testFiles).toContain("test/unit/config.test.ts");
      expect(mappings[0].confidence).toBe("import");
    });

    it("maps multiple tests to same source", () => {
      const modules = [
        makeModule("src/utils.ts"),
        makeModule("test/unit/utils.test.ts", {
          isTest: true,
          imports: [{ source: "src/utils.ts" }],
        }),
        makeModule("test/integration/utils.test.ts", {
          isTest: true,
          imports: [{ source: "src/utils.ts" }],
        }),
      ];

      const mappings = buildTestMappings(modules);
      const utilsMapping = mappings.find(m => m.sourceFile === "src/utils.ts");
      expect(utilsMapping).toBeDefined();
      expect(utilsMapping!.testFiles).toHaveLength(2);
    });
  });

  describe("name-based mapping", () => {
    it("maps by matching filenames", () => {
      const modules = [
        makeModule("src/config/loader.ts"),
        makeModule("test/unit/loader.test.ts", { isTest: true }),
      ];

      const mappings = buildTestMappings(modules);
      const loaderMapping = mappings.find(m => m.sourceFile === "src/config/loader.ts");
      expect(loaderMapping).toBeDefined();
      expect(loaderMapping!.testFiles).toContain("test/unit/loader.test.ts");
      expect(loaderMapping!.confidence).toBe("name_match");
    });

    it("does not duplicate if already mapped by import", () => {
      const modules = [
        makeModule("src/utils.ts"),
        makeModule("test/unit/utils.test.ts", {
          isTest: true,
          imports: [{ source: "src/utils.ts" }],
        }),
      ];

      const mappings = buildTestMappings(modules);
      const utilsMapping = mappings.find(m => m.sourceFile === "src/utils.ts");
      expect(utilsMapping).toBeDefined();
      // Should have exactly 1 test file, not duplicated
      expect(utilsMapping!.testFiles).toHaveLength(1);
      expect(utilsMapping!.confidence).toBe("import");
    });
  });

  describe("directory-based mapping", () => {
    it("maps by matching directory structure", () => {
      const modules = [
        makeModule("src/auth/keychain.ts"),
        makeModule("test/unit/auth/other.test.ts", { isTest: true }),
      ];

      const mappings = buildTestMappings(modules);
      const authMapping = mappings.find(m => m.sourceFile === "src/auth/keychain.ts");
      expect(authMapping).toBeDefined();
      expect(authMapping!.testFiles).toContain("test/unit/auth/other.test.ts");
      expect(authMapping!.confidence).toBe("directory");
    });
  });

  describe("confidence ordering", () => {
    it("import confidence is highest", () => {
      const modules = [
        makeModule("src/utils.ts"),
        makeModule("test/unit/utils.test.ts", {
          isTest: true,
          imports: [{ source: "src/utils.ts" }],
        }),
      ];

      const mappings = buildTestMappings(modules);
      expect(mappings[0].confidence).toBe("import");
    });
  });

  it("excludes test files from source modules", () => {
    const modules = [
      makeModule("test/unit/foo.test.ts", { isTest: true }),
      makeModule("test/unit/bar.test.ts", { isTest: true }),
    ];

    const mappings = buildTestMappings(modules);
    // No source modules, so no mappings
    expect(mappings).toHaveLength(0);
  });
});
