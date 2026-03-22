import type { KGDatabase } from "../kg/storage.js";
import type { PlannedTask } from "../planner/types.js";
import type { ModuleInfo, DependencyEdge, ChangeCoupling, TestCoverageMapping } from "../kg/types.js";
import { detectIssueCycles } from "../tracker/sub-issue-dag.js";

/**
 * Swappable decomposition strategy interface.
 * v1: ModuleBoundaryStrategy. Future versions can implement alternatives.
 */
export interface DecompositionStrategy {
  name: string;
  decompose(task: PlannedTask, kg: KGDatabase): Promise<PlannedTask[]>;
}

/**
 * Result of decomposing a task into a DAG of subtasks.
 */
export interface DecompositionResult {
  subtasks: PlannedTask[];
  strategy: string;
  valid: boolean;
  error?: string;
}

/**
 * A group of files that belong to the same module boundary.
 */
interface ModuleGroup {
  name: string;
  files: string[];
  hasTests: boolean;
  testCoverage: number; // 0-1, ratio of files with mapped tests
}

// ── Helpers to load data from KG ──

function loadModules(kg: KGDatabase): ModuleInfo[] {
  const rows = kg.prepare("SELECT * FROM kg_modules").all() as Array<{
    path: string;
    exports_json: string;
    imports_json: string;
    is_test: number;
    last_modified: string | null;
    content_hash: string | null;
    tree_hash: string | null;
    compressed_content: string | null;
    token_count: number | null;
  }>;
  return rows.map(r => ({
    path: r.path,
    exports: JSON.parse(r.exports_json),
    imports: JSON.parse(r.imports_json),
    isTest: r.is_test === 1,
    lastModified: r.last_modified || undefined,
    contentHash: r.content_hash || undefined,
    treeHash: r.tree_hash || undefined,
    compressedContent: r.compressed_content || undefined,
    tokenCount: r.token_count || undefined,
  }));
}

function loadEdges(kg: KGDatabase): DependencyEdge[] {
  const rows = kg.prepare("SELECT * FROM kg_edges").all() as Array<{
    from_path: string;
    to_path: string;
    imports_json: string;
    is_type_only: number;
  }>;
  return rows.map(r => ({
    from: r.from_path,
    to: r.to_path,
    imports: JSON.parse(r.imports_json),
    isTypeOnly: r.is_type_only === 1,
  }));
}

function loadChangeCoupling(kg: KGDatabase): ChangeCoupling[] {
  const rows = kg.prepare("SELECT * FROM kg_change_coupling").all() as Array<{
    file_a: string;
    file_b: string;
    cochange_count: number;
    total_commits: number;
    coupling_score: number;
  }>;
  return rows.map(r => ({
    fileA: r.file_a,
    fileB: r.file_b,
    cochangeCount: r.cochange_count,
    totalCommits: r.total_commits,
    couplingScore: r.coupling_score,
  }));
}

function loadTestMappings(kg: KGDatabase): TestCoverageMapping[] {
  const rows = kg.prepare("SELECT source_file, test_file, confidence FROM kg_test_mappings").all() as Array<{
    source_file: string;
    test_file: string;
    confidence: string;
  }>;
  const grouped = new Map<string, { testFiles: string[]; confidence: string }>();
  for (const r of rows) {
    const existing = grouped.get(r.source_file);
    if (existing) {
      existing.testFiles.push(r.test_file);
    } else {
      grouped.set(r.source_file, { testFiles: [r.test_file], confidence: r.confidence });
    }
  }
  return Array.from(grouped.entries()).map(([sourceFile, data]) => ({
    sourceFile,
    testFiles: data.testFiles,
    confidence: data.confidence as TestCoverageMapping["confidence"],
  }));
}

// ── Module boundary detection ──

/**
 * Extract the module boundary (top-level directory under src/) from a file path.
 * e.g. "src/kg/parser.ts" -> "kg", "src/index.ts" -> "root"
 */
function getModuleBoundary(filePath: string): string {
  const parts = filePath.split("/");
  const srcIdx = parts.indexOf("src");
  if (srcIdx < 0) return "root";
  // If the file is directly under src/, it's "root"
  if (srcIdx + 2 >= parts.length) return "root";
  return parts[srcIdx + 1];
}

/**
 * Group files by their module boundary, merging highly-coupled files into the same group.
 */
