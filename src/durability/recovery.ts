import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import { loadLatestCheckpoint, type CheckpointState } from "./checkpoint.js";

export interface RecoveryResult {
  runId: string;
  action: "resumed_from_workspace" | "resumed_rerun_agent" | "marked_interrupted";
  reason: string;
  resumePhase?: CheckpointState["phase"];
  workspacePath?: string;
  recovered?: boolean;
}

/**
 * Check if a workspace directory has agent commits beyond the initial clone.
 * Returns true if there are commits that aren't the initial setup.
 */
function workspaceHasAgentCommits(workspacePath: string): boolean {
  try {
    // Count commits: if more than 1, agent made changes
    const result = execSync("git rev-list --count HEAD", {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseInt(result, 10) > 1;
  } catch {
    return false;
  }
}

/**
 * Recover interrupted runs on daemon startup.
 *
 * Finds all runs with status "running" (which must be leftovers from a
 * previous daemon instance that crashed) and determines the best recovery
 * strategy based on workspace state:
 *
 * 1. If workspace exists with agent commits: skip to validation/output phase
 * 2. If workspace exists without commits: re-run agent with existing workspace
 * 3. If workspace gone: mark as interrupted (current behavior)
 */
export function recoverInterruptedRuns(
  runRepo: RunRepository,
  snapshotRepo: SnapshotRepository,
): RecoveryResult[] {
  const running = runRepo.findByStatus("running");
  const results: RecoveryResult[] = [];

  for (const run of running) {
    const checkpoint = loadLatestCheckpoint(snapshotRepo, run.id);
    const workspacePath = checkpoint?.workspacePath;

    // Check if workspace still exists on disk
    const workspaceExists = workspacePath ? existsSync(workspacePath) : false;
    const isGitRepo = workspaceExists ? existsSync(join(workspacePath!, ".git")) : false;

    if (workspaceExists && isGitRepo && workspacePath) {
      const hasCommits = workspaceHasAgentCommits(workspacePath);

      if (hasCommits && checkpoint && (checkpoint.phase === "execute" || checkpoint.phase === "validate")) {
        // Agent finished (or was validating) — skip to validation/output
        const reason = `Run interrupted at ${checkpoint.phase} phase. Resuming from checkpoint with existing workspace (agent commits found).`;
        runRepo.updateStatus(run.id, {
          status: "queued",
          completedAt: undefined,
          error: undefined,
        });
        results.push({
          runId: run.id,
          action: "resumed_from_workspace",
          reason,
          resumePhase: checkpoint.phase === "execute" ? "validate" : "output",
          workspacePath,
          recovered: true,
        });
      } else {
        // Workspace exists but no agent commits — re-run agent with existing workspace
        const phase = checkpoint?.phase ?? "unknown";
        const reason = `Run interrupted at ${phase} phase. Resuming with existing workspace (no agent commits, will re-run agent).`;
        runRepo.updateStatus(run.id, {
          status: "queued",
          completedAt: undefined,
          error: undefined,
        });
        results.push({
          runId: run.id,
          action: "resumed_rerun_agent",
          reason,
          resumePhase: "execute",
          workspacePath,
          recovered: true,
        });
      }
    } else {
      // No workspace — mark as interrupted (original behavior)
      const reason = checkpoint
        ? `Interrupted after ${checkpoint.phase} phase. Workspace not found — cannot resume.`
        : "Daemon crashed before any checkpoint was saved";

      runRepo.updateStatus(run.id, {
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: reason,
      });

      results.push({ runId: run.id, action: "marked_interrupted", reason });
    }
  }

  return results;
}
