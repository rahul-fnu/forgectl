import { createHash } from "node:crypto";
import type { TaskSpec } from "../task/types.js";
import type { KGDatabase } from "../kg/storage.js";
import { getModule, getMeta, getCoupledFiles, getTestsFor } from "../kg/storage.js";
import { estimateTokenCount } from "../kg/merkle.js";
import type { ModuleInfo } from "../kg/types.js";
import { computeLearningBoosts, applyDiscoveryMissBoosts, type LearningResult, type AgenticSearchHint } from "./learning.js";

export interface ContextResult {
  systemContext: string;
  taskContext: string;
  budget: { used: number; max: number; reservedForAgent: number };
  merkleRoot: string;
  includedFiles: Array<{ path: string; tier: "full" | "exports" | "name"; tokens: number }>;
  learningInsights?: LearningInsights;
}

export interface LearningInsights {
  searchHints: AgenticSearchHint[];
  taskTypeStats: LearningResult["taskTypeStats"];
  boostedFiles: number;
}

interface ScoredFile {
  path: string;
  score: number;
  module: ModuleInfo;
}

const DEFAULT_BUDGET = 60000;
const AGENT_RESERVE_RATIO = 0.5;

/**
 * Build budget-aware hybrid context from the KG for a given task.
 *
 * Algorithm:
 * 1. Parse task spec: extract referenced files, modules, constraints
 * 2. Query KG: imports, tests, change coupling
 * 3. Score relevance: direct (1.0) > imported (0.7) > coupled (0.5) > transitive (0.3)
 * 4. Assemble with compression tiers within budget
 * 5. Cache result keyed by task_hash + root_tree_hash
 */
