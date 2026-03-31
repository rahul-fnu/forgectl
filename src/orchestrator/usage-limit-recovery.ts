import type { OrchestratorState, WorkerInfo } from "./state.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { DetectionResult } from "../agent/usage-limit-detector.js";
import { emitRunEvent } from "../logging/events.js";
import { releaseIssue } from "./state.js";

export interface UsageLimitRecoveryConfig {
  cooldownMinutes: number;
  probeEnabled: boolean;
  probeIntervalMinutes: number;
  maxResumes: number;
}

interface PausedTask {
  issueId: string;
  identifier: string;
  resumeCount: number;
  pausedAt: number;
}

/**
 * Manages the full usage limit recovery lifecycle:
 * detection → kill → re-queue → cooldown → probe → restart.
 *
 * Cooldown state and resume counts survive daemon restart via the
 * runs table (pauseContext stores the serialized recovery state).
 */
export class UsageLimitRecovery {
  private config: UsageLimitRecoveryConfig;
  private pausedTasks: Map<string, PausedTask> = new Map();
  private cooldownUntil: number | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private logger: Logger,
    config: UsageLimitRecoveryConfig,
  ) {
    this.config = config;
  }

  /**
   * Restore cooldown state from persisted runs on daemon startup.
   * Finds runs paused with reason "usage_limit" and re-populates in-memory state.
   */
  restoreFromDatabase(runRepo: RunRepository): void {
    const waitingRuns = runRepo.findByStatus("waiting_for_input");
    for (const run of waitingRuns) {
      if (run.pauseReason !== "usage_limit") continue;
      const ctx = run.pauseContext as { resumeCount?: number; cooldownUntil?: number; pausedAt?: number } | null;
      this.pausedTasks.set(run.id, {
        issueId: run.id,
        identifier: run.task,
        resumeCount: ctx?.resumeCount ?? 0,
        pausedAt: ctx?.pausedAt ?? Date.now(),
      });
      if (ctx?.cooldownUntil && (!this.cooldownUntil || ctx.cooldownUntil > this.cooldownUntil)) {
        this.cooldownUntil = ctx.cooldownUntil;
      }
    }
    if (this.pausedTasks.size > 0) {
      this.logger.info("usage-limit", `Restored ${this.pausedTasks.size} paused tasks from database`);
      if (this.cooldownUntil && this.cooldownUntil > Date.now()) {
        this.logger.info("usage-limit", `Cooldown active until ${new Date(this.cooldownUntil).toISOString()}`);
      }
    }
  }

  /**
   * Handle a usage limit detection: pause all running tasks, start cooldown.
   *
   * Called by the dispatcher when any worker throws UsageLimitError.
   */
  async handleUsageLimitHit(
    detection: DetectionResult,
    triggeringIssueId: string,
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): Promise<void> {
    const now = Date.now();
    this.cooldownUntil = now + this.config.cooldownMinutes * 60_000;

    this.logger.warn("usage-limit", `Usage limit detected: ${detection.reason}. Pausing all tasks. Cooldown until ${new Date(this.cooldownUntil).toISOString()}`);

    // Emit detection event
    emitRunEvent({
      runId: triggeringIssueId,
      type: "usage_limit_detected",
      timestamp: new Date().toISOString(),
      data: {
        reason: detection.reason,
        matchedPattern: detection.matchedPattern,
        cooldownUntil: new Date(this.cooldownUntil).toISOString(),
      },
    });

    // Kill all running tasks (including the triggering one)
    const allRunning = new Map(state.running);
    for (const [issueId, worker] of allRunning) {
      await this.pauseTask(issueId, worker, detection, state, tracker, config, runRepo);
    }

    // Start probe cycle if enabled
    if (this.config.probeEnabled) {
      this.scheduleProbe(state, tracker, config, runRepo);
    }
  }

  private async pauseTask(
    issueId: string,
    worker: WorkerInfo,
    detection: DetectionResult,
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): Promise<void> {
    const existing = this.pausedTasks.get(issueId);
    const resumeCount = existing ? existing.resumeCount + 1 : 0;
    const now = Date.now();

    // Check if max resumes exceeded
    if (resumeCount >= this.config.maxResumes) {
      await this.failTask(issueId, worker.identifier, resumeCount, state, tracker, config, runRepo);
      return;
    }

    this.pausedTasks.set(issueId, {
      issueId,
      identifier: worker.identifier,
      resumeCount,
      pausedAt: now,
    });

    // Remove from running
    state.running.delete(issueId);

    // Persist pause state to database
    if (runRepo) {
      try {
        runRepo.updateStatus(issueId, {
          status: "waiting_for_input",
          pauseReason: "usage_limit",
          pauseContext: {
            resumeCount,
            cooldownUntil: this.cooldownUntil,
            pausedAt: now,
            detection: { reason: detection.reason, matchedPattern: detection.matchedPattern },
          },
        });
      } catch {
        // Run record may not exist for this issueId; best-effort
      }
    }

    // Emit paused event
    emitRunEvent({
      runId: issueId,
      type: "usage_limit_paused",
      timestamp: new Date().toISOString(),
      data: {
        identifier: worker.identifier,
        resumeCount,
        cooldownMinutes: this.config.cooldownMinutes,
      },
    });

    // Post Linear comment
    const commentsEnabled = config.tracker?.comments_enabled !== false;
    if (commentsEnabled) {
      const comment = formatUsageLimitPausedComment(
        worker.identifier,
        detection,
        resumeCount,
        this.config.maxResumes,
        this.config.cooldownMinutes,
      );
      tracker.postComment(issueId, comment).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("usage-limit", `Failed to post pause comment for ${worker.identifier}: ${msg}`);
      });
    }

    this.logger.info("usage-limit", `Paused ${worker.identifier} (resume ${resumeCount}/${this.config.maxResumes})`);
  }

  private async failTask(
    issueId: string,
    identifier: string,
    resumeCount: number,
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): Promise<void> {
    // Remove from paused tasks and running
    this.pausedTasks.delete(issueId);
    state.running.delete(issueId);
    releaseIssue(state, issueId);

    // Mark as failed in database
    if (runRepo) {
      try {
        runRepo.updateStatus(issueId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: `Usage limit: max resumes (${this.config.maxResumes}) exhausted`,
        });
        runRepo.clearPauseContext(issueId);
      } catch {
        // best-effort
      }
    }

    // Emit failed event
    emitRunEvent({
      runId: issueId,
      type: "usage_limit_failed",
      timestamp: new Date().toISOString(),
      data: { identifier, resumeCount, maxResumes: this.config.maxResumes },
    });

    // Post Linear comment
    const commentsEnabled = config.tracker?.comments_enabled !== false;
    if (commentsEnabled) {
      const comment = formatUsageLimitFailedComment(identifier, resumeCount, this.config.maxResumes);
      tracker.postComment(issueId, comment).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("usage-limit", `Failed to post failure comment for ${identifier}: ${msg}`);
      });
    }

    this.logger.warn("usage-limit", `Failed ${identifier}: max resumes (${this.config.maxResumes}) exhausted`);
  }

  /**
   * Schedule a probe to check if the usage limit has cleared.
   */
  private scheduleProbe(
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): void {
    this.clearTimers();

    const now = Date.now();
    const cooldownRemaining = (this.cooldownUntil ?? now) - now;
    const probeDelay = Math.max(cooldownRemaining, this.config.probeIntervalMinutes * 60_000);

    emitRunEvent({
      runId: "orchestrator",
      type: "usage_limit_cooldown",
      timestamp: new Date().toISOString(),
      data: {
        cooldownUntil: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
        probeScheduledAt: new Date(now + probeDelay).toISOString(),
        pausedTaskCount: this.pausedTasks.size,
      },
    });

    this.probeTimer = setTimeout(() => {
      void this.runProbe(state, tracker, config, runRepo);
    }, probeDelay);
  }

  /**
   * Run a lightweight probe to check if the usage limit has cleared.
   * The probe is a no-op check — the real validation happens when
   * the first task is restarted. If it hits the limit again, the
   * cycle repeats.
   */
  private async runProbe(
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): Promise<void> {
    this.logger.info("usage-limit", "Running usage limit probe...");

    emitRunEvent({
      runId: "orchestrator",
      type: "usage_limit_probe",
      timestamp: new Date().toISOString(),
      data: { pausedTaskCount: this.pausedTasks.size },
    });

    // Cooldown has elapsed — attempt to restart tasks one at a time
    if (this.pausedTasks.size === 0) {
      this.logger.info("usage-limit", "No paused tasks to restart");
      this.cooldownUntil = null;
      return;
    }

    await this.restartPausedTasks(state, tracker, config, runRepo);
  }

  /**
   * Restart paused tasks one at a time with a delay between each.
   * Re-queues them by releasing from claimed state so the
   * dispatcher picks them up on the next poll cycle.
   */
  private async restartPausedTasks(
    state: OrchestratorState,
    tracker: TrackerAdapter,
    config: ForgectlConfig,
    runRepo?: RunRepository,
  ): Promise<void> {
    const tasks = [...this.pausedTasks.values()];
    const delay = (config.orchestrator?.continuation_delay_ms ?? 1000) * 2;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];

      // Clear pause state in database
      if (runRepo) {
        try {
          runRepo.updateStatus(task.issueId, { status: "queued" });
          runRepo.clearPauseContext(task.issueId);
        } catch {
          // best-effort
        }
      }

      // Release from claimed so dispatcher re-dispatches
      releaseIssue(state, task.issueId);
      this.pausedTasks.delete(task.issueId);

      // Emit restarted event
      emitRunEvent({
        runId: task.issueId,
        type: "usage_limit_restarted",
        timestamp: new Date().toISOString(),
        data: { identifier: task.identifier, resumeCount: task.resumeCount },
      });

      // Post Linear comment
      const commentsEnabled = config.tracker?.comments_enabled !== false;
      if (commentsEnabled) {
        const comment = formatUsageLimitRestartedComment(task.identifier, task.resumeCount, this.config.maxResumes);
        tracker.postComment(task.issueId, comment).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn("usage-limit", `Failed to post restart comment for ${task.identifier}: ${msg}`);
        });
      }

      this.logger.info("usage-limit", `Restarted ${task.identifier} (resume ${task.resumeCount}/${this.config.maxResumes})`);

      // Delay between restarts to avoid immediately hitting the limit again
      if (i < tasks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.cooldownUntil = null;
  }

  /**
   * Returns true if the system is currently in cooldown.
   */
  isInCooldown(): boolean {
    return this.cooldownUntil !== null && Date.now() < this.cooldownUntil;
  }

  /**
   * Returns the number of tasks currently paused due to usage limits.
   */
  pausedCount(): number {
    return this.pausedTasks.size;
  }

  /**
   * Returns the cooldown-until timestamp, or null if not in cooldown.
   */
  getCooldownUntil(): number | null {
    return this.cooldownUntil;
  }

  /**
   * Returns the resume count for a given issue, or 0 if not paused.
   */
  getResumeCount(issueId: string): number {
    return this.pausedTasks.get(issueId)?.resumeCount ?? 0;
  }

  /**
   * Clean up timers on shutdown.
   */
  close(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}

