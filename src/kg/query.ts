import type { KGDatabase } from "./storage.js";
import type { ModuleQueryResult } from "./types.js";
import {
  getModule,
  getDependents as getDbDependents,
  getTestsFor,
  getCoupledFiles,
} from "./storage.js";

/**
 * Query comprehensive information about a module from the knowledge graph.
 */
export function queryModule(db: KGDatabase, modulePath: string): ModuleQueryResult | undefined {
  const mod = getModule(db, modulePath);
  if (!mod) return undefined;

  // Direct dependents (who imports this module)
  const dependentEdges = getDbDependents(db, modulePath);
  const dependents = [...new Set(dependentEdges.map(e => e.from))];

  // Direct dependencies (what this module imports)
  const depRows = db.prepare("SELECT DISTINCT to_path FROM kg_edges WHERE from_path = ?")
    .all(modulePath) as Array<{ to_path: string }>;
  const dependencies = depRows.map(r => r.to_path);

  // Transitive dependents (full reverse closure via BFS)
  const transitiveDependents = computeTransitiveDependents(db, modulePath);

  // Test coverage
  const testCoverage = getTestsFor(db, modulePath);

  // Change coupling
  const changeCoupling = getCoupledFiles(db, modulePath);

  return {
    module: mod,
    dependents,
    dependencies,
    transitiveDependents,
    testCoverage,
    changeCoupling,
  };
}

/**
 * Compute transitive dependents using BFS on the stored edge graph.
 */
function computeTransitiveDependents(db: KGDatabase, modulePath: string): string[] {
  const visited = new Set<string>();
  const queue: string[] = [modulePath];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges = db.prepare("SELECT DISTINCT from_path FROM kg_edges WHERE to_path = ?")
      .all(current) as Array<{ from_path: string }>;

    for (const row of edges) {
      if (!visited.has(row.from_path)) {
        visited.add(row.from_path);
        queue.push(row.from_path);
      }
    }
  }

  return [...visited];
}
