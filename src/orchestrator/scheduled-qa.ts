import { existsSync } from "node:fs";
import type { ForgectlConfig } from "../config/schema.js";
import type { TrackerAdapter, TrackerIssue } from "../tracker/types.js";
import type { Logger } from "../logging/logger.js";
import { triageIssue } from "./triage.js";
import type { OrchestratorState } from "./state.js";

/**
 * Scheduled QA: periodically scans the KG for test coverage gaps
 * and dispatches issues to fill them. Goes through the triage gate
 * before dispatching.
 */
export interface ScheduledQADeps {
  config: ForgectlConfig;
  tracker: TrackerAdapter;
  state: OrchestratorState;
  logger: Logger;
  kgDbPath?: string;
  dispatchIssue: (issue: TrackerIssue) => void | Promise<void>;
}

/**
 * Run a single Scheduled QA tick: scan for coverage gaps, create issues,
 * and dispatch them through the triage gate.
 */
export async function scheduledQATick(deps: ScheduledQADeps): Promise<{ created: number; dispatched: number }> {
  const { config, tracker, state, logger } = deps;
  const qaConfig = config.scheduled_qa;
  if (!qaConfig?.enabled) {
    return { created: 0, dispatched: 0 };
  }

  const kgPath = deps.kgDbPath ?? resolveDefaultKgPath(config);
  if (!existsSync(kgPath)) {
    logger.warn("scheduled-qa", `KG database not found at ${kgPath}, skipping`);
    return { created: 0, dispatched: 0 };
  }

  let gaps: string[];
  try {
    gaps = await scanCoverageGaps(kgPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("scheduled-qa", `Failed to scan coverage gaps: ${msg}`);
    return { created: 0, dispatched: 0 };
  }

  if (gaps.length === 0) {
    logger.info("scheduled-qa", "No coverage gaps found");
    return { created: 0, dispatched: 0 };
  }

  const maxIssues = qaConfig.max_issues_per_run ?? 5;
  const labels = qaConfig.labels ?? ["scheduled-qa"];
  const batch = gaps.slice(0, maxIssues);

  logger.info("scheduled-qa", `Found ${gaps.length} coverage gaps, creating up to ${batch.length} issues`);

  let created = 0;
  let dispatched = 0;

  for (const file of batch) {
    const title = `Add tests for uncovered file: ${file}`;
    const description = `The file \`${file}\` was identified by Scheduled QA as lacking test coverage in the Knowledge Graph test mappings.\n\nPlease add appropriate unit or integration tests.`;

    const now = new Date().toISOString();
    const syntheticId = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const issue: TrackerIssue = {
      id: syntheticId,
      identifier: syntheticId,
      title,
      description,
      state: "open",
      priority: null,
      labels: [...labels],
      assignees: [],
      url: "",
      created_at: now,
      updated_at: now,
      blocked_by: [],
      metadata: { source: "scheduled-qa", file },
    };

    // Run through triage gate before dispatching
    const triageResult = await triageIssue(issue, state, config);
    if (!triageResult.shouldDispatch) {
      logger.info("scheduled-qa", `Triage rejected QA issue for ${file}: ${triageResult.reason}`);
      continue;
    }

    // Create issue in tracker if supported
    if (tracker.createIssue) {
      try {
        const trackerId = await tracker.createIssue(title, description, labels);
        issue.id = trackerId;
        issue.identifier = trackerId;
        created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("scheduled-qa", `Failed to create issue for ${file}: ${msg}`);
      }
    }

    deps.dispatchIssue(issue);
    dispatched++;
  }

  logger.info("scheduled-qa", `Scheduled QA complete: ${created} issues created, ${dispatched} dispatched`);
  return { created, dispatched };
}

/**
 * Scan for source files with no test coverage (simple filename matching).
 */
async function scanCoverageGaps(_kgPath: string): Promise<string[]> {
  // KG removed — return empty. Coverage gap detection now uses simple
  // filename matching in findCoverageGaps (merge-daemon/pr-processor.ts).
  return [];
}

/**
 * Start the Scheduled QA timer loop.
 * Returns a stop function.
 */
export function startScheduledQA(deps: ScheduledQADeps): () => void {
  const intervalMs = deps.config.scheduled_qa?.interval_ms ?? 86_400_000;
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const runTick = (): void => {
    if (stopped) return;

    void (async () => {
      try {
        await scheduledQATick(deps);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.error("scheduled-qa", `Tick error: ${msg}`);
      }

      if (!stopped) {
        pendingTimer = setTimeout(runTick, intervalMs);
      }
    })();
  };

  // Start first tick after one interval (don't run immediately on startup)
  pendingTimer = setTimeout(runTick, intervalMs);

  return () => {
    stopped = true;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };
}

function resolveDefaultKgPath(config: ForgectlConfig): string {
  const storagePath = config.storage?.db_path ?? "~/.forgectl/forgectl.db";
  const dir = storagePath.replace(/\/[^/]+$/, "");
  const expanded = dir.replace(/^~/, process.env.HOME || "/tmp");
  return `${expanded}/kg.db`;
}
