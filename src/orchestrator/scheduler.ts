import { existsSync } from "node:fs";
import type { OrchestratorState } from "./state.js";
import type { TwoTierSlotManager } from "./state.js";
import type { TrackerAdapter, TrackerIssue } from "../tracker/types.js";
import type { ForgectlConfig, ScheduleEntry } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import type { RetryRepository } from "../storage/repositories/retries.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { DelegationManager } from "./delegation.js";
import type { SubIssueCache } from "../tracker/sub-issue-cache.js";
import type { GitHubContext } from "./dispatcher.js";
import type { ContextResult } from "../context/builder.js";
import { reconcile } from "./reconciler.js";
import { filterCandidates, sortCandidates, dispatchIssue, type GovernanceOpts } from "./dispatcher.js";
import { pruneStaleState } from "./state.js";
import { computeCriticalPath, type IssueDAGNode } from "../tracker/sub-issue-dag.js";
import { parseCron, cronMatches } from "./cron.js";

/**
 * Dependencies for a single tick of the scheduler.
 */
export interface TickDeps {
  state: OrchestratorState;
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  slotManager: TwoTierSlotManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  metrics: MetricsCollector;
  runRepo?: RunRepository;
  costRepo?: CostRepository;
  retryRepo?: RetryRepository;
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  delegationManager?: DelegationManager;
  /** Optional sub-issue cache for populating terminalIssueIds (SUBISSUE-03). */
  subIssueCache?: SubIssueCache;
  /** Optional GitHub context for triggering parent rollup on polling-dispatched issues (SUBISSUE-05, SUBISSUE-06). */
  githubContext?: GitHubContext;
  /** Skills from WORKFLOW.md to mount into agent containers. */
  skills?: string[];
  /** Validation config from WORKFLOW.md. */
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string };
  /** Optional path to the KG database file. Defaults to ~/.forgectl/kg.db. */
  kgDbPath?: string;
  /** Promoted review findings to inject as conventions into agent prompts. */
  promotedFindings?: import("../storage/repositories/review-findings.js").ReviewFindingRow[];
}

/**
 * Execute a single scheduler tick.
 *
 * Sequence: reconcile -> fetch candidates -> filter -> sort -> dispatch
 */
