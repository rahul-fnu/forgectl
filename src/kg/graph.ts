import type { ModuleInfo, DependencyEdge } from "./types.js";

/**
 * Build dependency edges from parsed module information.
 */
export function buildDependencyGraph(modules: ModuleInfo[]): DependencyEdge[] {
  const moduleSet = new Set(modules.map(m => m.path));
  const edges: DependencyEdge[] = [];

  for (const mod of modules) {
    for (const imp of mod.imports) {
      // Only create edges for modules we know about (internal deps)
      if (moduleSet.has(imp.source)) {
        edges.push({
          from: mod.path,
          to: imp.source,
          imports: imp.names,
          isTypeOnly: imp.isTypeOnly,
        });
      }
    }
  }

  return edges;
}

/**
 * Get direct dependents of a module (who imports it, 1-hop).
 */
export function getDependents(graph: DependencyEdge[], modulePath: string): string[] {
  const result = new Set<string>();
  for (const edge of graph) {
    if (edge.to === modulePath) {
      result.add(edge.from);
    }
  }
  return [...result];
}

/**
 * Get transitive dependents of a module (full reverse closure).
 * Uses BFS to find all modules that directly or indirectly depend on the target.
 */
export function getTransitiveDependents(graph: DependencyEdge[], modulePath: string): string[] {
  const visited = new Set<string>();
  const queue: string[] = [modulePath];

  // Build reverse adjacency list for efficient lookup
  const reverseAdj = new Map<string, Set<string>>();
  for (const edge of graph) {
    let deps = reverseAdj.get(edge.to);
    if (!deps) {
      deps = new Set();
      reverseAdj.set(edge.to, deps);
    }
    deps.add(edge.from);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = reverseAdj.get(current);
    if (!dependents) continue;

    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...visited];
}

/**
 * Get direct dependencies of a module (what it imports, 1-hop).
 */
export function getDependencies(graph: DependencyEdge[], modulePath: string): string[] {
  const result = new Set<string>();
  for (const edge of graph) {
    if (edge.from === modulePath) {
      result.add(edge.to);
    }
  }
  return [...result];
}