function groupByModuleBoundary(
  files: string[],
  allModules: ModuleInfo[],
  couplings: ChangeCoupling[],
  testMappings: TestCoverageMapping[],
  couplingThreshold: number = 0.5,
): ModuleGroup[] {
  const moduleFiles = new Set(allModules.map(m => m.path));
  const relevantFiles = files.filter(f => moduleFiles.has(f));

  // Start with module-boundary groups
  const groups = new Map<string, Set<string>>();
  for (const file of relevantFiles) {
    const boundary = getModuleBoundary(file);
    const existing = groups.get(boundary);
    if (existing) {
      existing.add(file);
    } else {
      groups.set(boundary, new Set([file]));
    }
  }

  // Merge groups that have high change coupling between them
  const relevantSet = new Set(relevantFiles);
  const relevantCouplings = couplings.filter(
    c => relevantSet.has(c.fileA) && relevantSet.has(c.fileB) && c.couplingScore >= couplingThreshold,
  );

  for (const coupling of relevantCouplings) {
    const groupA = findGroupForFile(groups, coupling.fileA);
    const groupB = findGroupForFile(groups, coupling.fileB);
    if (groupA && groupB && groupA !== groupB) {
      // Merge groupB into groupA
      const filesB = groups.get(groupB)!;
      const filesA = groups.get(groupA)!;
      for (const f of filesB) filesA.add(f);
      groups.delete(groupB);
    }
  }

  // Build test coverage info
  const testMappingsBySource = new Map<string, string[]>();
  for (const tm of testMappings) {
    testMappingsBySource.set(tm.sourceFile, tm.testFiles);
  }

  const result: ModuleGroup[] = [];
  for (const [name, fileSet] of groups) {
    const groupFiles = [...fileSet];
    const sourceFiles = groupFiles.filter(f => !allModules.find(m => m.path === f)?.isTest);
    const filesWithTests = sourceFiles.filter(f => testMappingsBySource.has(f));
    const testCoverage = sourceFiles.length > 0 ? filesWithTests.length / sourceFiles.length : 1;

    result.push({
      name,
      files: groupFiles,
      hasTests: filesWithTests.length > 0,
      testCoverage,
    });
  }

  return result;
}

function findGroupForFile(groups: Map<string, Set<string>>, file: string): string | undefined {
  for (const [name, files] of groups) {
    if (files.has(file)) return name;
  }
  return undefined;
}

// ── Dependency ordering ──

/**
 * Compute dependency edges between module groups based on import graph.
 * Returns a map: groupName -> set of group names it depends on.
 */
function computeGroupDependencies(
  groups: ModuleGroup[],
  edges: DependencyEdge[],
): Map<string, Set<string>> {
  // Build file-to-group lookup
  const fileToGroup = new Map<string, string>();
  for (const group of groups) {
    for (const file of group.files) {
      fileToGroup.set(file, group.name);
    }
  }

  const deps = new Map<string, Set<string>>();
  for (const group of groups) {
    deps.set(group.name, new Set());
  }

  for (const edge of edges) {
    const fromGroup = fileToGroup.get(edge.from);
    const toGroup = fileToGroup.get(edge.to);
    if (fromGroup && toGroup && fromGroup !== toGroup) {
      deps.get(fromGroup)!.add(toGroup);
    }
  }

  return deps;
}

/**
 * Topologically sort groups, breaking cycles if any exist by dropping back edges.
 * Returns group names in dependency order (dependencies first).
 */
function topologicalSort(deps: Map<string, Set<string>>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(node: string): void {
    if (visited.has(node)) return;
    if (visiting.has(node)) return; // skip back edges
    visiting.add(node);
    for (const dep of deps.get(node) ?? []) {
      visit(dep);
    }
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  }

  for (const node of deps.keys()) {
    visit(node);
  }

  return result;
}

// ── v1 Strategy: Module Boundary Decomposition ──

export class ModuleBoundaryStrategy implements DecompositionStrategy {
  name = "module-boundary";

