import type { OutcomeRow } from "../storage/repositories/outcomes.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { Logger } from "../logging/logger.js";

export interface ReactiveConfig {
  auto_create_issues: boolean;
  max_issues_per_day: number;
}

export const DEFAULT_REACTIVE_CONFIG: ReactiveConfig = {
  auto_create_issues: true,
  max_issues_per_day: 5,
};

export interface Anomaly {
  title: string;
  description: string;
  module: string;
  failureMode: string;
  affectedRuns: string[];
  occurrences: number;
}

const REACTIVE_LABEL = "reactive-maintenance";
const TITLE_PREFIX = "[reactive]";

const issueCounts = new Map<string, number>();

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getIssuesToday(): number {
  return issueCounts.get(getTodayKey()) ?? 0;
}

function incrementIssuesToday(): void {
  const key = getTodayKey();
  issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
}

export function resetDailyCount(): void {
  issueCounts.clear();
}

export function detectAnomalies(rows: OutcomeRow[]): Anomaly[] {
  const moduleFailures = new Map<string, Map<string, { runs: string[]; details: string[] }>>();

  for (const row of rows) {
    if (row.status !== "failure" || !row.failureMode) continue;

    let modules: string[] = [];
    if (row.modulesTouched) {
      try {
        modules = JSON.parse(row.modulesTouched);
      } catch {
        continue;
      }
    }

    if (modules.length === 0) {
      const detailMatch = row.failureDetail?.match(/(?:in|at)\s+(src\/[\w/.-]+)/);
      if (detailMatch) {
        const parts = detailMatch[1].split("/");
        modules = [parts.slice(0, 2).join("/")];
      }
    }

    if (modules.length === 0) modules = ["unknown"];

    for (const mod of modules) {
      const topMod = mod.split("/").slice(0, 2).join("/");
      if (!moduleFailures.has(topMod)) {
        moduleFailures.set(topMod, new Map());
      }
      const modeMap = moduleFailures.get(topMod)!;
      if (!modeMap.has(row.failureMode)) {
        modeMap.set(row.failureMode, { runs: [], details: [] });
      }
      const entry = modeMap.get(row.failureMode)!;
      entry.runs.push(row.id);
      if (row.failureDetail) {
        entry.details.push(row.failureDetail.slice(0, 500));
      }
    }
  }

  const anomalies: Anomaly[] = [];

  for (const [mod, modeMap] of moduleFailures) {
    for (const [mode, entry] of modeMap) {
      if (entry.runs.length < 2) continue;

      const modeLabel = mode.replace(/_/g, " ").toLowerCase();
      const title = `${TITLE_PREFIX} Fix repeated ${modeLabel} failure in ${mod}`;
      const evidenceLines = entry.details
        .slice(0, 3)
        .map((d, i) => `- Run ${entry.runs[i]}: ${d}`);
      const description = [
        `**Anomaly detected:** repeated \`${mode}\` failures in \`${mod}\`.`,
        "",
        `**Occurrences:** ${entry.runs.length} failures across runs: ${entry.runs.join(", ")}`,
        "",
        "**Evidence:**",
        ...evidenceLines,
        "",
        "**Suggested approach:** Investigate the root cause of the repeated failures in this module. Check for flaky tests, missing dependencies, or configuration issues.",
      ].join("\n");

      anomalies.push({
        title,
        description,
        module: mod,
        failureMode: mode,
        affectedRuns: entry.runs,
        occurrences: entry.runs.length,
      });
    }
  }

  return anomalies.sort((a, b) => b.occurrences - a.occurrences);
}

export function buildIssueTitle(anomaly: Anomaly): string {
  return anomaly.title;
}

export async function createReactiveIssue(
  anomaly: Anomaly,
  tracker: TrackerAdapter,
  config: ReactiveConfig,
  logger: Logger,
  existingIssueTitles?: string[],
): Promise<string | undefined> {
  if (!config.auto_create_issues) return undefined;

  if (getIssuesToday() >= config.max_issues_per_day) {
    logger.warn("reactive", `Daily issue limit reached (${config.max_issues_per_day}), skipping: ${anomaly.title}`);
    return undefined;
  }

  if (!tracker.createIssue) {
    logger.warn("reactive", "Tracker does not support issue creation");
    return undefined;
  }

  const title = buildIssueTitle(anomaly);

  if (existingIssueTitles) {
    const isDuplicate = existingIssueTitles.some(
      (t) => t === title || t.startsWith(`${TITLE_PREFIX} Fix repeated`) && t.includes(anomaly.module) && t.includes(anomaly.failureMode.replace(/_/g, " ").toLowerCase()),
    );
    if (isDuplicate) {
      logger.info("reactive", `Skipping duplicate issue: ${title}`);
      return undefined;
    }
  }

  try {
    const identifier = await tracker.createIssue(title, anomaly.description, [REACTIVE_LABEL]);
    incrementIssuesToday();
    logger.info("reactive", `Created reactive issue ${identifier}: ${title}`);
    return identifier;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("reactive", `Failed to create reactive issue: ${msg}`);
    return undefined;
  }
}

export async function dispatchReactiveIssues(
  rows: OutcomeRow[],
  tracker: TrackerAdapter,
  config: ReactiveConfig,
  logger: Logger,
): Promise<string[]> {
  if (!config.auto_create_issues) return [];

  const anomalies = detectAnomalies(rows);
  if (anomalies.length === 0) return [];

  let existingTitles: string[] = [];
  try {
    const existing = await tracker.fetchIssuesByStates(["open", "in_progress", "todo", "Todo", "In Progress"]);
    existingTitles = existing
      .filter((i) => i.title.startsWith(TITLE_PREFIX))
      .map((i) => i.title);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("reactive", `Failed to fetch existing issues for dedup: ${msg}`);
  }

  const created: string[] = [];
  for (const anomaly of anomalies) {
    if (getIssuesToday() >= config.max_issues_per_day) break;
    const id = await createReactiveIssue(anomaly, tracker, config, logger, existingTitles);
    if (id) created.push(id);
  }

  return created;
}