export async function buildContext(
  task: TaskSpec,
  kgDb: KGDatabase,
  budget?: number,
  taskType?: string,
): Promise<ContextResult> {
  const totalBudget = budget ?? DEFAULT_BUDGET;
  const reservedForAgent = Math.floor(totalBudget * AGENT_RESERVE_RATIO);
  const preBuildBudget = totalBudget - reservedForAgent;

  const merkleRoot = getMeta(kgDb, "root_hash") ?? "";

  // Check cache
  const taskHash = computeTaskHash(task);
  const cacheKey = `context_cache_${taskHash}_${merkleRoot}`;
  const cached = getMeta(kgDb, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ContextResult;
    } catch {
      // corrupted cache, rebuild
    }
  }

  // 1. Extract referenced files and modules from task spec
  const referencedFiles = new Set<string>([
    ...task.context.files,
    ...(task.context.modules ?? []),
  ]);

  // Also extract file references from description and constraints
  const textToScan = [
    task.title,
    task.description ?? "",
    ...task.constraints,
    ...task.acceptance.map(a => a.description ?? ""),
  ].join("\n");

  const fileRefPattern = /(?:src|test|lib)\/[\w/.=-]+\.(?:ts|js|tsx|jsx)/g;
  for (const match of textToScan.matchAll(fileRefPattern)) {
    referencedFiles.add(match[0]);
  }

  // 2. Query KG for related files
  const scored = new Map<string, ScoredFile>();

  // Direct references get score 1.0
  for (const filePath of referencedFiles) {
    const mod = getModule(kgDb, filePath);
    if (mod) {
      scored.set(filePath, { path: filePath, score: 1.0, module: mod });
    }
  }

  // Expand: imports (1-hop dependencies and dependents) get 0.7
  for (const filePath of referencedFiles) {
    const deps = kgDb.prepare("SELECT DISTINCT to_path FROM kg_edges WHERE from_path = ?")
      .all(filePath) as Array<{ to_path: string }>;
    const dependents = kgDb.prepare("SELECT DISTINCT from_path FROM kg_edges WHERE to_path = ?")
      .all(filePath) as Array<{ from_path: string }>;

    for (const row of deps) {
      if (!scored.has(row.to_path)) {
        const mod = getModule(kgDb, row.to_path);
        if (mod) {
          scored.set(row.to_path, { path: row.to_path, score: 0.7, module: mod });
        }
      }
    }
    for (const row of dependents) {
      if (!scored.has(row.from_path)) {
        const mod = getModule(kgDb, row.from_path);
        if (mod) {
          scored.set(row.from_path, { path: row.from_path, score: 0.7, module: mod });
        }
      }
    }
  }

  // Change coupling gets 0.5
  for (const filePath of referencedFiles) {
    const coupled = getCoupledFiles(kgDb, filePath);
    for (const c of coupled) {
      const otherPath = c.fileA === filePath ? c.fileB : c.fileA;
      if (!scored.has(otherPath)) {
        const mod = getModule(kgDb, otherPath);
        if (mod) {
          scored.set(otherPath, { path: otherPath, score: 0.5 * c.couplingScore, module: mod });
        }
      }
    }
  }

  // Test coverage files for referenced sources
  for (const filePath of referencedFiles) {
    const tests = getTestsFor(kgDb, filePath);
    for (const mapping of tests) {
      for (const testFile of mapping.testFiles) {
        if (!scored.has(testFile)) {
          const mod = getModule(kgDb, testFile);
          if (mod) {
            scored.set(testFile, { path: testFile, score: 0.5, module: mod });
          }
        }
      }
    }
  }

  // Transitive (2-hop) get 0.3: expand both deps and dependents from 1-hop nodes
  const firstHopPaths = [...scored.entries()]
    .filter(([, s]) => s.score === 0.7)
    .map(([p]) => p);

  for (const filePath of firstHopPaths) {
    const deps = kgDb.prepare("SELECT DISTINCT to_path FROM kg_edges WHERE from_path = ?")
      .all(filePath) as Array<{ to_path: string }>;
    const dependents = kgDb.prepare("SELECT DISTINCT from_path FROM kg_edges WHERE to_path = ?")
      .all(filePath) as Array<{ from_path: string }>;

    for (const row of deps) {
      if (!scored.has(row.to_path)) {
        const mod = getModule(kgDb, row.to_path);
        if (mod) {
          scored.set(row.to_path, { path: row.to_path, score: 0.3, module: mod });
        }
      }
    }
    for (const row of dependents) {
      if (!scored.has(row.from_path)) {
        const mod = getModule(kgDb, row.from_path);
        if (mod) {
          scored.set(row.from_path, { path: row.from_path, score: 0.3, module: mod });
        }
      }
    }
  }

  // 2b. Apply learning boosts from outcome history
  let learningInsights: LearningInsights | undefined;
  const effectiveTaskType = taskType ?? inferTaskType(task);

  if (effectiveTaskType) {
    try {
      const learningResult = computeLearningBoosts(kgDb, effectiveTaskType, referencedFiles);

      if (learningResult.boosts.length > 0 || learningResult.searchHints.length > 0) {
        let boostedCount = 0;

        for (const boost of learningResult.boosts) {
          const existing = scored.get(boost.filePath);
          if (existing) {
            existing.score = Math.max(0, Math.min(1.0, existing.score + boost.boost));
            boostedCount++;
          } else if (boost.boost > 0) {
            const mod = getModule(kgDb, boost.filePath);
            if (mod) {
              scored.set(boost.filePath, {
                path: boost.filePath,
                score: Math.min(0.6, 0.3 + boost.boost),
                module: mod,
              });
              boostedCount++;
            }
          }
        }

        learningInsights = {
          searchHints: learningResult.searchHints,
          taskTypeStats: learningResult.taskTypeStats,
          boostedFiles: boostedCount,
        };
      }

      // Apply discovery miss boosts (files agents frequently accessed but weren't pre-provided)
      const discoveryBoosted = applyDiscoveryMissBoosts(
        kgDb,
        effectiveTaskType,
        scored as Map<string, { path: string; score: number }>,
        (p: string) => getModule(kgDb, p),
      );
      if (discoveryBoosted > 0) {
        if (!learningInsights) {
          learningInsights = {
            searchHints: [],
            taskTypeStats: { totalRuns: 0, successRate: 0, avgTurns: 0 },
            boostedFiles: discoveryBoosted,
          };
        } else {
          learningInsights.boostedFiles += discoveryBoosted;
        }
      }
    } catch {
      // Learning is best-effort
    }
  }

  // 3. Sort by score descending
  const sortedFiles = [...scored.values()].sort((a, b) => b.score - a.score);

  // 4. Assemble within budget using compression tiers
  const includedFiles: ContextResult["includedFiles"] = [];
  const contextParts: string[] = [];
  let tokensUsed = 0;

  for (const entry of sortedFiles) {
    if (tokensUsed >= preBuildBudget) break;

    const tier = selectTier(entry.score);
    const content = renderTier(entry, tier);
    const tokens = estimateTokenCount(content);

    if (tokensUsed + tokens > preBuildBudget) {
      // Try a cheaper tier
      const fallbackTier = demoteTier(tier);
      if (fallbackTier !== tier) {
        const fallbackContent = renderTier(entry, fallbackTier);
        const fallbackTokens = estimateTokenCount(fallbackContent);
        if (tokensUsed + fallbackTokens <= preBuildBudget) {
          contextParts.push(fallbackContent);
          tokensUsed += fallbackTokens;
          includedFiles.push({ path: entry.path, tier: fallbackTier, tokens: fallbackTokens });
          continue;
        }
      }
      // Can't fit even demoted, try name-only
      if (tier !== "name") {
        const nameContent = renderTier(entry, "name");
        const nameTokens = estimateTokenCount(nameContent);
        if (tokensUsed + nameTokens <= preBuildBudget) {
          contextParts.push(nameContent);
          tokensUsed += nameTokens;
          includedFiles.push({ path: entry.path, tier: "name", tokens: nameTokens });
        }
      }
      continue;
    }

    contextParts.push(content);
    tokensUsed += tokens;
    includedFiles.push({ path: entry.path, tier, tokens });
  }

  // Build system context header
  const systemLines = [
    "# Codebase Context (auto-generated from Knowledge Graph)",
    `Merkle root: ${merkleRoot}`,
    `Files included: ${includedFiles.length}`,
    `Token budget: ${tokensUsed}/${preBuildBudget} (${reservedForAgent} reserved for agent exploration)`,
  ];

  if (learningInsights) {
    const stats = learningInsights.taskTypeStats;
    if (stats.totalRuns > 0) {
      systemLines.push(`Learning: ${stats.totalRuns} prior runs, ${(stats.successRate * 100).toFixed(0)}% success rate, avg ${stats.avgTurns} turns`);
    }
    if (learningInsights.boostedFiles > 0) {
      systemLines.push(`Outcome-boosted files: ${learningInsights.boostedFiles}`);
    }
  }

  systemLines.push("");
  const systemContext = systemLines.join("\n");

  // Append agentic search hints if available
  const searchHintParts: string[] = [];
  if (learningInsights?.searchHints.length) {
    searchHintParts.push("\n## Agentic Search Hints");
    searchHintParts.push("Based on outcome history, consider exploring these areas:");
    for (const hint of learningInsights.searchHints) {
      searchHintParts.push(`- [${hint.priority}] ${hint.pattern}: ${hint.reason}`);
    }
  }

  const taskContext = contextParts.join("\n\n") + (searchHintParts.length > 0 ? "\n" + searchHintParts.join("\n") : "");

  const result: ContextResult = {
    systemContext,
    taskContext,
    budget: { used: tokensUsed, max: totalBudget, reservedForAgent },
    merkleRoot,
    includedFiles,
    learningInsights,
  };

  // Cache result
  if (merkleRoot) {
    try {
      const serialized = JSON.stringify(result);
      kgDb.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(cacheKey, serialized);
    } catch {
      // caching is best-effort
    }
  }

  return result;
}

