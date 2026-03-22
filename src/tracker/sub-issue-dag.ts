/**
 * Issue-specific cycle detection adapter.
 *
 * Uses a standalone DFS 3-color algorithm (WHITE/GRAY/BLACK) that:
 * - Only checks for cycles (no duplicate ID, unknown ref, or root node checks)
 * - Operates on IssueDAGNode[] directly
 * - Silently ignores blocked_by references to IDs not present in the input set
 *   (cross-repo / external issue references are expected and valid)
 * - Returns a human-readable cycle description string, or null if no cycle found
 *
 * NOTE: We do NOT use validateDAG() from pipeline/dag.ts because:
 * 1. PipelineDefinition requires name/task fields that are meaningless for issue nodes.
 * 2. validateDAG() errors on unknown node references, but issue DAGs legitimately
 *    reference cross-repo issues that aren't in the local set.
 */

export interface IssueDAGNode {
  /** Issue identifier (e.g. "42" or "external-org/repo#99") */
  id: string;
  /** IDs of issues that this issue is blocked by */
  blocked_by: string[];
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * Detect cycles in an issue dependency graph.
 * Returns a descriptive string if a cycle is found, or null if the graph is acyclic.
 *
 * @param issues - Array of issue nodes to check
 */
export function detectIssueCycles(issues: IssueDAGNode[]): string | null {
  if (issues.length === 0) return null;

  // Build set of known IDs for fast lookup (to ignore external refs)
  const knownIds = new Set<string>(issues.map(i => i.id));

  // Build adjacency map: node -> deps (filtered to known IDs only)
  const adj = new Map<string, string[]>();
  for (const issue of issues) {
    const localDeps = issue.blocked_by.filter(dep => knownIds.has(dep));
    adj.set(issue.id, localDeps);
  }

  // 3-color DFS state
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const issue of issues) {
    color.set(issue.id, WHITE);
  }

  for (const issue of issues) {
    if (color.get(issue.id) === WHITE) {
      const cycleError = dfs(issue.id, adj, color, parent);
      if (cycleError) return cycleError;
    }
  }

  return null;
}

function dfs(
  nodeId: string,
  adj: Map<string, string[]>,
  color: Map<string, number>,
  parent: Map<string, string>,
): string | null {
  color.set(nodeId, GRAY);

  for (const neighbor of adj.get(nodeId) ?? []) {
    if (color.get(neighbor) === GRAY) {
      // Found a back edge — reconstruct cycle path
      const cycle = [neighbor, nodeId];
      let cur = nodeId;
      while (cur !== neighbor && parent.has(cur)) {
        cur = parent.get(cur)!;
        if (cur !== neighbor) cycle.push(cur);
      }
      return `Cycle detected: ${cycle.reverse().join(" -> ")} -> ${neighbor}`;
    }
    if (color.get(neighbor) === WHITE) {
      parent.set(neighbor, nodeId);
      const result = dfs(neighbor, adj, color, parent);
      if (result) return result;
    }
  }

  color.set(nodeId, BLACK);
  return null;
}

/**
 * Compute how many downstream issues each issue transitively unblocks.
 *
 * Given a set of issues with blocked_by edges, this builds a reverse adjacency
 * (blocker -> dependents) and counts transitive descendants for each node.
 * Higher scores mean the issue is on the critical path — completing it
 * unblocks more downstream work.
 *
 * External refs (IDs not in the input set) are silently ignored.
 * Returns a Map from issue ID to downstream count (0 = leaf, nothing depends on it).
 */
export function computeCriticalPath(issues: IssueDAGNode[]): Map<string, number> {
  if (issues.length === 0) return new Map();

  const knownIds = new Set<string>(issues.map(i => i.id));

  // Build reverse adjacency: blocker -> list of issues it unblocks
  const reverseAdj = new Map<string, string[]>();
  for (const id of knownIds) {
    reverseAdj.set(id, []);
  }
  for (const issue of issues) {
    for (const dep of issue.blocked_by) {
      if (knownIds.has(dep)) {
        reverseAdj.get(dep)!.push(issue.id);
      }
    }
  }

  // Memoized DFS to count transitive descendants
  const memo = new Map<string, number>();

  function countDescendants(nodeId: string, visiting: Set<string>): number {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    if (visiting.has(nodeId)) return 0; // cycle guard

    visiting.add(nodeId);
    const reachable = new Set<string>();
    const stack = [...(reverseAdj.get(nodeId) ?? [])];

    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (reachable.has(cur) || cur === nodeId) continue;
      reachable.add(cur);
      for (const next of reverseAdj.get(cur) ?? []) {
        if (!reachable.has(next)) {
          stack.push(next);
        }
      }
    }

    visiting.delete(nodeId);
    const count = reachable.size;
    memo.set(nodeId, count);
    return count;
  }

  const result = new Map<string, number>();
  for (const id of knownIds) {
    result.set(id, countDescendants(id, new Set()));
  }
  return result;
}