export async function tick(deps: TickDeps): Promise<void> {
  const { state, tracker, workspaceManager, slotManager, config, promptTemplate, logger, metrics } = deps;

  // Step 0: Prune stale entries from recentlyCompleted and issueBranches
  pruneStaleState(state);

  // Step 1: Reconcile running workers
  try {
    await reconcile(state, tracker, workspaceManager, config, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("scheduler", `Reconcile error: ${msg}`);
    return;
  }

  // Step 1.5: Drain stale claims — release any claimed issues that aren't running.
  // This guards against claims that weren't released due to async errors.
  for (const claimedId of [...state.claimed]) {
    if (!state.running.has(claimedId)) {
      logger.info("scheduler", `Releasing stale claim on ${claimedId} (not running)`);
      state.claimed.delete(claimedId);
    }
  }

  // Step 1.6: Evaluate cron schedules and inject synthetic issues
  const scheduledIssues = await evaluateSchedules(config, deps.kgDbPath ?? resolveDefaultKgPath(config), logger);

  // Step 2: Validate config (tracker must be defined)
  if (!config.tracker && scheduledIssues.length === 0) {
    logger.warn("scheduler", "No tracker configured and no scheduled tasks, skipping dispatch");
    return;
  }

  // Step 3: Fetch candidates
  let candidates: TrackerIssue[] = [];
  if (config.tracker) {
    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("scheduler", `Failed to fetch candidates: ${msg}`);
      if (scheduledIssues.length === 0) return;
    }
  }
  candidates = [...candidates, ...scheduledIssues];

  // Step 4: Build terminalIssueIds from SubIssueCache (SUBISSUE-03), then filter candidates
  const terminalIds = new Set<string>();
  if (deps.subIssueCache) {
    const terminalStates = new Set(deps.config.tracker?.terminal_states ?? ["closed"]);
    for (const entry of deps.subIssueCache.getAllEntries()) {
      for (const [childId, childState] of entry.childStates) {
        if (terminalStates.has(childState)) {
          terminalIds.add(childId);
        }
      }
    }
  }
  const doneLabel = config.tracker?.done_label;
  const eligible = filterCandidates(candidates, state, terminalIds, doneLabel);

  if (eligible.length === 0 && candidates.length > 0) {
    for (const c of candidates) {
      logger.info("scheduler", `  candidate ${c.identifier}: blocked_by=[${c.blocked_by.join(",")}] labels=[${c.labels.join(",")}] id=${c.id}`);
    }
    logger.info("scheduler", `  terminalIds: [${[...terminalIds].join(",")}]`);
  }
  logger.info("scheduler", `Tick: ${candidates.length} candidates, ${eligible.length} eligible, claimed=${state.claimed.size}, running=${state.running.size}`);

  // Step 5: Compute critical-path scores from the full candidate set,
  // then sort eligible issues so critical-path issues dispatch first.
  const dagNodes: IssueDAGNode[] = candidates.map(c => ({
    id: c.id,
    blocked_by: c.blocked_by,
  }));
  const criticalScores = computeCriticalPath(dagNodes);

  const prioritySorted = sortCandidates(eligible);
  const sorted = [...prioritySorted].sort((a, b) => {
    const scoreA = criticalScores.get(a.id) ?? 0;
    const scoreB = criticalScores.get(b.id) ?? 0;
    // Higher score = more downstream work unblocked = dispatch first
    return scoreB - scoreA;
  });

  // Step 6: Get available top-level slots (children have their own pool)
  const available = slotManager.availableTopLevelSlots();

  // Step 7: Build governance opts if runRepo available
  const governance: GovernanceOpts | undefined = deps.runRepo
    ? { autonomy: deps.autonomy ?? "full", autoApprove: deps.autoApprove, runRepo: deps.runRepo, costRepo: deps.costRepo, retryRepo: deps.retryRepo }
    : undefined;

  // Step 8: Auto-rebuild shared KG before building context
  const sharedKgPath = deps.kgDbPath ?? resolveDefaultKgPath(config);
  if (sorted.length > 0) {
    try {
      await autoRebuildSharedKG(sharedKgPath, config, logger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("scheduler", `Auto-rebuild KG failed (continuing with existing): ${msg}`);
    }
  }

  // Step 9: Build KG context for eligible issues (open + close db per tick)
  // Prefer per-workspace kg.db if it exists, fall back to the shared kg.db
  const kgContextMap = new Map<string, ContextResult>();
  if (sorted.length > 0) {
    const { createKGDatabase } = await import("../kg/storage.js");
    const { buildContext } = await import("../context/builder.js");
    const maxAgents = config.orchestrator?.max_concurrent_agents ?? 1;

    for (const issue of sorted.slice(0, available)) {
      // Resolve per-workspace kg.db path, fall back to shared kg.db
      let kgPath = sharedKgPath;
      let wsKgPath: string | undefined;
      try {
        const workspaceId = maxAgents > 1
          ? issue.identifier
          : (config.tracker?.repo?.replace("/", "_") ?? issue.identifier);
        wsKgPath = workspaceManager.getWorkspacePath(workspaceId) + "/kg.db";
        if (existsSync(wsKgPath)) {
          kgPath = wsKgPath;
        }
      } catch {
        // Workspace path resolution failed, use shared kg.db
      }

      if (!existsSync(kgPath)) {
        logger.warn("scheduler", `KG database not found for ${issue.identifier} (tried ${wsKgPath ?? "n/a"} and ${sharedKgPath})`);
        continue;
      }

      let kgDb: import("../kg/storage.js").KGDatabase | undefined;
      try {
        kgDb = createKGDatabase(kgPath);
        const taskSpec = issueToTaskSpec(issue);
        const ctx = await buildContext(taskSpec, kgDb);
        kgContextMap.set(issue.id, ctx);
        logger.info("scheduler", `KG context for ${issue.identifier}: ${ctx.includedFiles.length} files, ${ctx.budget.used}/${ctx.budget.max} tokens (db=${kgPath})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("scheduler", `Failed to build KG context for ${issue.identifier}: ${msg}`);
      } finally {
        try { kgDb?.close(); } catch { /* best-effort */ }
      }
    }
  }

  // Step 10: Dispatch up to available slots
  for (const issue of sorted.slice(0, available)) {
    dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance, deps.githubContext, deps.delegationManager, deps.subIssueCache, deps.skills, deps.validationConfig, undefined, kgContextMap.get(issue.id), undefined, slotManager);
  }
}

/**
 * Evaluate configured schedules against the current time.
 * Returns synthetic TrackerIssues for schedules that match and haven't run this minute.
 */
export async function evaluateSchedules(
  config: ForgectlConfig,
  kgDbPath: string,
  logger: Logger,
): Promise<TrackerIssue[]> {
  const schedules = config.schedules ?? [];
  if (schedules.length === 0) return [];

  const now = new Date();
  const results: TrackerIssue[] = [];

  let kgDb: import("../kg/storage.js").KGDatabase | undefined;
  try {
    const { createKGDatabase, getMeta, saveMeta } = await import("../kg/storage.js");
    kgDb = createKGDatabase(kgDbPath);

    for (const schedule of schedules) {
      try {
        const fields = parseCron(schedule.cron);
        if (!cronMatches(fields, now)) continue;

        // Check last-run to prevent duplicate dispatch within the same minute
        const metaKey = `schedule_last_run:${schedule.name}`;
        const lastRun = getMeta(kgDb, metaKey);
        const currentMinute = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        if (lastRun === currentMinute) {
          logger.debug("scheduler", `Schedule "${schedule.name}" already ran at ${currentMinute}, skipping`);
          continue;
        }

        // Record this run
        saveMeta(kgDb, metaKey, currentMinute);

        results.push(scheduleToSyntheticIssue(schedule, now));
        logger.info("scheduler", `Schedule "${schedule.name}" triggered at ${currentMinute}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("scheduler", `Failed to evaluate schedule "${schedule.name}": ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("scheduler", `Failed to open KG for schedule tracking: ${msg}`);
  } finally {
    try { kgDb?.close(); } catch { /* best-effort */ }
  }

  return results;
}

function scheduleToSyntheticIssue(schedule: ScheduleEntry, now: Date): TrackerIssue {
  const ts = now.toISOString();
  const id = `schedule:${schedule.name}:${ts}`;
  return {
    id,
    identifier: `schedule/${schedule.name}`,
    title: `Scheduled: ${schedule.name}`,
    description: schedule.task,
    state: "open",
    priority: null,
    labels: ["scheduled"],
    assignees: [],
    url: "",
    created_at: ts,
    updated_at: ts,
    blocked_by: [],
    metadata: {
      synthetic: true,
      scheduleName: schedule.name,
      ...(schedule.repo ? { repo: schedule.repo } : {}),
    },
  };
}

/**
 * Auto-rebuild the shared KG if it is stale or missing.
 * Uses incremental build when git can supply changed files, falls back to full build.
 */
async function autoRebuildSharedKG(
  kgPath: string,
  _config: ForgectlConfig,
  logger: Logger,
): Promise<void> {
  const { buildFullGraph, buildIncrementalGraph } = await import("../kg/builder.js");
  const { getMeta, createKGDatabase } = await import("../kg/storage.js");

  const repoPath = process.cwd();

  if (!existsSync(kgPath)) {
    logger.info("scheduler", `KG not found at ${kgPath}, running full build`);
    await buildFullGraph(repoPath, kgPath);
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);
      const { stdout } = await execFileP("git", ["-C", repoPath, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 });
      await saveLastBuildCommit(kgPath, stdout.trim(), createKGDatabase, logger);
    } catch {
      // best-effort
    }
    return;
  }

  // Check staleness: retrieve last build commit SHA
  let lastBuildCommit: string | null = null;
  let kgDb: import("../kg/storage.js").KGDatabase | undefined;
  try {
    kgDb = createKGDatabase(kgPath);
    lastBuildCommit = getMeta(kgDb, "last_build_commit");
  } finally {
    try { kgDb?.close(); } catch { /* best-effort */ }
  }

  // Try incremental build using git log since last build commit
  if (lastBuildCommit) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);

      // Get current HEAD commit
      const { stdout: headSha } = await execFileP("git", [
        "-C", repoPath, "rev-parse", "HEAD",
      ], { maxBuffer: 1024 * 1024 });
      const currentCommit = headSha.trim();

      if (currentCommit === lastBuildCommit) {
        logger.debug("scheduler", "KG is up to date, no rebuild needed");
        return;
      }

      const { stdout } = await execFileP("git", [
        "-C", repoPath, "log", "--name-only", "--diff-filter=ACMR",
        "--pretty=format:", `${lastBuildCommit}..HEAD`,
      ], { maxBuffer: 1024 * 1024 });
      const changed = [...new Set(stdout.trim().split("\n").filter(
        f => f && (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts"),
      ))];
      if (changed.length === 0) {
        logger.debug("scheduler", "KG is up to date, no rebuild needed");
        // Still update the commit SHA so we don't re-scan the same range
        await saveLastBuildCommit(kgPath, currentCommit, createKGDatabase, logger);
        return;
      }
      logger.info("scheduler", `KG incremental rebuild: ${changed.length} changed files`);
      await buildIncrementalGraph(repoPath, changed, kgPath);
      await saveLastBuildCommit(kgPath, currentCommit, createKGDatabase, logger);
      return;
    } catch {
      // git log failed, fall through to full build
    }
  }

  logger.info("scheduler", "KG full rebuild triggered (no prior build or git log failed)");
  await buildFullGraph(repoPath, kgPath);

  // Record current HEAD commit so subsequent ticks can do incremental builds
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP("git", ["-C", repoPath, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 });
    await saveLastBuildCommit(kgPath, stdout.trim(), createKGDatabase, logger);
  } catch {
    // best-effort
  }
}

async function saveLastBuildCommit(
  kgPath: string,
  commitSha: string,
  createKGDatabase: typeof import("../kg/storage.js").createKGDatabase,
  logger: Logger,
): Promise<void> {
  let db: import("../kg/storage.js").KGDatabase | undefined;
  try {
    const { saveMeta } = await import("../kg/storage.js");
    db = createKGDatabase(kgPath);
    saveMeta(db, "last_build_commit", commitSha);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("scheduler", `Failed to save last_build_commit: ${msg}`);
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

function resolveDefaultKgPath(config: ForgectlConfig): string {
  const storagePath = config.storage?.db_path ?? "~/.forgectl/forgectl.db";
  const dir = storagePath.replace(/\/[^/]+$/, "");
  const expanded = dir.replace(/^~/, process.env.HOME || "/tmp");
  return `${expanded}/kg.db`;
}

function issueToTaskSpec(issue: import("../tracker/types.js").TrackerIssue): import("../task/types.js").TaskSpec {
  const fileRefPattern = /(?:src|test|lib)\/[\w/.=-]+\.(?:ts|js|tsx|jsx)/g;
  const text = `${issue.title}\n${issue.description}`;
  const files = [...text.matchAll(fileRefPattern)].map(m => m[0]);

  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    context: { files },
    constraints: [],
    acceptance: [],
    decomposition: { strategy: "forbidden" },
    effort: {},
  };
}

/**
 * Start the scheduler tick loop using setTimeout chain.
 * Returns a stop function to halt scheduling.
 */
export function startScheduler(deps: TickDeps): () => void {
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick(deps);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.error("scheduler", `Tick error: ${msg}`);
      }

      if (stopped) break;

      // setTimeout chain: wait poll_interval_ms before next tick
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          pendingResolve = null;
          resolve();
        }, deps.config.orchestrator.poll_interval_ms);
      });
    }
  };

  void loop();

  return () => {
    stopped = true;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingResolve !== null) {
      pendingResolve();
      pendingResolve = null;
    }
  };
}
