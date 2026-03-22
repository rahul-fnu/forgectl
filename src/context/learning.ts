import type { KGDatabase } from "../kg/storage.js";
import { getAllOutcomeFiles, type OutcomeFileRecord } from "../kg/storage.js";

/**
 * A relevance boost derived from outcome history.
 * Positive boost means the file is historically important for this task type.
 * Negative boost means the file has been associated with failures.
 */
export interface LearningBoost {
  filePath: string;
  boost: number; // -0.3 to +0.3
  reason: string;
}

/**
 * Agentic search hint: suggests files/areas the agent should explore
 * beyond what the Merkle-cached context provides.
 */
export interface AgenticSearchHint {
  pattern: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

/**
 * Result of the learning loop analysis.
 */
export interface LearningResult {
  boosts: LearningBoost[];
  searchHints: AgenticSearchHint[];
  taskTypeStats: {
    totalRuns: number;
    successRate: number;
    avgTurns: number;
  };
}

const MAX_BOOST = 0.3;
const MIN_BOOST = -0.3;
const MIN_OBSERVATIONS = 2;

/**
 * Compute learning-based relevance boosts from outcome history.
 *
 * The learning loop:
 * 1. Query outcome history for the given task type
 * 2. Compute success-weighted file relevance (files in successful runs get boosted)
 * 3. Identify files associated with failures (demoted or flagged for extra attention)
 * 4. Generate agentic search hints for under-explored areas
 */
export function computeLearningBoosts(
  kgDb: KGDatabase,
  taskType: string,
  referencedFiles: Set<string>,
): LearningResult {
  const allRecords = getAllOutcomeFiles(kgDb, taskType);

  if (allRecords.length === 0) {
    return {
      boosts: [],
      searchHints: [],
      taskTypeStats: { totalRuns: 0, successRate: 0, avgTurns: 0 },
    };
  }

  // Compute aggregate stats
  const totalRuns = allRecords.reduce((sum, r) => sum + r.successCount + r.failureCount, 0);
  const totalSuccesses = allRecords.reduce((sum, r) => sum + r.successCount, 0);
  const successRate = totalRuns > 0 ? totalSuccesses / totalRuns : 0;
  const avgTurns = totalRuns > 0
    ? allRecords.reduce((sum, r) => sum + r.totalTurns, 0) / totalRuns
    : 0;

  const boosts: LearningBoost[] = [];
  const fileRecordMap = new Map<string, OutcomeFileRecord>();
  for (const record of allRecords) {
    fileRecordMap.set(record.filePath, record);
  }

  for (const record of allRecords) {
    const total = record.successCount + record.failureCount;
    if (total < MIN_OBSERVATIONS) continue;

    const fileSuccessRate = record.successCount / total;
    const isReferenced = referencedFiles.has(record.filePath);

    if (fileSuccessRate >= 0.7) {
      // File appears in mostly successful runs — boost if not already referenced
      if (!isReferenced) {
        const boost = Math.min(MAX_BOOST, (fileSuccessRate - 0.5) * 0.6);
        boosts.push({
          filePath: record.filePath,
          boost,
          reason: `historically important for ${taskType} (${record.successCount}/${total} successful runs)`,
        });
      }
    } else if (fileSuccessRate <= 0.3 && total >= 3) {
      // File associated with failures — flag for extra attention
      boosts.push({
        filePath: record.filePath,
        boost: Math.max(MIN_BOOST, -(0.5 - fileSuccessRate) * 0.6),
        reason: `historically problematic for ${taskType} (${record.failureCount}/${total} failed runs, avg ${record.avgRetries.toFixed(1)} retries)`,
      });
    }
  }

  // Generate search hints
  const searchHints = generateSearchHints(allRecords, referencedFiles, taskType);

  return {
    boosts,
    searchHints,
    taskTypeStats: {
      totalRuns,
      successRate: Math.round(successRate * 10000) / 10000,
      avgTurns: Math.round(avgTurns * 100) / 100,
    },
  };
}

/**
 * Generate hints for the agent about areas to explore beyond cached context.
 */
function generateSearchHints(
  records: OutcomeFileRecord[],
  referencedFiles: Set<string>,
  taskType: string,
): AgenticSearchHint[] {
  const hints: AgenticSearchHint[] = [];

  // Find modules frequently touched in successful runs that aren't in current context
  const moduleSuccess = new Map<string, { successes: number; total: number }>();
  for (const record of records) {
    const module = extractModule(record.filePath);
    const stats = moduleSuccess.get(module) ?? { successes: 0, total: 0 };
    stats.successes += record.successCount;
    stats.total += record.successCount + record.failureCount;
    moduleSuccess.set(module, stats);
  }

  const referencedModules = new Set<string>();
  for (const f of referencedFiles) {
    referencedModules.add(extractModule(f));
  }

  for (const [module, stats] of moduleSuccess) {
    if (referencedModules.has(module)) continue;
    if (stats.total < MIN_OBSERVATIONS) continue;

    const successRate = stats.successes / stats.total;
    if (successRate >= 0.6 && stats.total >= 3) {
      hints.push({
        pattern: `${module}/**/*.ts`,
        reason: `${module} is frequently involved in successful ${taskType} runs (${stats.successes}/${stats.total})`,
        priority: successRate >= 0.8 ? "high" : "medium",
      });
    }
  }

  // Find high-failure modules that need attention
  for (const [module, stats] of moduleSuccess) {
    if (stats.total < 3) continue;
    const failRate = 1 - stats.successes / stats.total;
    if (failRate >= 0.5) {
      hints.push({
        pattern: `${module}/**/*.ts`,
        reason: `${module} has high failure rate for ${taskType} (${Math.round(failRate * 100)}%) — review carefully`,
        priority: "high",
      });
    }
  }

  return hints;
}

function extractModule(filePath: string): string {
  const parts = filePath.split("/");
  const srcIdx = parts.indexOf("src");
  if (srcIdx < 0) return parts.slice(0, 2).join("/");
  if (srcIdx + 2 >= parts.length) return "src";
  return `src/${parts[srcIdx + 1]}`;
}
