import type { OrchestratorState } from "./state.js";
import type { SlotManager } from "./state.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
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

  // Step 4: Filter candidates (terminalIds from config)
  const terminalIds = new Set<string>(); // Built from recent reconciliation data
  const eligible = filterCandidates(candidates, state, terminalIds);

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
    dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance);
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
