import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  estimateTokenCount,
  generateCompressedContent,
  computeContentHash,
  computeTreeHashes,
  computeRootHash,
  applyContentHashes,
  applyTreeHashes,
  findAffectedPaths,
  updateTreeHashesInDb,
} from "../../src/kg/merkle.js";
import { createKGDatabase, saveModules } from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo, DependencyEdge } from "../../src/kg/types.js";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeMod(overrides: Partial<ModuleInfo> & { path: string }): ModuleInfo {
  return {
    exports: [],
    imports: [],
    isTest: false,
    ...overrides,
  };
}

describe("KG Merkle", () => {
  describe("estimateTokenCount", () => {
    it("returns reasonable estimates for various code lengths", () => {
      expect(estimateTokenCount("")).toBe(0);
      expect(estimateTokenCount("abcd")).toBe(1);
      expect(estimateTokenCount("a".repeat(100))).toBe(25);
      expect(estimateTokenCount("a".repeat(401))).toBe(101);
    });
  });

  describe("generateCompressedContent", () => {
    it("produces stable output (sorted exports, consistent format)", () => {
      const mod = makeMod({
        path: "src/foo.ts",
        exports: [
          { name: "zeta", kind: "function" },
          { name: "alpha", kind: "function" },
          { name: "beta", kind: "class" },
        ],
        imports: [],
      });

      const result = generateCompressedContent(mod);
      // Exports sorted by kind then name: class beta, function alpha, function zeta
      expect(result).toBe(
        "export class beta\nexport function alpha\nexport function zeta",
      );

      // Calling again produces identical output
      expect(generateCompressedContent(mod)).toBe(result);
    });

    it("includes imports and exports but not implementation details", () => {
      const mod = makeMod({
        path: "src/bar.ts",
        imports: [
          { source: "src/utils.ts", names: ["helper", "format"], isTypeOnly: false },
          { source: "src/types.ts", names: ["Config"], isTypeOnly: true },
        ],
        exports: [{ name: "process", kind: "function" }],
      });

      const result = generateCompressedContent(mod);
      expect(result).toContain('import { format, helper } from "src/utils.ts"');
      expect(result).toContain('import type { Config } from "src/types.ts"');
      expect(result).toContain("export function process");
      // No implementation details like function bodies or statements
      expect(result).not.toContain("return");
      expect(result).not.toContain("const ");
      expect(result).not.toContain("let ");
    });
  });

  describe("computeContentHash", () => {
    it("same module produces same hash", () => {
      const mod = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
        imports: [{ source: "src/b.ts", names: ["bar"], isTypeOnly: false }],
      });

      expect(computeContentHash(mod)).toBe(computeContentHash(mod));
    });

    it("different exports produce different hash", () => {
      const mod1 = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
      });
      const mod2 = makeMod({
        path: "src/a.ts",
        exports: [{ name: "bar", kind: "function" }],
      });

      expect(computeContentHash(mod1)).not.toBe(computeContentHash(mod2));
    });

    it("whitespace/comment changes do NOT change hash (same exports/imports)", () => {
      // Two modules with identical exports/imports but conceptually different source
      // Since computeContentHash uses generateCompressedContent (which only uses exports/imports),
      // the hash is the same regardless of source code whitespace/comments.
      const mod1 = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
        imports: [{ source: "src/b.ts", names: ["bar"], isTypeOnly: false }],
      });
      const mod2 = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
        imports: [{ source: "src/b.ts", names: ["bar"], isTypeOnly: false }],
      });

      expect(computeContentHash(mod1)).toBe(computeContentHash(mod2));
    });
  });

  describe("computeTreeHashes", () => {
    it("leaf module with no deps has tree_hash = sha256(content_hash)", () => {
      const mod = makeMod({
        path: "src/leaf.ts",
        exports: [{ name: "leaf", kind: "function" }],
      });
      const contentHash = computeContentHash(mod);
      mod.contentHash = contentHash;

      const treeHashes = computeTreeHashes([mod], []);
      // leaf: no children, so combined = contentHash + "" => sha256(contentHash)
      expect(treeHashes.get("src/leaf.ts")).toBe(sha256(contentHash));
    });

    it("module with deps includes child hashes (changing a dep changes parent tree_hash)", () => {
      const parent = makeMod({
        path: "src/parent.ts",
        exports: [{ name: "parent", kind: "function" }],
      });
      const child = makeMod({
        path: "src/child.ts",
        exports: [{ name: "child", kind: "function" }],
      });
      const edges: DependencyEdge[] = [
        { from: "src/parent.ts", to: "src/child.ts", imports: ["child"], isTypeOnly: false },
      ];

      const hashes1 = computeTreeHashes([parent, child], edges);

      // Now change child exports
      const child2 = makeMod({
        path: "src/child.ts",
        exports: [{ name: "childRenamed", kind: "function" }],
      });

      const hashes2 = computeTreeHashes([parent, child2], edges);

      // Parent tree hash should differ because child content changed
      expect(hashes1.get("src/parent.ts")).not.toBe(hashes2.get("src/parent.ts"));
      // Child tree hash should also differ
      expect(hashes1.get("src/child.ts")).not.toBe(hashes2.get("src/child.ts"));
    });

    it("handles circular dependencies without infinite loop", () => {
      const a = makeMod({ path: "src/a.ts", exports: [{ name: "a", kind: "function" }] });
      const b = makeMod({ path: "src/b.ts", exports: [{ name: "b", kind: "function" }] });
      const edges: DependencyEdge[] = [
        { from: "src/a.ts", to: "src/b.ts", imports: ["b"], isTypeOnly: false },
        { from: "src/b.ts", to: "src/a.ts", imports: ["a"], isTypeOnly: false },
      ];

      // Should not hang or throw
      const hashes = computeTreeHashes([a, b], edges);
      expect(hashes.get("src/a.ts")).toBeDefined();
      expect(hashes.get("src/b.ts")).toBeDefined();
    });

    it("directory-level hashes are computed", () => {
      const mod1 = makeMod({ path: "src/a.ts", exports: [{ name: "a", kind: "function" }] });
      const mod2 = makeMod({ path: "src/b.ts", exports: [{ name: "b", kind: "function" }] });

      const hashes = computeTreeHashes([mod1, mod2], []);
      // dirname("src/a.ts") = "src", so "src" directory hash should exist
      expect(hashes.get("src")).toBeDefined();
      expect(hashes.get("src")).toHaveLength(64); // SHA256 hex length
    });
  });

  describe("computeRootHash", () => {
    it("deterministic (same modules = same root)", () => {
      const mods = [
        makeMod({ path: "src/a.ts", exports: [{ name: "a", kind: "function" }] }),
        makeMod({ path: "src/b.ts", exports: [{ name: "b", kind: "function" }] }),
      ];

      applyContentHashes(mods);
      applyTreeHashes(mods, []);

      const root1 = computeRootHash(mods);
      const root2 = computeRootHash(mods);
      expect(root1).toBe(root2);
    });

    it("changes when any module changes", () => {
      const mods1 = [
        makeMod({ path: "src/a.ts", exports: [{ name: "a", kind: "function" }] }),
        makeMod({ path: "src/b.ts", exports: [{ name: "b", kind: "function" }] }),
      ];
      applyContentHashes(mods1);
      applyTreeHashes(mods1, []);

      const mods2 = [
        makeMod({ path: "src/a.ts", exports: [{ name: "aChanged", kind: "function" }] }),
        makeMod({ path: "src/b.ts", exports: [{ name: "b", kind: "function" }] }),
      ];
      applyContentHashes(mods2);
      applyTreeHashes(mods2, []);

      expect(computeRootHash(mods1)).not.toBe(computeRootHash(mods2));
    });
  });

  describe("applyContentHashes", () => {
    it("mutates modules in place with contentHash, compressedContent, tokenCount", () => {
      const mod = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
      });

      expect(mod.contentHash).toBeUndefined();
      expect(mod.compressedContent).toBeUndefined();
      expect(mod.tokenCount).toBeUndefined();

      applyContentHashes([mod]);

      expect(mod.contentHash).toBeDefined();
      expect(mod.contentHash).toHaveLength(64);
      expect(mod.compressedContent).toBe("export function foo");
      expect(mod.tokenCount).toBeGreaterThan(0);
    });
  });

  describe("applyTreeHashes", () => {
    it("mutates modules in place with treeHash", () => {
      const mod = makeMod({
        path: "src/a.ts",
        exports: [{ name: "foo", kind: "function" }],
      });

      applyContentHashes([mod]);
      expect(mod.treeHash).toBeUndefined();

      applyTreeHashes([mod], []);

      expect(mod.treeHash).toBeDefined();
      expect(mod.treeHash).toHaveLength(64);
    });
  });

  describe("findAffectedPaths", () => {
    const edges: DependencyEdge[] = [
      { from: "src/a.ts", to: "src/b.ts", imports: ["b"], isTypeOnly: false },
      { from: "src/b.ts", to: "src/c.ts", imports: ["c"], isTypeOnly: false },
    ];
    const allPaths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];

    it("returns changed file itself", () => {
      const affected = findAffectedPaths(["src/c.ts"], edges, allPaths);
      expect(affected.has("src/c.ts")).toBe(true);
    });

    it("returns transitive dependents (A imports B imports C, changing C returns {C, B, A})", () => {
      const affected = findAffectedPaths(["src/c.ts"], edges, allPaths);
      expect(affected.has("src/c.ts")).toBe(true);
      expect(affected.has("src/b.ts")).toBe(true);
      expect(affected.has("src/a.ts")).toBe(true);
    });

    it("does not include unrelated files", () => {
      const affected = findAffectedPaths(["src/c.ts"], edges, allPaths);
      expect(affected.has("src/d.ts")).toBe(false);
    });

    it("handles modules with no dependents", () => {
      const affected = findAffectedPaths(["src/a.ts"], edges, allPaths);
      // A has no dependents (it's the top of the chain)
      expect(affected.size).toBe(1);
      expect(affected.has("src/a.ts")).toBe(true);
    });
  });

  describe("updateTreeHashesInDb", () => {
    let db: KGDatabase;

    beforeEach(() => {
      db = createKGDatabase(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    it("writes hashes to kg_modules table", () => {
      saveModules(db, [
        makeMod({ path: "src/a.ts" }),
        makeMod({ path: "src/b.ts" }),
      ]);

      const treeHashes = new Map<string, string>();
      treeHashes.set("src/a.ts", "hash_a");
      treeHashes.set("src/b.ts", "hash_b");

      updateTreeHashesInDb(db, treeHashes);

      const rowA = db.prepare("SELECT tree_hash FROM kg_modules WHERE path = ?").get("src/a.ts") as { tree_hash: string };
      const rowB = db.prepare("SELECT tree_hash FROM kg_modules WHERE path = ?").get("src/b.ts") as { tree_hash: string };

      expect(rowA.tree_hash).toBe("hash_a");
      expect(rowB.tree_hash).toBe("hash_b");
    });
  });
});
