import type { TrackerAdapter } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { createState, type OrchestratorState, SlotManager } from "./state.js";
import { clearAllRetries } from "./retry.js";
import { startScheduler, type TickDeps } from "./scheduler.js";
import { cleanupRun } from "../container/cleanup.js";

export interface OrchestratorOptions {
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
}

/**
 * Top-level Orchestrator that ties together state, scheduler, dispatcher,
 * reconciler, worker, and retry into a unified lifecycle.
 */
export class Orchestrator {
  private state!: OrchestratorState;
  private slotManager!: SlotManager;
  private readonly tracker: TrackerAdapter;
  private readonly workspaceManager: WorkspaceManager;
  private readonly config: ForgectlConfig;
  private readonly promptTemplate: string;
  private readonly logger: Logger;
  private stopScheduler: (() => void) | null = null;
  private running = false;

  constructor(opts: OrchestratorOptions) {
    this.tracker = opts.tracker;
    this.workspaceManager = opts.workspaceManager;
    this.config = opts.config;
    this.promptTemplate = opts.promptTemplate;
    this.logger = opts.logger;
  }

  /**
   * Start the orchestrator: create state, run startup recovery, start scheduler.
   */
  async start(): Promise<void> {
    this.state = createState();
    this.slotManager = new SlotManager(this.config.orchestrator.max_concurrent_agents);

    // Run startup recovery (errors are non-fatal)
    try {
      await this.startupRecovery();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("orchestrator", `Startup recovery failed (continuing): ${msg}`);
    }

    // Start the scheduler tick loop
    const deps: TickDeps = {
      state: this.state,
      tracker: this.tracker,
      workspaceManager: this.workspaceManager,
      slotManager: this.slotManager,
      config: this.config,
      promptTemplate: this.promptTemplate,
      logger: this.logger,
    };
    this.stopScheduler = startScheduler(deps);

    this.running = true;
    const max = this.config.orchestrator.max_concurrent_agents;
    const poll = this.config.orchestrator.poll_interval_ms;
    this.logger.info("orchestrator", `Orchestrator started (max=${max}, poll=${poll}ms)`);
  }

  /**
   * Fetch terminal-state issues and clean their workspaces.
   */
  private async startupRecovery(): Promise<void> {
    if (!this.config.tracker) {
      return;
    }

    const terminalStates = this.config.tracker.terminal_states;
    const terminalIssues = await this.tracker.fetchIssuesByStates(terminalStates);
    const identifiers = terminalIssues.map((issue) => issue.identifier);

    if (identifiers.length > 0) {
      await this.workspaceManager.cleanupTerminalWorkspaces(identifiers);
    }

    this.logger.info(
      "orchestrator",
      `Startup recovery: cleaned ${identifiers.length} terminal workspaces`,
    );
  }

  /**
   * Graceful shutdown: drain running agents, force-kill remainders,
   * release all claims, clear state.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Stop the scheduler tick loop
    this.stopScheduler?.();
    this.stopScheduler = null;

    // Clear all pending retry timers
    clearAllRetries(this.state);

    // Drain running workers with timeout
    if (this.state.running.size > 0) {
      const drainPromise = Promise.allSettled(
        [...this.state.running.values()].map((w) => w.session.close()),
      );

      await Promise.race([
        drainPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.config.orchestrator.drain_timeout_ms),
        ),
      ]);

      // Force-kill remaining workers
      for (const worker of this.state.running.values()) {
        try {
          await cleanupRun(worker.cleanup);
        } catch {
          // Ignore cleanup errors during shutdown
        }
      }
    }

    // Release all claims — remove in_progress labels
    const labelRemovePromises = [...this.state.claimed].map((id) =>
      this.tracker
        .updateLabels(id, [], [this.config.orchestrator.in_progress_label])
        .catch(() => {
          // Ignore label removal errors during shutdown
        }),
    );
    await Promise.allSettled(labelRemovePromises);

    // Clear all state
    this.state.claimed.clear();
    this.state.running.clear();
    this.state.retryTimers.clear();
    this.state.retryAttempts.clear();

    this.logger.info("orchestrator", "Orchestrator stopped");
  }

  /**
   * Returns true if the orchestrator is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the current orchestrator state for API/dashboard access.
   */
  getState(): OrchestratorState {
    return this.state;
  }
}
