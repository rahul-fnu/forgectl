import type { WorkerInfo, SlotManager } from "./state.js";

/**
 * Per-issue metrics entry tracking tokens, runtime, and retry stats.
 */
export interface IssueMetrics {
  issueId: string;
  identifier: string;
  tokens: { input: number; output: number; total: number };
  runtimeMs: number;
  attempts: number;
  lastAttemptAt: number;
  status: "running" | "completed" | "failed";
}

/**
 * Snapshot of all metrics at a point in time.
 */
export interface MetricsSnapshot {
  uptimeMs: number;
  active: IssueMetrics[];
  completed: IssueMetrics[];
  totals: {
    dispatched: number;
    completed: number;
    failed: number;
    tokens: { input: number; output: number; total: number };
  };
}

/**
 * Collects per-issue and aggregate metrics for the orchestrator.
 * Maintains a bounded buffer of completed entries to prevent unbounded memory growth.
 */
export class MetricsCollector {
  private active = new Map<string, IssueMetrics>();
  private completedBuffer: IssueMetrics[] = [];
  private readonly maxCompleted: number;
  private startedAt = Date.now();
  private totals = {
    dispatched: 0,
    completed: 0,
    failed: 0,
    tokens: { input: 0, output: 0, total: 0 },
  };

  constructor(maxCompleted = 100) {
    this.maxCompleted = maxCompleted;
  }

  /**
   * Record a new issue dispatch. Creates an active entry with zero tokens/runtime.
   */
  recordDispatch(issueId: string, identifier: string): void {
    this.active.set(issueId, {
      issueId,
      identifier,
      tokens: { input: 0, output: 0, total: 0 },
      runtimeMs: 0,
      attempts: 1,
      lastAttemptAt: Date.now(),
      status: "running",
    });
    this.totals.dispatched++;
  }

  /**
   * Record issue completion (success or failure).
   * Moves from active to completed buffer, updates aggregate totals.
   * No-op if issueId is not in active map.
   */
  recordCompletion(
    issueId: string,
    tokens: { input: number; output: number; total: number },
    runtimeMs: number,
    status: "completed" | "failed",
  ): void {
    const entry = this.active.get(issueId);
    if (!entry) return;

    entry.tokens = tokens;
    entry.runtimeMs = runtimeMs;
    entry.status = status;

    this.active.delete(issueId);
    this.completedBuffer.push(entry);

    // Evict oldest if buffer exceeded
    if (this.completedBuffer.length > this.maxCompleted) {
      this.completedBuffer.shift();
    }

    // Update aggregate totals
    if (status === "completed") {
      this.totals.completed++;
    } else {
      this.totals.failed++;
    }
    this.totals.tokens.input += tokens.input;
    this.totals.tokens.output += tokens.output;
    this.totals.tokens.total += tokens.total;
  }

  /**
   * Record a retry attempt for an active issue.
   */
  recordRetry(issueId: string): void {
    const entry = this.active.get(issueId);
    if (!entry) return;
    entry.attempts++;
    entry.lastAttemptAt = Date.now();
  }

  /**
   * Get a snapshot of all metrics.
   */
  getSnapshot(): MetricsSnapshot {
    return {
      uptimeMs: Date.now() - this.startedAt,
      active: [...this.active.values()],
      completed: [...this.completedBuffer],
      totals: { ...this.totals, tokens: { ...this.totals.tokens } },
    };
  }

  /**
   * Get metrics for a specific issue. Checks active first, then completed.
   */
  getIssueMetrics(issueId: string): IssueMetrics | undefined {
    const active = this.active.get(issueId);
    if (active) return active;
    return this.completedBuffer.find((e) => e.issueId === issueId);
  }

  /**
   * Get slot utilization info.
   */
  getSlotUtilization(
    running: Map<string, WorkerInfo>,
    slotManager: SlotManager,
  ): { active: number; max: number } {
    return {
      active: running.size,
      max: slotManager.getMax(),
    };
  }
}
