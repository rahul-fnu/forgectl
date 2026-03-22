import { describe, it, expect } from "vitest";
import { estimateTokenCount } from "../../src/kg/merkle.js";

/**
 * Known token counts measured against cl100k_base (GPT-4 tokenizer) via js-tiktoken.
 * Each sample has a verified actual token count used to validate the heuristic stays
 * within 15% error.
 */
describe("estimateTokenCount", () => {
  const samples: { name: string; code: string; actualTokens: number }[] = [
    {
      name: "import statements",
      code: `import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ModuleInfo, DependencyEdge } from "./types.js";
import type { KGDatabase } from "./storage.js";`,
      actualTokens: 45,
    },
    {
      name: "function signatures with types",
      code: `export function computeTreeHashes(
  modules: ModuleInfo[],
  edges: DependencyEdge[],
): Map<string, string> {
  const deps = new Map<string, Set<string>>();
  const moduleSet = new Set(modules.map(m => m.path));
}`,
      actualTokens: 53,
    },
    {
      name: "logic block with control flow",
      code: `for (const edge of edges) {
    if (!moduleSet.has(edge.from) || !moduleSet.has(edge.to)) continue;
    let s = deps.get(edge.from);
    if (!s) {
      s = new Set();
      deps.set(edge.from, s);
    }
    s.add(edge.to);
  }`,
      actualTokens: 66,
    },
    {
      name: "interface with optional properties",
      code: `export interface ModuleInfo {
  path: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  contentHash?: string;
  treeHash?: string;
  compressedContent?: string;
  tokenCount?: number;
}`,
      actualTokens: 47,
    },
    {
      name: "class with methods",
      code: `export class ConfigManager {
  private config: Record<string, unknown> = {};

  constructor(private readonly configPath: string) {}

  async load(): Promise<void> {
    const raw = await fs.readFile(this.configPath, "utf-8");
    this.config = JSON.parse(raw);
  }

  get<T>(key: string): T | undefined {
    return this.config[key] as T | undefined;
  }
}`,
      actualTokens: 89,
    },
    {
      name: "compressed content (imports + export signatures)",
      code: `import { createHash } from "node:crypto"
import { dirname } from "node:path"
import type { DependencyEdge, ModuleInfo } from "./types.js"
import type { KGDatabase } from "./storage.js"
export function applyContentHashes
export function applyTreeHashes
export function computeContentHash
export function computeRootHash
export function computeTreeHashes
export function estimateTokenCount
export function findAffectedPaths
export function generateCompressedContent
export function updateTreeHashesInDb`,
      actualTokens: 105,
    },
    {
      name: "mixed real code with Map/Set operations",
      code: `const treeHashes = new Map<string, string>();
const visiting = new Set<string>();
const visited = new Set<string>();

function visit(path: string): string {
  if (treeHashes.has(path)) return treeHashes.get(path)!;
  if (visiting.has(path)) {
    const h = contentHashes.get(path) || sha256(path);
    treeHashes.set(path, h);
    return h;
  }
  visiting.add(path);
  const childHashes: string[] = [];
  const children = deps.get(path);
  if (children) {
    for (const child of children) {
      if (moduleSet.has(child)) {
        childHashes.push(visit(child));
      }
    }
  }
  return treeHash;
}`,
      actualTokens: 157,
    },
  ];

  for (const sample of samples) {
    it(`estimates within 15% for ${sample.name}`, () => {
      const estimated = estimateTokenCount(sample.code);
      const errorPct = Math.abs((estimated - sample.actualTokens) / sample.actualTokens) * 100;
      expect(errorPct).toBeLessThan(15);
    });
  }

  it("returns a positive integer for empty string", () => {
    const result = estimateTokenCount("");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("returns a positive integer for single line", () => {
    const result = estimateTokenCount("const x = 42;");
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});
