import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ModuleInfo, DependencyEdge, ExportEntry, ImportEntry } from "./types.js";
import type { KGDatabase } from "./storage.js";

/**
 * Estimate token count for a string using a simple heuristic:
 * ~4 characters per token on average for code.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate a compact semantic representation of a module.
 * Includes function/class signatures, exported constants, and import list.
 * Ignores whitespace and comments — only semantic content matters.
 */
export function generateCompressedContent(mod: ModuleInfo): string {
  const lines: string[] = [];

  // Imports
  if (mod.imports.length > 0) {
    for (const imp of mod.imports) {
      const typePrefix = imp.isTypeOnly ? "type " : "";
      if (imp.names.length > 0) {
        lines.push(`import ${typePrefix}{ ${imp.names.sort().join(", ")} } from "${imp.source}"`);
      } else {
        lines.push(`import "${imp.source}"`);
      }
    }
  }

  // Exports (sorted by kind then name for stability)
  const sortedExports = [...mod.exports].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });

  for (const exp of sortedExports) {
    lines.push(`export ${exp.kind} ${exp.name}`);
  }

  return lines.join("\n");
}

/**
 * Compute SHA256 content hash of a module's semantic representation.
 * This hash changes only when exports, imports, or their structure change —
 * not when whitespace or comments change.
 */
export function computeContentHash(mod: ModuleInfo): string {
  const semantic = generateCompressedContent(mod);
  return sha256(semantic);
}

/**
 * Compute tree hashes for all modules by walking the dependency DAG bottom-up.
 * A module's tree_hash = sha256(content_hash + sorted child tree_hashes).
 * For directory grouping: a directory's tree_hash = sha256(sorted child tree_hashes).
 */
export function computeTreeHashes(
  modules: ModuleInfo[],
  edges: DependencyEdge[],
): Map<string, string> {
  // Build forward adjacency: module -> its dependencies
  const deps = new Map<string, Set<string>>();
  const moduleSet = new Set(modules.map(m => m.path));

  for (const edge of edges) {
    if (!moduleSet.has(edge.from) || !moduleSet.has(edge.to)) continue;
    let s = deps.get(edge.from);
    if (!s) {
      s = new Set();
      deps.set(edge.from, s);
    }
    s.add(edge.to);
  }

  // Ensure content hashes exist
  const contentHashes = new Map<string, string>();
  for (const mod of modules) {
    contentHashes.set(mod.path, mod.contentHash || computeContentHash(mod));
  }

  // Topological sort (post-order DFS) to compute bottom-up
  const treeHashes = new Map<string, string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(path: string): string {
    if (treeHashes.has(path)) return treeHashes.get(path)!;
    if (visiting.has(path)) {
      // Cycle — use content hash only
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

    const contentHash = contentHashes.get(path) || sha256(path);
    childHashes.sort();
    const combined = contentHash + childHashes.join("");
    const treeHash = sha256(combined);

    treeHashes.set(path, treeHash);
    visiting.delete(path);
    visited.add(path);

    return treeHash;
  }

  for (const mod of modules) {
    if (!visited.has(mod.path)) {
      visit(mod.path);
    }
  }

  // Also compute directory-level tree hashes
  const dirChildren = new Map<string, string[]>();
  for (const mod of modules) {
    const dir = dirname(mod.path);
    let children = dirChildren.get(dir);
    if (!children) {
      children = [];
      dirChildren.set(dir, children);
    }
    children.push(treeHashes.get(mod.path) || "");
  }

  for (const [dir, children] of dirChildren) {
    children.sort();
    treeHashes.set(dir, sha256(children.join("")));
  }

  return treeHashes;
}

/**
 * Compute the root hash for the entire codebase.
 * root_hash = sha256(sorted tree_hashes of all modules).
 */
export function computeRootHash(modules: ModuleInfo[]): string {
  const hashes = modules
    .map(m => m.treeHash || m.contentHash || "")
    .filter(h => h.length > 0)
    .sort();
  return sha256(hashes.join(""));
}

/**
 * Apply merkle properties (content hash, compressed content, token count)
 * to a set of modules. Mutates the modules in place.
 */
export function applyContentHashes(modules: ModuleInfo[]): void {
  for (const mod of modules) {
    mod.compressedContent = generateCompressedContent(mod);
    mod.contentHash = sha256(mod.compressedContent);
    mod.tokenCount = estimateTokenCount(mod.compressedContent);
  }
}

/**
 * Apply tree hashes to modules. Mutates in place.
 */
export function applyTreeHashes(modules: ModuleInfo[], edges: DependencyEdge[]): void {
  const treeHashes = computeTreeHashes(modules, edges);
  for (const mod of modules) {
    const hash = treeHashes.get(mod.path);
    if (hash) {
      mod.treeHash = hash;
    }
  }
}

/**
 * Given the set of changed file paths, find all ancestor modules that need
 * tree hash recomputation by walking reverse edges.
 */
export function findAffectedPaths(
  changedPaths: string[],
  edges: DependencyEdge[],
  allPaths: string[],
): Set<string> {
  // Reverse adjacency: dependency -> dependents
  const reverseAdj = new Map<string, Set<string>>();
  for (const edge of edges) {
    let s = reverseAdj.get(edge.to);
    if (!s) {
      s = new Set();
      reverseAdj.set(edge.to, s);
    }
    s.add(edge.from);
  }

  const affected = new Set<string>(changedPaths);
  const queue = [...changedPaths];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = reverseAdj.get(current);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return affected;
}

/**
 * Save tree hashes for specific modules in the database.
 */
export function updateTreeHashesInDb(
  db: KGDatabase,
  treeHashes: Map<string, string>,
): void {
  const stmt = db.prepare("UPDATE kg_modules SET tree_hash = ? WHERE path = ?");
  const tx = db.transaction(() => {
    for (const [path, hash] of treeHashes) {
      stmt.run(hash, path);
    }
  });
  tx();
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
