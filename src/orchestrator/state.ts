import type { TrackerIssue } from "../tracker/types.js";
import type { AgentSession } from "../agent/session.js";
import type { CleanupContext } from "../container/cleanup.js";
import type { OrchestratorConfig } from "../config/schema.js";

/**
 * Possible states for an issue within the orchestrator lifecycle.
 */
export type IssueState = "claimed" | "running" | "retry_queued" | "released";

/**
 * Information about an active worker processing an issue.
 */
export interface WorkerInfo {
  issueId: string;
  identifier: string;
  issue: TrackerIssue;
  session: AgentSession;
  cleanup: CleanupContext;
  startedAt: number;
  lastActivityAt: number;
  attempt: number;
}

/**
 * Mutable orchestrator state — tracks claimed issues, running workers,
 * retry timers, and retry attempt counts.
 */
export interface OrchestratorState {
  claimed: Set<string>;
  running: Map<string, WorkerInfo>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  retryAttempts: Map<string, number>;
}

/**
 * Create a fresh orchestrator state with empty collections.
 */
export function createState(): OrchestratorState {
  return {
    claimed: new Set(),
    running: new Map(),
    retryTimers: new Map(),
    retryAttempts: new Map(),
  };
}

/**
 * Claim an issue for processing.
 * Returns true if newly claimed, false if already claimed (duplicate prevention).
 */
export function claimIssue(state: OrchestratorState, issueId: string): boolean {
  if (state.claimed.has(issueId)) {
    return false;
  }
  state.claimed.add(issueId);
  return true;
}

/**
 * Release an issue — removes from claimed set, running map, retry attempts,
 * and cancels any pending retry timer.
 */
export function releaseIssue(state: OrchestratorState, issueId: string): void {
  state.claimed.delete(issueId);
  state.running.delete(issueId);
  state.retryAttempts.delete(issueId);

  const timer = state.retryTimers.get(issueId);
  if (timer !== undefined) {
    clearTimeout(timer);
    state.retryTimers.delete(issueId);
  }
}

/**
 * Manages concurrency slots for the orchestrator.
 * Tracks how many workers can run simultaneously.
 */
export class SlotManager {
  private maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Returns the number of available slots given the current running workers.
   */
  availableSlots(running: Map<string, WorkerInfo>): number {
    return Math.max(0, this.maxConcurrent - running.size);
  }

  /**
   * Returns true if there are available slots for new workers.
   */
  hasAvailableSlots(running: Map<string, WorkerInfo>): boolean {
    return this.availableSlots(running) > 0;
  }

  /**
   * Returns the maximum concurrent slots.
   */
  getMax(): number {
    return this.maxConcurrent;
  }

  /**
   * Update the maximum concurrent slots at runtime.
   */
  setMax(n: number): void {
    this.maxConcurrent = n;
  }
}

/**
 * Two-tier slot manager that separates top-level issues from child delegations.
 * Top-level slots are for issues dispatched by the tracker poller.
 * Child slots are for subtasks spawned by delegation manifests.
 */
export class TwoTierSlotManager {
  private topLevelMax: number;
  private childMax: number;
  private topLevelRunning: Map<string, WorkerInfo> = new Map();
  private childRunning: Map<string, WorkerInfo> = new Map();

  constructor(topLevelMax: number, childMax: number) {
    this.topLevelMax = topLevelMax;
    this.childMax = childMax;
  }

  /**
   * Returns true when delegation is enabled (childMax > 0).
   */
  isDelegationEnabled(): boolean {
    return this.childMax > 0;
  }

  /**
   * Returns true when there is at least one available top-level slot.
   */
  hasTopLevelSlot(): boolean {
    return this.topLevelRunning.size < this.topLevelMax;
  }

  /**
   * Returns true when there is at least one available child slot.
   */
  hasChildSlot(): boolean {
    return this.childMax > 0 && this.childRunning.size < this.childMax;
  }

  /**
   * Returns the number of available top-level slots (clamped to 0).
   */
  availableTopLevelSlots(): number {
    return Math.max(0, this.topLevelMax - this.topLevelRunning.size);
  }

  /**
   * Returns the number of available child slots (clamped to 0).
   */
  availableChildSlots(): number {
    return Math.max(0, this.childMax - this.childRunning.size);
  }

  /**
   * Register a top-level worker for the given issue ID.
   */
  registerTopLevel(id: string, info: WorkerInfo): void {
    this.topLevelRunning.set(id, info);
  }

  /**
   * Release a top-level worker by issue ID.
   */
  releaseTopLevel(id: string): void {
    this.topLevelRunning.delete(id);
  }

  /**
   * Register a child worker for the given task ID.
   */
  registerChild(id: string, info: WorkerInfo): void {
    this.childRunning.set(id, info);
  }

  /**
   * Release a child worker by task ID.
   */
  releaseChild(id: string): void {
    this.childRunning.delete(id);
  }

  /**
   * Returns the top-level running map for inspection.
   */
  getTopLevelRunning(): Map<string, WorkerInfo> {
    return this.topLevelRunning;
  }

  /**
   * Returns the child running map for inspection.
   */
  getChildRunning(): Map<string, WorkerInfo> {
    return this.childRunning;
  }

  /**
   * Returns total max slots (topLevelMax + childMax) for backward compatibility.
   */
  getMax(): number {
    return this.topLevelMax + this.childMax;
  }
}

/**
 * Factory that creates a TwoTierSlotManager from OrchestratorConfig.
 * childSlots = config.child_slots (default 0)
 * topLevelMax = Math.max(1, config.max_concurrent_agents - childSlots)
 */
export function createTwoTierSlotManager(
  config: OrchestratorConfig,
): TwoTierSlotManager {
  const childSlots = config.child_slots ?? 0;
  const topLevelMax = Math.max(1, config.max_concurrent_agents - childSlots);
  return new TwoTierSlotManager(topLevelMax, childSlots);
}