function computeTaskHash(task: TaskSpec): string {
  const key = JSON.stringify({
    id: task.id,
    files: task.context.files,
    modules: task.context.modules,
    constraints: task.constraints,
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function selectTier(score: number): "full" | "exports" | "name" {
  if (score >= 0.7) return "full";
  if (score >= 0.4) return "exports";
  return "name";
}

function demoteTier(tier: "full" | "exports" | "name"): "full" | "exports" | "name" {
  if (tier === "full") return "exports";
  if (tier === "exports") return "name";
  return "name";
}

function renderTier(entry: ScoredFile, tier: "full" | "exports" | "name"): string {
  const mod = entry.module;
  const header = `## ${mod.path} (relevance: ${entry.score.toFixed(1)})`;

  if (tier === "full") {
    if (mod.compressedContent) {
      return `${header}\n${mod.compressedContent}`;
    }
    // Fallback: render exports and imports
    return renderExportsTier(header, mod);
  }

  if (tier === "exports") {
    return renderExportsTier(header, mod);
  }

  // name tier
  const role = mod.isTest ? "test" : "source";
  return `${header}\nRole: ${role}`;
}

function renderExportsTier(header: string, mod: ModuleInfo): string {
  const exports = mod.exports.map(e => `  export ${e.kind} ${e.name}`).join("\n");
  return exports ? `${header}\n${exports}` : header;
}

/**
 * Infer task type from task spec for learning loop lookups.
 * Uses the task ID prefix, metadata, or falls back to context-based heuristics.
 */
function inferTaskType(task: TaskSpec): string | undefined {
  if (task.metadata?.taskType) return task.metadata.taskType;

  const id = task.id.toLowerCase();
  if (id.startsWith("fix") || id.includes("bug")) return "bugfix";
  if (id.startsWith("feat") || id.includes("feature")) return "feature";
  if (id.startsWith("refactor")) return "refactor";
  if (id.startsWith("test")) return "test";

  const desc = (task.description ?? task.title).toLowerCase();
  if (desc.includes("fix") || desc.includes("bug")) return "bugfix";
  if (desc.includes("add") || desc.includes("implement") || desc.includes("feature")) return "feature";
  if (desc.includes("refactor") || desc.includes("clean")) return "refactor";
  if (desc.includes("test")) return "test";

  return undefined;
}