  async decompose(task: PlannedTask, kg: KGDatabase): Promise<PlannedTask[]> {
    const allModules = loadModules(kg);
    const allEdges = loadEdges(kg);
    const couplings = loadChangeCoupling(kg);
    const testMappings = loadTestMappings(kg);

    // Resolve which files are relevant to this task
    const taskFiles = resolveTaskFiles(task.spec.context.files, allModules);

    // If only one file, no decomposition needed
    if (taskFiles.length <= 1) {
      return [task];
    }

    // Group by module boundary, accounting for change coupling
    const groups = groupByModuleBoundary(taskFiles, allModules, couplings, testMappings);

    // If only one group, no decomposition needed
    if (groups.length <= 1) {
      return [task];
    }

    // Compute inter-group dependencies from import graph
    const groupDeps = computeGroupDependencies(groups, allEdges);

    // Topologically sort groups
    const sortedGroups = topologicalSort(groupDeps);

    // Build PlannedTask for each group
    const subtasks: PlannedTask[] = [];
    const groupNameToTaskId = new Map<string, string>();

    for (const groupName of sortedGroups) {
      const group = groups.find(g => g.name === groupName);
      if (!group) continue;

      const subtaskId = `${task.id}-${groupName}`;
      groupNameToTaskId.set(groupName, subtaskId);

      // Compute dependsOn from group dependencies
      const dependsOn: string[] = [];
      for (const depGroup of groupDeps.get(groupName) ?? []) {
        const depTaskId = groupNameToTaskId.get(depGroup);
        if (depTaskId) dependsOn.push(depTaskId);
      }

      // Estimate risk: low test coverage = higher risk
      const riskLevel = group.testCoverage < 0.5 ? "higher risk (low test coverage)" : "normal risk";

      const turnsEstimate = Math.max(
        1,
        Math.round(task.estimatedTurns * (group.files.length / taskFiles.length)),
      );

      subtasks.push({
        id: subtaskId,
        title: `${task.title} — ${groupName} module`,
        spec: {
          id: subtaskId,
          title: `${task.title} — ${groupName} module`,
          description: task.spec.description
            ? `${task.spec.description}\n\nScoped to ${groupName} module: ${group.files.join(", ")}`
            : `Scoped to ${groupName} module: ${group.files.join(", ")}`,
          context: {
            files: group.files,
            docs: task.spec.context.docs,
            modules: [groupName],
            related_tasks: [task.id],
          },
          constraints: task.spec.constraints,
          acceptance: task.spec.acceptance,
          decomposition: { strategy: "forbidden" },
          effort: {
            max_turns: turnsEstimate,
            max_review_rounds: task.spec.effort.max_review_rounds,
            timeout: task.spec.effort.timeout,
          },
          metadata: task.spec.metadata,
        },
        dependsOn,
        estimatedTurns: turnsEstimate,
        riskNotes: `${riskLevel}; ${group.files.length} file(s) in ${groupName} module`,
      });
    }

    return subtasks;
  }
}

/**
 * Resolve task file globs against known KG modules.
 * For glob patterns, match against all module paths. For literal paths, include directly.
 */
function resolveTaskFiles(filePatterns: string[], allModules: ModuleInfo[]): string[] {
  const result = new Set<string>();
  const allPaths = allModules.map(m => m.path);

  for (const pattern of filePatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      // Simple glob matching: convert glob to regex
      const regex = globToRegex(pattern);
      for (const p of allPaths) {
        if (regex.test(p)) result.add(p);
      }
    } else {
      // Literal path or directory prefix
      if (allPaths.includes(pattern)) {
        result.add(pattern);
      } else {
        // Treat as directory prefix
        const prefix = pattern.endsWith("/") ? pattern : pattern + "/";
        for (const p of allPaths) {
          if (p.startsWith(prefix)) result.add(p);
        }
      }
    }
  }

  return [...result];
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports * and ** patterns.
 */
function globToRegex(pattern: string): RegExp {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars (not * or ?)
    .replace(/\*\*/g, "{{GLOBSTAR}}") // placeholder for **
    .replace(/\*/g, "[^/]*") // * matches anything except /
    .replace(/\?/g, "[^/]") // ? matches single char
    .replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** matches everything
  return new RegExp(`^${regex}$`);
}

// ── Decomposition Engine ──

/**
 * Decompose a PlannedTask into a DAG of subtasks using the given strategy.
 * Validates the result is an acyclic DAG using existing cycle detection.
 */
export async function decompose(
  task: PlannedTask,
  kg: KGDatabase,
  strategy?: DecompositionStrategy,
): Promise<DecompositionResult> {
  const strat = strategy ?? new ModuleBoundaryStrategy();

  const subtasks = await strat.decompose(task, kg);

  // Validate acyclicity using existing sub-issue-dag cycle detection
  const dagNodes = subtasks.map(t => ({
    id: t.id,
    blocked_by: t.dependsOn,
  }));
  const cycleError = detectIssueCycles(dagNodes);

  if (cycleError) {
    return {
      subtasks,
      strategy: strat.name,
      valid: false,
      error: cycleError,
    };
  }

  // Validate all dependsOn references exist
  const taskIds = new Set(subtasks.map(t => t.id));
  for (const subtask of subtasks) {
    for (const dep of subtask.dependsOn) {
      if (!taskIds.has(dep)) {
        return {
          subtasks,
          strategy: strat.name,
          valid: false,
          error: `Subtask "${subtask.id}" depends on unknown task "${dep}"`,
        };
      }
    }
  }

  return {
    subtasks,
    strategy: strat.name,
    valid: true,
  };
}
