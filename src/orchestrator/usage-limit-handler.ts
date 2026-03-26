import type { OrchestratorState } from "./state.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { Logger } from "../logging/logger.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { emitRunEvent } from "../logging/events.js";

export async function handleUsageLimitDetected(
  state: OrchestratorState,
  tracker: TrackerAdapter,
  logger: Logger,
  config: ForgectlConfig,
  runRepo?: RunRepository,
): Promise<void> {
  emitRunEvent({
    runId: "orchestrator",
    type: "usage_limit_detected",
    timestamp: new Date().toISOString(),
    data: { runningCount: state.running.size },
  });

  const cooldownMinutes = (config as Record<string, unknown>).cooldown_minutes as number | undefined ?? 60;
  const resumeAfter = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();

  const entries = [...state.running.entries()];
  for (const [issueId, workerInfo] of entries) {
    // a. Kill the agent session
    if (workerInfo.session) {
      try {
        await workerInfo.session.close();
      } catch {
        // best-effort
      }
    }

    // b. Stop and remove the Docker container
    if (workerInfo.cleanup.container) {
      try {
        await workerInfo.cleanup.container.stop({ t: 5 });
      } catch {
        // may already be stopped
      }
      try {
        await workerInfo.cleanup.container.remove({ force: true });
      } catch {
        // best-effort
      }
    }

    // c+d. Mark run as paused_usage_limit with resume_after
    const runId = (workerInfo as unknown as Record<string, unknown>).runId as string | undefined;
    if (runRepo && runId) {
      runRepo.updateStatus(runId, {
        status: "paused_usage_limit",
        resumeAfter,
      });
    }

    // e. Clean up workspace directory
    for (const dir of workerInfo.cleanup.tempDirs) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    // f. Post a comment on the issue
    try {
      await tracker.postComment(
        workerInfo.issue.id,
        "Run paused — Claude Code usage limit reached. Task re-queued and will restart automatically when the limit resets.",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("usage-limit", `Failed to post comment on ${workerInfo.identifier}: ${msg}`);
    }

    // g. Remove from state
    state.running.delete(issueId);
    state.claimed.delete(issueId);

    logger.info("usage-limit", `Killed container and paused run for ${workerInfo.identifier}`);
  }

  emitRunEvent({
    runId: "orchestrator",
    type: "orchestrator_cooldown_entered",
    timestamp: new Date().toISOString(),
    data: { resumeAfter, killedCount: entries.length },
  });

  logger.info("usage-limit", `Cooldown entered — ${entries.length} containers killed, resume after ${resumeAfter}`);
}
