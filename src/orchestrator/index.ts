import type { TrackerAdapter } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { TrackerIssue } from "../tracker/types.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { RepoContext } from "../github/types.js";
import { createState, type OrchestratorState, TwoTierSlotManager, createTwoTierSlotManager } from "./state.js";
import { clearAllRetries } from "./retry.js";
import { startScheduler, tick, type TickDeps } from "./scheduler.js";
import { cleanupRun } from "../container/cleanup.js";
import { MetricsCollector } from "./metrics.js";
import { dispatchIssue as dispatchIssueImpl, type GovernanceOpts } from "./dispatcher.js";

/** GitHub context passed from webhook handler through to dispatcher. */
export interface GitHubContext {
  octokit: unknown;
  repo: RepoContext;
}

export interface OrchestratorOptions {
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  runRepo?: RunRepository;
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
}

/**
 * Top-level Orchestrator that ties together state, scheduler, dispatcher,
 * reconciler, worker, and retry into a unified lifecycle.
 */
export class Orchestrator {
  private state!: OrchestratorState;
  private slotManager!: TwoTierSlotManager;
  private readonly tracker: TrackerAdapter;
  private readonly workspaceManager: WorkspaceManager;
  private config: ForgectlConfig;
  private promptTemplate: string;
  private readonly logger: Logger;
  private readonly runRepo?: RunRepository;
  private readonly autonomy?: AutonomyLevel;
  private readonly autoApprove?: AutoApproveRule;
  private stopScheduler: (() => void) | null = null;
  private running = false;
  private metrics!: MetricsCollector;
  private deps!: TickDeps;
  private tickInProgress = false;

  constructor(opts: OrchestratorOptions) {
    this.tracker = opts.tracker;
    this.workspaceManager = opts.workspaceManager;
    this.config = opts.config;
    this.promptTemplate = opts.promptTemplate;
    this.logger = opts.logger;
    this.runRepo = opts.runRepo;
    this.autonomy = opts.autonomy;
    this.autoApprove = opts.autoApprove;
  }

  /**
   * Start the orchestrator: create state, run startup recovery, start scheduler.
   */
  async start(): Promise<void> {
    this.state = createState();
    this.slotManager = createTwoTierSlotManager(this.config.orchestrator);
    this.metrics = new MetricsCollector();

    // Run startup recovery (errors are non-fatal)
    try {
      await this.startupRecovery();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("orchestrator", `Startup recovery failed (continuing): ${msg}`);
    }

    // Start the scheduler tick loop
    this.deps = {
      state: this.state,
      tracker: this.tracker,
      workspaceManager: this.workspaceManager,
      slotManager: this.slotManager,
      config: this.config,
      promptTemplate: this.promptTemplate,
      logger: this.logger,
      metrics: this.metrics,
      runRepo: this.runRepo,
      autonomy: this.autonomy,
      autoApprove: this.autoApprove,
    };
    this.stopScheduler = startScheduler(this.deps);

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

  /**
   * Returns the MetricsCollector for API/dashboard access.
   */
  getMetrics(): MetricsCollector {
    return this.metrics;
  }

  /**
   * Returns slot utilization info for the API.
   * Includes two-tier breakdown when delegation is enabled.
   */
  getSlotUtilization(): { active: number; max: number; topLevel?: { active: number; max: number }; children?: { active: number; max: number } } {
    const topLevelRunning = this.slotManager.getTopLevelRunning();
    const childRunning = this.slotManager.getChildRunning();
    const topLevelActive = topLevelRunning.size;
    const childActive = childRunning.size;
    const topLevelMax = this.slotManager.availableTopLevelSlots() + topLevelActive;
    const childMax = this.slotManager.availableChildSlots() + childActive;

    return {
      active: topLevelActive + childActive,
      max: this.slotManager.getMax(),
      topLevel: { active: topLevelActive, max: topLevelMax },
      children: { active: childActive, max: childMax },
    };
  }

  /**
   * Dispatch an issue for immediate processing.
   * Delegates to the standalone dispatchIssue function using orchestrator internals.
   * No-op if the orchestrator is not running.
   */
  dispatchIssue(issue: TrackerIssue, githubContext?: GitHubContext): void {
    if (!this.running) {
      this.logger.warn("orchestrator", `dispatchIssue called but orchestrator not running`);
      return;
    }
    const governance: GovernanceOpts | undefined = this.runRepo
      ? {
          autonomy: this.autonomy ?? "full",
          autoApprove: this.autoApprove,
          runRepo: this.runRepo,
        }
      : undefined;
    dispatchIssueImpl(
      issue,
      this.state,
      this.tracker,
      this.config,
      this.workspaceManager,
      this.promptTemplate,
      this.logger,
      this.metrics,
      governance,
      githubContext,
    );
  }

  /**
   * Apply new config and prompt template at runtime without restarting.
   * Updates internal deps so subsequent ticks use the new values.
   * In-flight workers are NOT affected.
   */
  applyConfig(config: ForgectlConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.deps.config = config;
    this.deps.promptTemplate = promptTemplate;

    const newMax = config.orchestrator.max_concurrent_agents;
    const newChildSlots = config.orchestrator.child_slots ?? 0;
    const oldChildSlots = this.slotManager instanceof TwoTierSlotManager
      ? (this.slotManager.availableChildSlots() + this.slotManager.getChildRunning().size)
      : 0;
    if (newMax !== this.slotManager.getMax() || newChildSlots !== oldChildSlots) {
      this.slotManager = createTwoTierSlotManager(config.orchestrator);
    }

    this.logger.info(
      "orchestrator",
      `Config reloaded (max=${newMax}, poll=${config.orchestrator.poll_interval_ms}ms)`,
    );
  }

  /**
   * Trigger an immediate tick (e.g., from API refresh endpoint).
   * Uses a lock to prevent concurrent tick execution.
   * Returns true if a tick was executed, false if one was already in progress.
   */
  async triggerTick(): Promise<boolean> {
    if (this.tickInProgress) return false;
    this.tickInProgress = true;
    try {
      await tick(this.deps);
    } finally {
      this.tickInProgress = false;
    }
    return true;
  }
}
