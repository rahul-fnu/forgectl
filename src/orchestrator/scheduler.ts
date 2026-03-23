import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OrchestratorState } from "./state.js";
import type { TwoTierSlotManager } from "./state.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
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
import { computeCriticalPath, type IssueDAGNode } from "../tracker/sub-issue-dag.js";

const execFileAsync = promisify(execFile);

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
  /** Repo root for KG rebuilds. Defaults to process.cwd(). */
  repoRoot?: string;
}

const KG_DEBOUNCE_MS = 60_000;
let lastKgRebuildTs = 0;

/**
 * Ensure the KG database is up-to-date before context assembly.
 * Runs an incremental rebuild if changed files exist, or a full build
 * if no kg.db exists yet. Debounces to avoid rebuilding every tick.
 */
async function ensureKG(kgPath: string, repoRoot: string, logger: Logger): Promise<void> {
  const now = Date.now();
  if (now - lastKgRebuildTs < KG_DEBOUNCE_MS) return;

  const { buildFullGraph, buildIncrementalGraph } = await import("../kg/builder.js");
  const { getMeta, createKGDatabase } = await import("../kg/storage.js");

  if (!existsSync(kgPath)) {
    logger.info("scheduler", "KG database not found, running full build…");
    try {
      const stats = await buildFullGraph(repoRoot, kgPath);
      lastKgRebuildTs = Date.now();
      logger.info("scheduler", `KG full build complete: ${stats.totalModules} modules`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("scheduler", `KG full build failed: ${msg}`);
    }
    return;
  }

  // Get last build timestamp from kg_meta
  let lastBuildIso: string | null = null;
  let db: import("../kg/storage.js").KGDatabase | undefined;
  try {
    db = createKGDatabase(kgPath);
    lastBuildIso = getMeta(db, "last_incremental") ?? getMeta(db, "last_full_build");
  } catch {
    // Can't read meta — will try incremental anyway
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }

  // Get changed files since last build using git diff
  let changedFiles: string[] = [];
  try {
    const diffArgs = lastBuildIso
      ? ["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", "*.ts", "*.tsx"]
      : ["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", "*.ts", "*.tsx"];

    const { stdout } = await execFileAsync("git", diffArgs, { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
    changedFiles = stdout.trim().split("\n").filter(Boolean);

    // Also check for new untracked files
    const { stdout: untrackedOut } = await execFileAsync(
      "git", ["ls-files", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const untracked = untrackedOut.trim().split("\n").filter(Boolean);
    changedFiles = [...new Set([...changedFiles, ...untracked])];
  } catch {
    // Not a git repo or git not available — skip
    lastKgRebuildTs = Date.now();
    return;
  }

  if (changedFiles.length === 0) {
    lastKgRebuildTs = Date.now();
    return;
  }

  logger.info("scheduler", `KG incremental rebuild: ${changedFiles.length} changed files`);
  try {
    const stats = await buildIncrementalGraph(repoRoot, changedFiles, kgPath);
    lastKgRebuildTs = Date.now();
    logger.info("scheduler", `KG incremental rebuild complete: ${stats.totalModules} modules`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("scheduler", `KG incremental rebuild failed: ${msg}`);
  }
}

/**
 * Execute a single scheduler tick.
 *
 * Sequence: reconcile -> fetch candidates -> filter -> sort -> dispatch
 */
export async function tick(deps: TickDeps): Promise<void> {
  const { state, tracker, workspaceManager, slotManager, config, promptTemplate, logger, metrics } = deps;

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

  // Step 2: Validate config (tracker must be defined)
  if (!config.tracker) {
    logger.warn("scheduler", "No tracker configured, skipping dispatch");
    return;
  }

  // Step 3: Fetch candidates
  let candidates;
  try {
    candidates = await tracker.fetchCandidateIssues();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("scheduler", `Failed to fetch candidates: ${msg}`);
    return;
  }

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

  // Step 7.5: Ensure KG is up-to-date before context assembly
  const sharedKgPath = deps.kgDbPath ?? resolveDefaultKgPath(config);
  const repoRoot = deps.repoRoot ?? process.cwd();
  try {
    await ensureKG(sharedKgPath, repoRoot, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("scheduler", `KG rebuild error: ${msg}`);
  }

  // Step 8: Build KG context for eligible issues (open + close db per tick)
  // Prefer per-workspace kg.db if it exists, fall back to the shared kg.db
  const kgContextMap = new Map<string, ContextResult>();
  if (sorted.length > 0) {
    const { createKGDatabase } = await import("../kg/storage.js");
    const { buildContext } = await import("../context/builder.js");
    const maxAgents = config.orchestrator?.max_concurrent_agents ?? 1;

    for (const issue of sorted.slice(0, available)) {
      // Resolve per-workspace kg.db path, fall back to shared kg.db
      let kgPath = sharedKgPath;
      try {
        const workspaceId = maxAgents > 1
          ? issue.identifier
          : (config.tracker?.repo?.replace("/", "_") ?? issue.identifier);
        const wsKgPath = workspaceManager.getWorkspacePath(workspaceId) + "/kg.db";
        if (existsSync(wsKgPath)) {
          kgPath = wsKgPath;
        }
      } catch {
        // Workspace path resolution failed, use shared kg.db
      }

      if (!existsSync(kgPath)) {
        logger.warn("scheduler", `KG database not found for ${issue.identifier} (tried ${kgPath})`);
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

  // Step 9: Dispatch up to available slots
  for (const issue of sorted.slice(0, available)) {
    dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance, deps.githubContext, deps.delegationManager, deps.subIssueCache, deps.skills, deps.validationConfig, undefined, kgContextMap.get(issue.id));
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

  const scheduleTick = (): void => {
    if (stopped) return;

    void (async () => {
      try {
        await tick(deps);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.error("scheduler", `Tick error: ${msg}`);
      }

      if (!stopped) {
        pendingTimer = setTimeout(scheduleTick, deps.config.orchestrator.poll_interval_ms);
      }
    })();
  };

  // Start first tick immediately
  scheduleTick();

  return () => {
    stopped = true;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };
}
