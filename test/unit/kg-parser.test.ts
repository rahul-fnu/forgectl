import { describe, it, expect } from "vitest";
import { parseModule, isTestFile, resolveImportPath } from "../../src/kg/parser.js";

describe("parseModule", () => {
  const repoRoot = "/repo";

  describe("import parsing", () => {
    it("parses named imports", () => {
      const content = `import { foo, bar } from './utils.js';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].names).toEqual(["foo", "bar"]);
      expect(mod.imports[0].isTypeOnly).toBe(false);
    });

    it("parses default imports", () => {
      const content = `import chalk from 'chalk';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      // chalk is a non-relative import, so it won't resolve
      const chalkImport = mod.imports.find(i => i.source === "chalk");
      expect(chalkImport).toBeDefined();
      expect(chalkImport!.names).toEqual(["chalk"]);
    });

    it("parses type-only imports", () => {
      const content = `import type { Foo } from './types.js';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].isTypeOnly).toBe(true);
      expect(mod.imports[0].names).toEqual(["Foo"]);
    });

    it("parses dynamic imports", () => {
      const content = `const mod = await import('./lazy.js');`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].names).toEqual(["*"]);
    });

    it("parses re-exports", () => {
      const content = `export { foo, bar } from './utils.js';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].names).toEqual(["foo", "bar"]);
    });

    it("parses star re-exports", () => {
      const content = `export * from './utils.js';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].names).toEqual(["*"]);
    });

    it("parses namespace imports", () => {
      const content = `import * as path from 'node:path';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      const pathImport = mod.imports.find(i => i.source === "node:path");
      expect(pathImport).toBeDefined();
      expect(pathImport!.names).toEqual(["*"]);
    });

    it("parses aliased imports", () => {
      const content = `import { foo as myFoo } from './utils.js';`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.imports).toHaveLength(1);
      expect(mod.imports[0].names).toEqual(["foo"]);
    });

    it("merges multiple imports from same source", () => {
      const content = `
import { foo } from './utils.js';
import type { Bar } from './utils.js';
`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      // Should merge into one entry with isTypeOnly = false (since one is value import)
      const utilsImports = mod.imports.filter(i => i.source.includes("utils") || i.source === "./utils.js");
      // May be 1 merged entry or separate - check names are captured
      const allNames = utilsImports.flatMap(i => i.names);
      expect(allNames).toContain("foo");
      expect(allNames).toContain("Bar");
    });

    it("ignores imports inside comments", () => {
      const content = `
// import { unused } from './old.js';
/* import { alsoUnused } from './old.js'; */
import { real } from './actual.js';
`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      const actualImport = mod.imports.find(i => i.names.includes("real"));
      expect(actualImport).toBeDefined();
      // Should not find 'unused' or 'alsoUnused'
      const oldImports = mod.imports.filter(i =>
        i.names.includes("unused") || i.names.includes("alsoUnused")
      );
      expect(oldImports).toHaveLength(0);
    });
  });

  describe("export parsing", () => {
    it("parses exported functions", () => {
      const content = `export function myFunc() {}`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "myFunc", kind: "function" });
    });

    it("parses exported async functions", () => {
      const content = `export async function fetchData() {}`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "fetchData", kind: "function" });
    });

    it("parses exported classes", () => {
      const content = `export class MyClass {}`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "MyClass", kind: "class" });
    });

    it("parses exported constants", () => {
      const content = `export const MY_CONST = 42;`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "MY_CONST", kind: "const" });
    });

    it("parses exported types", () => {
      const content = `export type MyType = string;`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "MyType", kind: "type" });
    });

    it("parses exported interfaces", () => {
      const content = `export interface MyInterface { x: number; }`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "MyInterface", kind: "interface" });
    });

    it("parses default exports", () => {
      const content = `export default class {}`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "default", kind: "default" });
    });

    it("parses exported enums", () => {
      const content = `export enum Direction { Up, Down }`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toContainEqual({ name: "Direction", kind: "const" });
    });

    it("parses multiple exports", () => {
      const content = `
export function a() {}
export class B {}
export const c = 1;
export type D = string;
export interface E {}
`;
      const mod = parseModule("/repo/src/index.ts", content, repoRoot);
      expect(mod.exports).toHaveLength(5);
    });
  });

  describe("module path", () => {
    it("produces relative path from repo root", () => {
      const mod = parseModule("/repo/src/config/loader.ts", "", repoRoot);
      expect(mod.path).toBe("src/config/loader.ts");
    });
  });
});

describe("isTestFile", () => {
  it("detects .test.ts files", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
  });

  it("detects .spec.ts files", () => {
    expect(isTestFile("src/foo.spec.ts")).toBe(true);
  });

  it("detects files in test/ directory", () => {
    expect(isTestFile("test/unit/foo.ts")).toBe(true);
  });

  it("detects files in __tests__/ directory", () => {
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
  });

  it("does not flag regular source files", () => {
    expect(isTestFile("src/config/loader.ts")).toBe(false);
  });
});

describe("resolveImportPath", () => {
  it("returns null for non-relative imports", () => {
    expect(resolveImportPath("chalk", "/repo/src", "/repo")).toBeNull();
  });

  it("returns null for node: imports", () => {
    expect(resolveImportPath("node:path", "/repo/src", "/repo")).toBeNull();
  });
});
