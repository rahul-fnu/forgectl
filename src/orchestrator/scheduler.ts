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
import type { AutonomyLevel, AutoApproveRule } from "../config/schema.js";
import type { DelegationManager } from "./delegation.js";
import type { SubIssueCache } from "../tracker/sub-issue-cache.js";
import type { GitHubContext } from "./dispatcher.js";
import type { ContextResult } from "../context/builder.js";

/** In-memory dedup for cron schedules (resets on daemon restart). */
const scheduleLastRun = new Map<string, string>();
import type { CooldownRepository } from "../storage/repositories/cooldown.js";
import type { UsageLimitRecovery } from "./usage-limit-recovery.js";
import type { AlertManager } from "../alerting/manager.js";
import { reconcile } from "./reconciler.js";
import { filterCandidates, sortCandidates, dispatchIssue, type GovernanceOpts } from "./dispatcher.js";
import { pruneStaleState } from "./state.js";
import { computeCriticalPath, type IssueDAGNode } from "../tracker/sub-issue-dag.js";
import { parseCron, cronMatches } from "./cron.js";
import { probeUsageLimit } from "./usage-limit-probe.js";

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
  /** Cooldown state repository for persisting usage limit cooldown across restarts. */
  cooldownRepo?: CooldownRepository;
  /** Timestamp of the last usage limit probe (mutable, updated each tick). */
  lastProbeAt?: number;
  /** Usage limit recovery manager for re-dispatching paused tasks. */
  usageLimitRecovery?: UsageLimitRecovery;
  /** Alert manager for webhook/Slack notifications. */
  alertManager?: AlertManager;
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

  // Step 1.6a: Check if in cooldown (usage limit). If so, run probe and skip dispatch.
  if (deps.cooldownRepo) {
    const cooldownState = deps.cooldownRepo.getCooldownState();
    if (cooldownState?.active) {
      const probeIntervalMs = (config.agent.usage_limit.probe_interval_minutes ?? 15) * 60_000;
      const lastProbe = deps.lastProbeAt ?? 0;
      const timeSinceProbe = Date.now() - lastProbe;

      if (timeSinceProbe >= probeIntervalMs) {
        deps.lastProbeAt = Date.now();
        deps.cooldownRepo.incrementProbeCount();

        let probeSuccess = false;
        try {
          probeSuccess = await probeUsageLimit(config, logger);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("scheduler", `Usage limit probe error: ${msg}`);
        }

        if (probeSuccess) {
          deps.cooldownRepo.exitCooldown();
          logger.info("scheduler", "Usage limit probe succeeded — exiting cooldown");

          // Re-queue paused runs
          const maxResumes = config.agent.usage_limit.max_resumes ?? 3;
          const pausedRuns = deps.runRepo?.findByStatus("paused_usage_limit") ?? [];
          for (const run of pausedRuns) {
            const ctx = run.pauseContext as { usageLimitPauseCount?: number } | null;
            const pauseCount = ctx?.usageLimitPauseCount ?? 0;
            if (pauseCount >= maxResumes) {
              deps.runRepo!.updateStatus(run.id, {
                status: "failed",
                completedAt: new Date().toISOString(),
                error: "usage_limit_max_resumes",
              });
              deps.runRepo!.clearPauseContext(run.id);
              logger.warn("scheduler", `Run ${run.id} failed — max usage limit resumes (${maxResumes}) exceeded`);
            } else {
              deps.runRepo!.updateStatus(run.id, { status: "todo" });
              deps.runRepo!.clearPauseContext(run.id);
              logger.info("scheduler", `Re-queued run ${run.id} after usage limit cooldown`);

              // Post tracker comment about restart
              if (deps.tracker && config.tracker?.comments_enabled !== false) {
                deps.tracker.postComment(
                  run.id,
                  `▶️ **forgectl:** Task restarted after usage limit cooldown (attempt ${pauseCount + 1}/${maxResumes}).`,
                ).catch(() => { /* best-effort */ });
              }
            }

            // Stagger re-queues to avoid immediately hitting the limit again
            if (pausedRuns.indexOf(run) < pausedRuns.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 30_000));
            }
          }
        } else {
          logger.info("scheduler", `Usage limit probe failed — staying in cooldown`);
        }
      }

      logger.info("scheduler", `Scheduler in cooldown until ${cooldownState.resumeAt ?? "unknown"}`);
      return;
    }
  }

  // Step 1.7: Evaluate cron schedules and inject synthetic issues
  const scheduledIssues = await evaluateSchedules(config, logger);

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

  // Step 6: Get available slots from TwoTierSlotManager
  // (dispatcher calls registerTopLevel/releaseTopLevel to keep it in sync)
  const available = slotManager.availableTopLevelSlots();

  // Step 7: Build governance opts if runRepo available
  const governance: GovernanceOpts | undefined = deps.runRepo
    ? { autonomy: deps.autonomy ?? "full", autoApprove: deps.autoApprove, runRepo: deps.runRepo, costRepo: deps.costRepo, retryRepo: deps.retryRepo }
    : undefined;

  // KG removed — agents read CLAUDE.md natively from the workspace
  // KG context removed — agents read CLAUDE.md natively from the workspace
  const kgContextMap = new Map<string, ContextResult>();
  if (sorted.length > 0) {
    // No KG context building needed — Claude Code reads CLAUDE.md automatically
  }

  // Step 10: Dispatch up to available slots (with pre-dispatch triage)
  for (const issue of sorted.slice(0, available)) {
    await dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance, deps.githubContext, deps.delegationManager, deps.subIssueCache, deps.skills, deps.validationConfig, undefined, deps.promotedFindings, slotManager, deps.usageLimitRecovery);
  }
}

/**
 * Evaluate configured schedules against the current time.
 * Returns synthetic TrackerIssues for schedules that match and haven't run this minute.
 */
export async function evaluateSchedules(
  config: ForgectlConfig,
  logger: Logger,
): Promise<TrackerIssue[]> {
  const schedules = config.schedules ?? [];
  if (schedules.length === 0) return [];

  const now = new Date();
  const results: TrackerIssue[] = [];

  for (const schedule of schedules) {
    try {
      const fields = parseCron(schedule.cron);
      if (!cronMatches(fields, now)) continue;

      // Simple dedup: track last-run in memory (resets on daemon restart, which is fine)
      const currentMinute = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const metaKey = `schedule_last_run:${schedule.name}`;
      if (scheduleLastRun.get(metaKey) === currentMinute) continue;
      scheduleLastRun.set(metaKey, currentMinute);

      results.push(scheduleToSyntheticIssue(schedule, now));
      logger.info("scheduler", `Schedule "${schedule.name}" triggered at ${currentMinute}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("scheduler", `Failed to evaluate schedule "${schedule.name}": ${msg}`);
    }
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
 * KG removed — agents read CLAUDE.md natively from the workspace.
 */

/**
 * Start the scheduler tick loop using setTimeout chain.
 * Returns a stop function to halt scheduling.
 */
export function startScheduler(deps: TickDeps): () => void {
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;

  let firstTick = true;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (firstTick) {
        // Skip initial fetch — wait for webhooks or first poll interval.
        // This avoids burning Linear API requests on startup.
        firstTick = false;
        deps.logger.info("scheduler", "Skipping initial fetch — waiting for webhooks or first poll interval");
      } else {
        try {
          await tick(deps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.logger.error("scheduler", `Tick error: ${msg}`);
        }
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
