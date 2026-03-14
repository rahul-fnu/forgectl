import type { OrchestratorState } from "./state.js";
import type { SlotManager } from "./state.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { SubIssueCache } from "../tracker/sub-issue-cache.js";
import type { GitHubContext } from "./dispatcher.js";
import { reconcile } from "./reconciler.js";
import { filterCandidates, sortCandidates, dispatchIssue, type GovernanceOpts } from "./dispatcher.js";

/**
 * Dependencies for a single tick of the scheduler.
 */
export interface TickDeps {
  state: OrchestratorState;
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  slotManager: SlotManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  metrics: MetricsCollector;
  runRepo?: RunRepository;
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  /** Optional sub-issue cache for populating terminalIssueIds (SUBISSUE-03). */
  subIssueCache?: SubIssueCache;
  /** Optional GitHub context for triggering parent rollup on polling-dispatched issues (SUBISSUE-05, SUBISSUE-06). */
  githubContext?: GitHubContext;
  /** Skills from WORKFLOW.md to mount into agent containers. */
  skills?: string[];
  /** Validation config from WORKFLOW.md. */
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string };
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

  logger.debug("scheduler", `Tick: ${candidates.length} candidates, ${eligible.length} eligible, claimed=${state.claimed.size}, running=${state.running.size}`);

  // Step 5: Sort candidates
  const sorted = sortCandidates(eligible);

  // Step 6: Get available slots
  const available = slotManager.availableSlots(state.running);

  // Step 7: Build governance opts if runRepo available
  const governance: GovernanceOpts | undefined = deps.runRepo
    ? { autonomy: deps.autonomy ?? "full", autoApprove: deps.autoApprove, runRepo: deps.runRepo }
    : undefined;

  // Step 8: Dispatch up to available slots
  for (const issue of sorted.slice(0, available)) {
    dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance, deps.githubContext, deps.subIssueCache, deps.skills, deps.validationConfig);
  }
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