/**
 * Create a UsageLimitRecovery instance from config.
 */
export function createUsageLimitRecovery(
  config: ForgectlConfig,
  logger: Logger,
): UsageLimitRecovery | null {
  const ulConfig = config.agent.usage_limit;
  if (!ulConfig.enabled) return null;

  return new UsageLimitRecovery(logger, {
    cooldownMinutes: ulConfig.cooldown_minutes,
    probeEnabled: ulConfig.probe_enabled,
    probeIntervalMinutes: ulConfig.probe_interval_minutes,
    maxResumes: ulConfig.max_resumes,
  });
}

// --- Linear comment formatters ---

export function formatUsageLimitPausedComment(
  identifier: string,
  detection: DetectionResult,
  resumeCount: number,
  maxResumes: number,
  cooldownMinutes: number,
): string {
  const lines = [
    `⏸️ **forgectl:** Task \`${identifier}\` paused — usage limit detected`,
    "",
    `**Reason:** ${detection.reason}${detection.matchedPattern ? ` (matched: "${detection.matchedPattern}")` : ""}`,
    `**Resume count:** ${resumeCount}/${maxResumes}`,
    `**Cooldown:** ${cooldownMinutes} minutes`,
    "",
    "Task will automatically restart after cooldown and probe succeed.",
  ];
  return lines.join("\n");
}

export function formatUsageLimitRestartedComment(
  identifier: string,
  resumeCount: number,
  maxResumes: number,
): string {
  const lines = [
    `▶️ **forgectl:** Task \`${identifier}\` restarted after usage limit cooldown`,
    "",
    `**Resume count:** ${resumeCount}/${maxResumes}`,
  ];
  return lines.join("\n");
}

export function formatUsageLimitFailedComment(
  identifier: string,
  resumeCount: number,
  maxResumes: number,
): string {
  const lines = [
    `❌ **forgectl:** Task \`${identifier}\` failed — max resumes exhausted`,
    "",
    `**Resume attempts:** ${resumeCount}/${maxResumes}`,
    "",
    "The task has been paused too many times due to usage limits and has been marked as failed.",
    "Consider upgrading your plan or waiting for the limit to reset.",
  ];
  return lines.join("\n");
}
