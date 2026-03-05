import type { PipelineDefinition } from "./types.js";

export interface DAGValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate the pipeline DAG structure */
export function validateDAG(pipeline: PipelineDefinition): DAGValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  // 1. Check for duplicate node IDs
  for (const node of pipeline.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node ID: "${node.id}"`);
    }
    nodeIds.add(node.id);
  }

  // 2. Check all depends_on references point to existing nodes
  for (const node of pipeline.nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!nodeIds.has(dep)) {
        errors.push(`Node "${node.id}" depends on unknown node "${dep}"`);
      }
    }
  }

  // 3. Check for cycles using DFS
  if (errors.length === 0) {
    const cycleError = detectCycle(pipeline);
    if (cycleError) {
      errors.push(cycleError);
    }
  }

  // 4. Check at least one root node exists
  const hasRoot = pipeline.nodes.some(n => !n.depends_on || n.depends_on.length === 0);
  if (!hasRoot) {
    errors.push("Pipeline has no root node (all nodes have dependencies)");
  }

  return { valid: errors.length === 0, errors };
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** Detect cycles using DFS. Returns error message or null. */
function detectCycle(pipeline: PipelineDefinition): string | null {
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  // Build adjacency map
  const adj = new Map<string, string[]>();
  for (const node of pipeline.nodes) {
    adj.set(node.id, []);
    color.set(node.id, WHITE);
  }
  for (const node of pipeline.nodes) {
    for (const dep of node.depends_on ?? []) {
      // Edge goes FROM dependency TO dependent (dep -> node.id)
      // But for cycle detection in a DAG, we track: node depends on dep
      // So we traverse: node -> dep (upstream direction)
      adj.get(node.id)?.push(dep);
    }
  }

  for (const node of pipeline.nodes) {
    if (color.get(node.id) === WHITE) {
      const cycle = dfs(node.id, adj, color, parent);
      if (cycle) return cycle;
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
      // Found a cycle — reconstruct path
      const cycle = [neighbor, nodeId];
      let cur = nodeId;
      while (cur !== neighbor && parent.has(cur)) {
        cur = parent.get(cur)!;
        if (cur !== neighbor) cycle.push(cur);
      }
      return `Cycle detected: ${cycle.reverse().join(" → ")} → ${neighbor}`;
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

/** Topological sort using Kahn's algorithm. Returns node IDs in execution order. */
export function topologicalSort(pipeline: PipelineDefinition): string[] {
  // Build in-degree map (how many deps each node has)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> nodes that depend on it

  for (const node of pipeline.nodes) {
    inDegree.set(node.id, (node.depends_on ?? []).length);
    if (!dependents.has(node.id)) {
      dependents.set(node.id, []);
    }
    for (const dep of node.depends_on ?? []) {
      if (!dependents.has(dep)) {
        dependents.set(dep, []);
      }
      dependents.get(dep)!.push(node.id);
    }
  }

  // Start with root nodes (in-degree 0)
  const queue: string[] = [];
  for (const node of pipeline.nodes) {
    if (inDegree.get(node.id) === 0) {
      queue.push(node.id);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    result.push(nodeId);

    for (const dep of dependents.get(nodeId) ?? []) {
      const newDegree = inDegree.get(dep)! - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        queue.push(dep);
      }
    }
  }

  return result;
}

/** Group nodes by parallel execution level. Nodes in the same group can run simultaneously. */
export function getParallelGroups(pipeline: PipelineDefinition): string[][] {
  const nodeMap = new Map(pipeline.nodes.map(n => [n.id, n]));
  const depth = new Map<string, number>();

  function getDepth(nodeId: string): number {
    if (depth.has(nodeId)) return depth.get(nodeId)!;
    const node = nodeMap.get(nodeId)!;
    const deps = node.depends_on ?? [];
    if (deps.length === 0) {
      depth.set(nodeId, 0);
      return 0;
    }
    const maxDepDep = Math.max(...deps.map(d => getDepth(d)));
    const d = maxDepDep + 1;
    depth.set(nodeId, d);
    return d;
  }

  for (const node of pipeline.nodes) {
    getDepth(node.id);
  }

  // Group by depth
  const groups = new Map<number, string[]>();
  for (const node of pipeline.nodes) {
    const d = depth.get(node.id)!;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(node.id);
  }

  const maxDepth = Math.max(...groups.keys());
  const result: string[][] = [];
  for (let i = 0; i <= maxDepth; i++) {
    result.push(groups.get(i) ?? []);
  }
  return result;
}

function buildDependencyMap(pipeline: PipelineDefinition): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const node of pipeline.nodes) {
    deps.set(node.id, [...(node.depends_on ?? [])]);
  }
  return deps;
}

function buildDependentsMap(pipeline: PipelineDefinition): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const node of pipeline.nodes) {
    if (!dependents.has(node.id)) dependents.set(node.id, []);
  }
  for (const node of pipeline.nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(node.id);
    }
  }
  return dependents;
}

/** Collect all transitive ancestors of a node. */
export function collectAncestors(pipeline: PipelineDefinition, nodeId: string): Set<string> {
  const deps = buildDependencyMap(pipeline);
  const ancestors = new Set<string>();
  const stack = [...(deps.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    for (const parent of deps.get(current) ?? []) {
      if (!ancestors.has(parent)) stack.push(parent);
    }
  }

  return ancestors;
}

/** Collect all transitive descendants of a node. */
export function collectDescendants(pipeline: PipelineDefinition, nodeId: string): Set<string> {
  const dependents = buildDependentsMap(pipeline);
  const descendants = new Set<string>();
  const stack = [...(dependents.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (descendants.has(current)) continue;
    descendants.add(current);
    for (const child of dependents.get(current) ?? []) {
      if (!descendants.has(child)) stack.push(child);
    }
  }

  return descendants;
}

/** Return true when `ancestorId` is a transitive ancestor of `nodeId`. */
export function isAncestor(
  pipeline: PipelineDefinition,
  ancestorId: string,
  nodeId: string,
): boolean {
  return collectAncestors(pipeline, nodeId).has(ancestorId);
}
