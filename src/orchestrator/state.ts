import type { TrackerIssue } from "../tracker/types.js";
import type { AgentSession } from "../agent/session.js";
import type { CleanupContext } from "../container/cleanup.js";

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
  session: AgentSession | null;
  cleanup: CleanupContext;
  startedAt: number;
  lastActivityAt: number;
  attempt: number;
  slotWeight: number; // 1 for solo runs, team.size for team runs
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
   * Uses weight summation so team runs (slotWeight > 1) consume proportional slots.
   */
  availableSlots(running: Map<string, WorkerInfo>): number {
    const usedWeight = [...running.values()].reduce(
      (sum, w) => sum + w.slotWeight,
      0,
    );
    return Math.max(0, this.maxConcurrent - usedWeight);
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
