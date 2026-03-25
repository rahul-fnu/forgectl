import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { OrchestratorState, TwoTierSlotManager } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { Logger } from "../logging/logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import type { RetryRepository } from "../storage/repositories/retries.js";
import type { AutonomyLevel, AutoApproveRule } from "../governance/types.js";
import type { IssueContext, RepoContext } from "../github/types.js";
import type { GitHubDeps } from "./worker.js";
import type { ContextResult } from "../context/builder.js";
import type { DelegationManager } from "./delegation.js";
import type { SubIssueCache } from "../tracker/sub-issue-cache.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { EventRepository } from "../storage/repositories/events.js";
import { claimIssue, releaseIssue } from "./state.js";
import { classifyFailure, calculateBackoff, scheduleRetry, cleanupRetryRecords } from "./retry.js";
import { executeWorker } from "./worker.js";
import { createProgressComment } from "../github/comments.js";
import { serializeReviewOutput } from "../validation/review-agent.js";
import { emitRunEvent } from "../logging/events.js";
import { needsPreApproval } from "../governance/autonomy.js";
import { triageIssue } from "./triage.js";
import { enterPendingApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";
import {
  upsertRollupComment,
  buildSubIssueProgressComment,
  allChildrenTerminal,
} from "../github/sub-issue-rollup.js";
import {
  parseAgentAccessedFiles,
  computeContextFeedback,
  recordContextFeedback,
} from "../context/learning.js";
import { buildRichPRBody } from "../github/pr-description.js";
import { formatRunComment, shouldPostComment } from "../tracker/linear-comments.js";
import type { RunCommentData } from "../tracker/linear-comments.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Extract a GitHub repo slug from an issue description.
 * Looks for patterns like "**Repo:** https://github.com/owner/name" or "github.com/owner/name".
 * Returns "owner/name" or null.
 */
export function extractRepoFromIssue(issue: TrackerIssue): string | null {
  const text = issue.description ?? "";
  // Match **Repo:** https://github.com/owner/name or just github.com/owner/name
  const match = text.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (match) return match[1].replace(/\.git$/, "");
  return null;
}

/**
 * Load a repo profile overlay if one exists for the given repo slug.
 * Returns the profile-specific config fields (workspace hooks, tracker.repo, validation).
 */
export async function loadRepoOverlay(repoSlug: string): Promise<Partial<ForgectlConfig> | null> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  // Try repo name (after /) as profile name
  const repoName = repoSlug.split("/")[1];
  const profilePath = join(home, ".forgectl", "repos", `${repoName}.yaml`);
  if (!existsSync(profilePath)) return null;

  try {
    const { loadRepoProfile } = await import("../config/loader.js");
    return loadRepoProfile(repoName) as Partial<ForgectlConfig>;
  } catch {
    return null;
  }
}

/** GitHub context passed from webhook handler (octokit + repo). */
export interface GitHubContext {
  octokit: unknown;
  /** Separate octokit with PR write permissions (e.g. merger app). Falls back to octokit if not set. */
  prOctokit?: unknown;
  repo: RepoContext;
}

/** Optional outcome logging dependencies. */
export interface OutcomeDeps {
  outcomeRepo: OutcomeRepository;
  eventRepo?: EventRepository;
  snapshotRepo?: import("../storage/repositories/snapshots.js").SnapshotRepository;
}

/** Optional governance context for pre-execution approval gate. */
export interface GovernanceOpts {
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  runRepo?: RunRepository;
  runId?: string;
  costRepo?: CostRepository;
  retryRepo?: RetryRepository;
}

/**
 * Extract a numeric priority from issue priority field and labels.
 * Supports P0-P4 labels, priority:critical/high/medium/low labels, and numeric priority field.
 * Returns Infinity if no priority can be determined.
 */
export function extractPriorityNumber(priority: string | null, labels: string[]): number {
  // Check direct priority field (numeric string)
  if (priority !== null && priority !== "") {
    const parsed = Number(priority);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  // Check labels for P0/P1/P2/P3/P4 pattern
  for (const label of labels) {
    const pMatch = /^P(\d)$/i.exec(label);
    if (pMatch) {
      return Number(pMatch[1]);
    }
  }

  // Check labels for priority:critical/high/medium/low pattern
  const priorityMap: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  for (const label of labels) {
    const colonMatch = /^priority:(\w+)$/i.exec(label);
    if (colonMatch) {
      const level = colonMatch[1].toLowerCase();
      if (level in priorityMap) {
        return priorityMap[level];
      }
    }
  }

  return Infinity;
}

/**
 * Filter candidate issues by excluding those that are:
 * - Already claimed
 * - Already running
 * - Blocked by non-terminal issues
 */
export function filterCandidates(
  candidates: TrackerIssue[],
  state: OrchestratorState,
  terminalIssueIds: Set<string>,
  doneLabel?: string,
): TrackerIssue[] {
  return candidates.filter((issue) => {
    // Exclude recently completed issues (guards against re-dispatch before tracker API reflects Done)
    if (state.recentlyCompleted.has(issue.id)) return false;

    // Exclude already claimed
    if (state.claimed.has(issue.id)) return false;

    // Exclude already running
    if (state.running.has(issue.id)) return false;

    // Exclude issues already marked as done
    if (doneLabel && issue.labels.includes(doneLabel)) return false;

    // Exclude if any blocker is not terminal
    if (issue.blocked_by.length > 0) {
      const allBlockersTerminal = issue.blocked_by.every((blockerId) =>
        terminalIssueIds.has(blockerId),
      );
      if (!allBlockersTerminal) return false;
    }

    return true;
  });
}

/**
 * Sort candidate issues by priority (ascending), then by created_at (oldest first),
 * then by identifier (alphabetical) as final tiebreaker.
 */
export function sortCandidates(issues: TrackerIssue[]): TrackerIssue[] {
  return [...issues].sort((a, b) => {
    const priorityA = extractPriorityNumber(a.priority, a.labels);
    const priorityB = extractPriorityNumber(b.priority, b.labels);

    if (priorityA !== priorityB) return priorityA - priorityB;

    // Tiebreak by created_at (oldest first)
    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    if (timeA !== timeB) return timeA - timeB;

    // Final tiebreak by identifier
    return a.identifier.localeCompare(b.identifier);
  });
}

/**
 * Trigger a rollup comment update on the parent issue after a child issue completes.
 *
 * Finds the parent via SubIssueCache.getAllEntries() scan, builds ChildStatus[] from
 * cached childStates, and calls upsertRollupComment. If all children are terminal,
 * adds the forge:synthesize label to the parent.
 *
 * All errors are caught, warned, and swallowed — this never throws.
 */
export async function triggerParentRollup(
  childIssue: TrackerIssue,
  subIssueCache: SubIssueCache,
  tracker: TrackerAdapter,
  githubContext: GitHubContext,
  config: ForgectlConfig,
  logger: Logger,
): Promise<void> {
  const { owner, repo } = githubContext.repo;

  // Find the parent entry by scanning all cache entries
  const allEntries = subIssueCache.getAllEntries();
  const parentEntry = allEntries.find((entry) => entry.childIds.includes(childIssue.id));

  if (!parentEntry) {
    // Not a sub-issue or not in cache — silently skip
    return;
  }

  // Update child state in-place to reflect completion
  parentEntry.childStates.set(childIssue.id, "closed");

  try {
    // Build ChildStatus[] from entry
    const children = parentEntry.childIds.map((childId) => {
      const rawState = parentEntry.childStates.get(childId) ?? "open";
      const mappedState: "completed" | "pending" =
        rawState === "closed" ? "completed" : "pending";
      const url = `https://github.com/${owner}/${repo}/issues/${childId}`;
      const title = childId === childIssue.id ? childIssue.title : `#${childId}`;
      return { id: childId, title, url, state: mappedState };
    });

    const parentIssueNumber = Number(parentEntry.parentId);
    const body = buildSubIssueProgressComment(parentIssueNumber, children);
    await upsertRollupComment(githubContext.octokit as any, owner, repo, parentIssueNumber, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("dispatcher", `Failed to upsert rollup comment for parent ${parentEntry.parentId}: ${msg}`);
    return;
  }

  // Check if all children are now terminal
  const terminalStates = new Set(config.tracker?.terminal_states ?? ["closed"]);
  const allTerminal = allChildrenTerminal(parentEntry.childStates, terminalStates);

  if (allTerminal) {
    // Auto-close the parent epic — all sub-issues are done
    logger.info("dispatcher", `All sub-issues complete for parent #${parentEntry.parentId}, auto-closing`);
    tracker
      .updateState(parentEntry.parentId, "closed")
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to auto-close parent ${parentEntry.parentId}: ${msg}`);
      });
    if (config.tracker?.comments_enabled !== false) {
      tracker
        .postComment(parentEntry.parentId, `All sub-issues completed. Auto-closing.`)
        .catch(() => { /* best-effort */ });
    }
  }
}

/**
 * Handle the synthesizer outcome for an issue tagged with forge:synthesize.
 *
 * Success: closes the issue and removes the forge:synthesize label (best-effort).
 * Failure: posts an error comment but does NOT close the issue (parent remains open).
 *
 * All tracker calls are fire-and-forget (.catch()), never throwing.
 */
export function handleSynthesizerOutcome(
  issue: TrackerIssue,
  outcome: "success" | "failure",
  tracker: TrackerAdapter,
  logger: Logger,
  commentsEnabled = true,
): void {
  if (outcome === "success") {
    tracker.updateState(issue.id, "closed").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to close synthesizer parent ${issue.identifier}: ${msg}`);
    });
    tracker.updateLabels(issue.id, [], ["forge:synthesize"]).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to remove forge:synthesize label for ${issue.identifier}: ${msg}`);
    });
  } else if (commentsEnabled) {
    tracker
      .postComment(
        issue.id,
        `Synthesizer run failed for ${issue.identifier}. Parent issue remains open.`,
      )
      .catch(() => {});
  }
}

/**
 * Dispatch an issue: claim it, start a worker in the background,
 * and handle completion with retry logic.
 */
export function dispatchIssue(
  issue: TrackerIssue,
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  logger: Logger,
  metrics: MetricsCollector,
  governance?: GovernanceOpts,
  githubContext?: GitHubContext,
  delegationManager?: DelegationManager,
  subIssueCache?: SubIssueCache,
  skills?: string[],
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string },
  outcomeDeps?: OutcomeDeps,
  kgContext?: ContextResult,
  promotedFindings?: import("../storage/repositories/review-findings.js").ReviewFindingRow[],
  slotManager?: TwoTierSlotManager,
): void {
  // Claim issue — if already claimed, skip
  if (!claimIssue(state, issue.id)) {
    return;
  }

  const orchestratorConfig = config.orchestrator;

  // Best-effort label update
  tracker
    .updateLabels(issue.id, [orchestratorConfig.in_progress_label], [])
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to add in_progress label for ${issue.identifier}: ${msg}`);
    });

  // Add WorkerInfo to running map synchronously so slot accounting is immediate
  const attempt = (state.retryAttempts.get(issue.id) ?? 0) + 1;
  const startedAt = Date.now();
  const slotWeight = config.team?.size ?? 1;
  const workerInfo = {
    issueId: issue.id,
    identifier: issue.identifier,
    issue,
    session: null,
    cleanup: { tempDirs: [], secretCleanups: [] },
    startedAt,
    lastActivityAt: Date.now(),
    attempt,
    slotWeight,
  };
  state.running.set(issue.id, workerInfo);

  // Register with TwoTierSlotManager so slot accounting reflects this worker
  if (slotManager) {
    slotManager.registerTopLevel(issue.id, workerInfo);
  }

  // Record dispatch metrics and emit SSE event
  metrics.recordDispatch(issue.id, issue.identifier);
  emitRunEvent({
    runId: "orchestrator",
    type: "dispatch",
    timestamp: new Date().toISOString(),
    data: { issueId: issue.id, identifier: issue.identifier, attempt },
  });

  // Fire-and-forget worker execution
  void executeWorkerAndHandle(
    issue,
    state,
    tracker,
    config,
    workspaceManager,
    promptTemplate,
    logger,
    metrics,
    governance,
    githubContext,
    delegationManager,
    subIssueCache,
    skills,
    validationConfig,
    outcomeDeps,
    kgContext,
    promotedFindings,
    slotManager,
  );
}

async function executeWorkerAndHandle(
  issue: TrackerIssue,
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  logger: Logger,
  metrics: MetricsCollector,
  governance?: GovernanceOpts,
  githubContext?: GitHubContext,
  delegationManager?: DelegationManager,
  subIssueCache?: SubIssueCache,
  skills?: string[],
  validationConfig?: { steps: import("../config/schema.js").ValidationStep[]; on_failure: string },
  outcomeDeps?: OutcomeDeps,
  kgContext?: ContextResult,
  promotedFindings?: import("../storage/repositories/review-findings.js").ReviewFindingRow[],
  slotManager?: TwoTierSlotManager,
): Promise<void> {
  // --- Triage gate: fast pre-dispatch filtering ---
  const triageResult = await triageIssue(issue, state, config);
  if (!triageResult.shouldDispatch) {
    logger.info("dispatcher", `Triage skipped ${issue.identifier}: ${triageResult.reason}`);
    state.running.delete(issue.id);
    slotManager?.releaseTopLevel(issue.id);
    releaseIssue(state, issue.id);
    return;
  }

  // Per-issue repo routing: detect repo from issue description and load profile overlay
  const issueRepo = extractRepoFromIssue(issue);
  let effectiveConfig = config;
  let effectiveWorkspaceManager = workspaceManager;
  let effectiveValidationConfig = validationConfig;
  let effectiveGithubContext = githubContext;

  if (issueRepo && issueRepo !== config.tracker?.repo) {
    const overlay = await loadRepoOverlay(issueRepo);
    if (overlay) {
      effectiveConfig = { ...config, ...overlay, orchestrator: config.orchestrator };
      // Create a new WorkspaceManager with the profile's workspace hooks
      if (overlay.workspace) {
        const { WorkspaceManager: WM } = await import("../workspace/manager.js");
        effectiveWorkspaceManager = new WM(overlay.workspace, logger);
      }
      if ((overlay as any).validation) {
        effectiveValidationConfig = (overlay as any).validation as typeof validationConfig;
      }
      // Override PR target repo via githubContext
      if (effectiveGithubContext && overlay.tracker?.repo) {
        const [owner, repo] = overlay.tracker.repo.split("/");
        effectiveGithubContext = { ...effectiveGithubContext, repo: { owner, repo } };
      }
      logger.info("dispatcher", `Using repo profile for ${issue.identifier}: ${issueRepo}`);
    }
  }

  const orchestratorConfig = effectiveConfig.orchestrator;
  const commentsEnabled = effectiveConfig.tracker?.comments_enabled !== false;
  const attempt = (state.retryAttempts.get(issue.id) ?? 0) + 1;
  const startedAt = state.running.get(issue.id)?.startedAt ?? Date.now();

  // Activity callback for stall detection
  const onActivity = (): void => {
    const worker = state.running.get(issue.id);
    if (worker) {
      worker.lastActivityAt = Date.now();
    }
  };

  // --- Pre-execution approval gate ---
  const autonomy = governance?.autonomy ?? "full";
  if (needsPreApproval(autonomy)) {
    // Check auto-approve bypass
    const autoApproveCtx = {
      labels: issue.labels,
      workflowName: promptTemplate, // best available workflow identifier
    };
    if (governance?.autoApprove && evaluateAutoApprove(governance.autoApprove, autoApproveCtx)) {
      logger.info("dispatcher", `Auto-approved pre-gate for ${issue.identifier}`);
    } else if (governance?.runRepo && governance?.runId) {
      // Gate the run: enter pending_approval and return early
      enterPendingApproval(governance.runRepo, governance.runId);
      emitRunEvent({
        runId: "orchestrator",
        type: "approval_required",
        timestamp: new Date().toISOString(),
        data: { issueId: issue.id, identifier: issue.identifier, autonomy },
      });
      logger.info("dispatcher", `Run ${issue.identifier} requires pre-approval (autonomy=${autonomy})`);
      state.running.delete(issue.id);
      slotManager?.releaseTopLevel(issue.id);
      return;
    } else {
      logger.warn("dispatcher", `Pre-approval needed for ${issue.identifier} but no runRepo available, proceeding`);
    }
  }

  // --- Construct GitHubDeps if GitHub context is available ---
  let githubDeps: GitHubDeps | undefined;
  if (githubContext) {
    const issueContext: IssueContext = {
      ...githubContext.repo,
      issueNumber: Number(issue.id),
    };
    const runId = issue.identifier;
    let commentId = 0;

    // Create initial progress comment (best-effort)
    try {
      commentId = await createProgressComment(githubContext.octokit as any, issueContext, {
        runId,
        status: "started",
        completedStages: [],
      });
      // Persist commentId if runRepo is available
      if (governance?.runRepo) {
        try {
          governance.runRepo.setGithubCommentId(runId, commentId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to persist commentId for ${issue.identifier}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to create progress comment for ${issue.identifier}: ${msg}`);
    }

    githubDeps = {
      octokit: githubContext.octokit as any,
      issueContext,
      commentId,
      runId,
      repoContext: githubContext.repo,
    };
  }

  // --- Insert run record for governance state machine ---
  let governanceWithRunId = governance;
  if (governance?.runRepo) {
    const runId = issue.identifier;
    try {
      governance.runRepo.insert({
        id: runId,
        task: promptTemplate,
        workflow: "orchestrated",
        status: "running",
        submittedAt: new Date().toISOString(),
      });
      governanceWithRunId = { ...governance, runId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("dispatcher", `Failed to insert run record for ${issue.identifier}: ${msg}`);
    }
  }

  try {
    const result = await executeWorker(
      issue,
      effectiveConfig,
      effectiveWorkspaceManager,
      promptTemplate,
      attempt,
      logger,
      onActivity,
      effectiveValidationConfig,
      githubDeps,
      governanceWithRunId,
      skills,
      kgContext,
      outcomeDeps?.snapshotRepo,
      promotedFindings,
      tracker,
      governanceWithRunId?.costRepo,
      outcomeDeps?.eventRepo,
      governanceWithRunId?.runRepo,
    );

    // Remove from running
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);
    slotManager?.releaseTopLevel(issue.id);

    // --- Delegation hook: check if lead agent output contains a manifest ---
    if (delegationManager) {
      const specs = delegationManager.parseDelegationManifest(result.agentResult.stdout, issue.identifier);
      if (specs && specs.length > 0) {
        const maxChildren = config.orchestrator.child_slots ?? 5;
        const depth = 0; // top-level lead is always depth 0
        delegationManager.runDelegation(issue.identifier, issue, specs, depth, maxChildren).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("dispatcher", `Delegation run error for ${issue.identifier}: ${msg}`);
          },
        );
      }
    }

    // Trigger parent rollup if this issue is a sub-issue (best-effort)
    if (subIssueCache && githubContext) {
      await triggerParentRollup(
        issue,
        subIssueCache,
        tracker,
        githubContext,
        config,
        logger,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Rollup callback error for ${issue.identifier}: ${msg}`);
      });
    }

    // Post loop-specific comment if loop was detected
    if (commentsEnabled && result.validationResult?.loopDetected) {
      const loop = result.validationResult.loopDetected;
      const loopComment = `**forgectl:** Agent halted — loop detected.\n\n**Pattern:** ${loop.type}\n**Detail:** ${loop.detail}`;
      tracker.postComment(issue.id, loopComment).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to post loop comment for ${issue.identifier}: ${msg}`);
      });
    }

    // Post comment (best-effort)
    if (commentsEnabled) {
      tracker.postComment(issue.id, result.comment).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to post comment for ${issue.identifier}: ${msg}`);
      });
    }

    // Classify failure and handle retry
    const failureType = classifyFailure(result.agentResult.status);

    // Record completion metrics
    const tokenUsage = result.agentResult.tokenUsage ?? { input: 0, output: 0, total: 0 };
    metrics.recordCompletion(
      issue.id,
      tokenUsage,
      runtimeMs,
      failureType === "continuation" ? "completed" : "failed",
    );

    // Persist cost data to run_costs table and emit cost event
    if (governanceWithRunId?.costRepo && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
      const runId = governanceWithRunId.runId ?? issue.identifier;
      const costUsd = (tokenUsage.input * 3 + tokenUsage.output * 15) / 1_000_000;
      try {
        governanceWithRunId.costRepo.insert({
          runId,
          agentType: config.agent.type,
          model: config.agent.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          costUsd,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to insert cost record for ${issue.identifier}: ${msg}`);
      }
      emitRunEvent({
        runId: runId,
        type: "cost",
        timestamp: new Date().toISOString(),
        data: {
          agentType: config.agent.type,
          model: config.agent.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          costUsd,
        },
      });
    }

    // Record learning feedback: files from KG context → outcome_files table
    if (kgContext && kgContext.includedFiles.length > 0) {
      try {
        const { createKGDatabase, recordOutcomeFiles } = await import("../kg/storage.js");
        const storagePath = config.storage?.db_path ?? "~/.forgectl/forgectl.db";
        const dir = storagePath.replace(/\/[^/]+$/, "").replace(/^~/, process.env.HOME || "/tmp");
        const kgDbPath = `${dir}/kg.db`;
        let kgDb: import("../kg/storage.js").KGDatabase | undefined;
        try {
          kgDb = createKGDatabase(kgDbPath);
          const filePaths = kgContext.includedFiles.map(f => f.path);
          const taskType = inferTaskTypeFromIssue(issue);
          const success = failureType === "continuation";
          const turns = result.agentResult.turnCount ?? 0;
          const retries = attempt - 1;
          recordOutcomeFiles(kgDb, filePaths, taskType, success, turns, retries);
          logger.debug("dispatcher", `Recorded learning feedback: ${filePaths.length} files, taskType=${taskType}, success=${success}`);
        } finally {
          try { kgDb?.close(); } catch { /* best-effort */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug("dispatcher", `Failed to record learning feedback: ${msg}`);
      }
    }

    // Record outcome for the Outcome Analyzer
    if (outcomeDeps) {
      try {
        const outcomeStatus = failureType === "continuation" ? "success" : "failure";
        let rawEventsJson: string | undefined;
        if (outcomeDeps.eventRepo) {
          const events = outcomeDeps.eventRepo.findByRunId(issue.identifier);
          if (events.length > 0) {
            rawEventsJson = JSON.stringify(events);
          }
        }

        // Compute context feedback: discovery misses + hit rate
        let contextHitRate: number | undefined;
        if (kgContext) {
          try {
            const agentAccessedFiles = parseAgentAccessedFiles(rawEventsJson ?? null);
            const preProvided = kgContext.includedFiles.map(f => f.path);
            const feedback = computeContextFeedback(preProvided, agentAccessedFiles);
            contextHitRate = feedback.contextHitRate;

            // Record discovery misses in the KG database
            if (feedback.discoveryMisses.length > 0) {
              const { existsSync } = await import("node:fs");
              const maxAgents = config.orchestrator?.max_concurrent_agents ?? 1;
              const workspaceId = maxAgents > 1
                ? issue.identifier
                : (config.tracker?.repo?.replace("/", "_") ?? issue.identifier);
              let kgPath: string | undefined;
              try {
                const wsKgPath = workspaceManager.getWorkspacePath(workspaceId) + "/kg.db";
                if (existsSync(wsKgPath)) kgPath = wsKgPath;
              } catch { /* fallback */ }
              if (!kgPath) {
                const { resolveKGPath } = await import("../kg/storage.js");
                kgPath = resolveKGPath(undefined, undefined);
              }
              if (existsSync(kgPath)) {
                const { createKGDatabase } = await import("../kg/storage.js");
                let kgDb: import("../kg/storage.js").KGDatabase | undefined;
                try {
                  kgDb = createKGDatabase(kgPath);
                  const taskType = issue.labels.find(l => ["bugfix", "feature", "refactor", "test"].includes(l)) ?? "general";
                  recordContextFeedback(kgDb, taskType, feedback.discoveryMisses);
                  logger.info("dispatcher", `Recorded ${feedback.discoveryMisses.length} discovery misses for ${issue.identifier} (hit_rate=${feedback.contextHitRate})`);
                } finally {
                  try { kgDb?.close(); } catch { /* best-effort */ }
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Context feedback computation failed for ${issue.identifier}: ${msg}`);
          }
        }

        const runId = issue.identifier;
        outcomeDeps.outcomeRepo.insert({
          id: runId,
          taskId: issue.id,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          status: outcomeStatus,
          totalTurns: result.agentResult.turnCount ?? undefined,
          lintIterations: result.lintIterations ?? undefined,
          reviewRounds: result.executionResult?.review?.totalRounds ?? undefined,
          reviewCommentsJson: result.reviewOutput ? serializeReviewOutput(result.reviewOutput) : undefined,
          failureMode: outcomeStatus === "failure" ? (failureType ?? "unknown") : undefined,
          failureDetail: outcomeStatus === "failure" ? result.agentResult.stderr?.slice(0, 2000) : undefined,
          rawEventsJson,
          contextEnabled: kgContext ? 1 : 0,
          contextFilesJson: kgContext ? JSON.stringify(kgContext.includedFiles.map(f => f.path)) : undefined,
          contextHitRate,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("dispatcher", `Failed to record outcome for ${issue.identifier}: ${msg}`);
      }
    }

    // Record the branch for this issue (used for stacked PR bases)
    if (result.branch) {
      state.issueBranches.set(issue.id, result.branch);
    }

    // Create PR (fire-and-forget) — the merge daemon handles merging.
    // Close the issue after successful agent run regardless of merge status.
    let prCreated = false;
    let prUrl: string | undefined;
    if (result.branch && failureType === "continuation") {
      // Determine PR base: use blocker's branch for stacked diffs, otherwise default base.
      // Only stack if the blocker's branch still exists (not yet merged+deleted).
      // If the blocker is in recentlyCompleted, its branch was merged to main — use main.
      const defaultBase = effectiveConfig.repo?.branch?.base ?? "main";
      let prBase = defaultBase;
      if (issue.blocked_by.length > 0) {
        for (const blockerId of issue.blocked_by) {
          // Skip blockers that are already completed (branch merged to main)
          if (state.recentlyCompleted.has(blockerId)) continue;
          const blockerBranch = state.issueBranches.get(blockerId);
          if (blockerBranch) {
            // Verify the branch exists on the remote before using as base
            try {
              const [owner, repo] = (effectiveConfig.tracker?.repo ?? "").split("/");
              if (owner && repo && effectiveGithubContext) {
                const octokit = (effectiveGithubContext.prOctokit ?? effectiveGithubContext.octokit) as any;
                await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
                  owner, repo, branch: blockerBranch,
                });
                prBase = blockerBranch;
                logger.info("dispatcher", `Stacking ${issue.identifier} PR on blocker branch: ${blockerBranch}`);
              }
            } catch {
              // Branch doesn't exist (merged+deleted) — fall back to default base
              logger.info("dispatcher", `Blocker branch ${blockerBranch} no longer exists, using ${defaultBase}`);
            }
            break;
          }
        }
      }

      const richBody = buildRichPRBody({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueDescription: issue.description || undefined,
        repoSlug: effectiveConfig.tracker?.repo,
        diffStat: result.diffStat,
        validationResults: result.validationResult?.stepResults?.map((sr: { name: string; passed: boolean }) => ({
          step: sr.name,
          passed: sr.passed,
        })),
      });

      if (tracker.createPullRequest) {
        try {
          prUrl = await tracker.createPullRequest(
            result.branch,
            `[forgectl] ${issue.title}`,
            richBody,
          ) ?? undefined;
          if (prUrl) {
            logger.info("dispatcher", `PR created for ${issue.identifier}: ${prUrl}`);
            prCreated = true;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to create PR for ${issue.identifier}: ${msg}`);
        }
      } else if (effectiveGithubContext && effectiveConfig.tracker?.repo) {
        // Fallback: create PR via GitHub App when tracker doesn't support PR creation (e.g. Linear)
        try {
          const [owner, repo] = effectiveConfig.tracker.repo.split("/");
          const usingMergerApp = !!effectiveGithubContext.prOctokit;
          const octokit = (effectiveGithubContext.prOctokit ?? effectiveGithubContext.octokit) as any;
          logger.info("dispatcher", `Creating PR for ${issue.identifier} via GitHub App (${usingMergerApp ? "merger" : "creator"}) on ${owner}/${repo}`);
          const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
            owner, repo,
            title: `[forgectl] ${issue.title}`,
            head: result.branch,
            base: prBase,
            body: richBody,
          });
          prUrl = pr.html_url;
          logger.info("dispatcher", `PR created via GitHub App for ${issue.identifier}: ${prUrl}`);
          prCreated = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to create PR via GitHub App for ${issue.identifier}: ${msg}`);
        }
      }

      // Post PR link as comment on the tracker issue
      if (prUrl && commentsEnabled) {
        tracker.postComment(issue.id, `**forgectl:** PR created → ${prUrl}`).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("dispatcher", `Failed to post PR comment for ${issue.identifier}: ${msg}`);
        });
      }
    }

    if (failureType === "continuation") {
      // Always invalidate sub-issue cache when an issue completes successfully.
      // This ensures downstream blocked issues see this issue's new state on the next tick,
      // regardless of whether PR creation succeeds or fails.
      if (subIssueCache && issue.metadata?.parentId) {
        subIssueCache.invalidate(issue.metadata.parentId as string);
      }

      // Synthesizer-gated close: if this issue has the forge:synthesize label, it is
      // a synthesizer run. Close the parent and remove the label instead of the
      // normal auto_close / done_label path.
      const isSynthesizerRun = issue.labels.includes("forge:synthesize");

      if (isSynthesizerRun) {
        handleSynthesizerOutcome(issue, "success", tracker, logger, commentsEnabled);
      } else if (prCreated || !result.branch) {
        // Mark as recently completed IMMEDIATELY to prevent re-dispatch before tracker API reflects Done
        state.recentlyCompleted.set(issue.id, Date.now());
        // Close the issue: PR was created, or no branch was produced (files-mode output)
        if (config.tracker?.auto_close) {
          // Use the first terminal state from config (e.g. "Done" for Linear, "closed" for GitHub)
          const closeState = config.tracker.terminal_states[0] ?? "closed";
          tracker.updateState(issue.id, closeState).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Failed to auto-close ${issue.identifier}: ${msg}`);
          });
        }

        if (config.tracker?.done_label) {
          tracker.updateLabels(issue.id, [config.tracker.done_label], [orchestratorConfig.in_progress_label]).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Failed to add done label for ${issue.identifier}: ${msg}`);
          });
        }
      } else {
        // PR creation failed — leave issue open for retry
        logger.warn("dispatcher", `Issue ${issue.identifier} completed but PR creation failed — branch ${result.branch} is pushed, leaving issue open`);
        tracker.updateLabels(issue.id, [], [orchestratorConfig.in_progress_label]).catch(() => {});
      }

      logger.info("dispatcher", `Releasing completed issue ${issue.identifier} (id=${issue.id}) from claimed set`);
      cleanupRetryRecords(issue.id, governanceWithRunId?.retryRepo);
      releaseIssue(state, issue.id);
      logger.info("dispatcher", `Post-release: claimed=${state.claimed.size}, running=${state.running.size}`);

      // Dispatcher-level Linear comment fallback (scheduler-dispatched runs without webhook context)
      if (!githubContext && config.tracker?.comments_enabled !== false) {
        const commentEvents = config.tracker?.comment_events ?? ["completed", "failed", "timeout", "aborted"];
        const commentStatus: RunCommentData["status"] = "success";
        if (shouldPostComment(commentStatus, commentEvents)) {
          let costUsd: number | undefined;
          if (governanceWithRunId?.costRepo) {
            try {
              const runId = governanceWithRunId.runId ?? issue.identifier;
              const summary = governanceWithRunId.costRepo.sumByRunId(runId);
              if (summary.totalCostUsd > 0) costUsd = summary.totalCostUsd;
            } catch { /* best-effort */ }
          }
          if (costUsd == null && tokenUsage.input > 0) {
            costUsd = (tokenUsage.input * 3 + tokenUsage.output * 15) / 1_000_000;
          }
          const runCommentData: RunCommentData = {
            runId: issue.identifier,
            issueIdentifier: issue.identifier,
            status: commentStatus,
            durationMs: runtimeMs,
            tokenUsage: tokenUsage.input > 0 ? { input: tokenUsage.input, output: tokenUsage.output } : undefined,
            costUsd,
            prUrl,
            validationResults: result.validationResult?.stepResults?.map((sr) => ({
              name: sr.name,
              passed: sr.passed,
              attempts: sr.attempts ?? 1,
            })),
            branch: result.branch,
          };
          const formattedComment = formatRunComment(runCommentData);
          tracker.postComment(issue.id, formattedComment).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("dispatcher", `Failed to post Linear run comment for ${issue.identifier}: ${msg}`);
          });
        }
      }
    } else {
      // Failure path: if this is a synthesizer run, post error comment and do NOT close parent
      const isSynthesizerFailure = issue.labels.includes("forge:synthesize");
      if (isSynthesizerFailure) {
        handleSynthesizerOutcome(issue, "failure", tracker, logger, commentsEnabled);
      }
      // Error — check retry budget
      const currentAttempts = (state.retryAttempts.get(issue.id) ?? 0) + 1;
      state.retryAttempts.set(issue.id, currentAttempts);

      if (currentAttempts >= orchestratorConfig.max_retries) {
        // Exhausted — release and clean up
        logger.warn(
          "dispatcher",
          `Max retries exhausted for ${issue.identifier} after ${currentAttempts} attempts`,
        );

        // Post failure comment (best-effort)
        if (commentsEnabled) {
          tracker
            .postComment(
              issue.id,
              `Max retries (${orchestratorConfig.max_retries}) exhausted. Releasing issue.`,
            )
            .catch(() => {});
        }

        // Remove in_progress label (best-effort)
        tracker
          .updateLabels(issue.id, [], [orchestratorConfig.in_progress_label])
          .catch(() => {});

        cleanupRetryRecords(issue.id, governanceWithRunId?.retryRepo);
        releaseIssue(state, issue.id);

        // Dispatcher-level Linear comment fallback for failed runs (scheduler-dispatched)
        if (!githubContext && config.tracker?.comments_enabled !== false) {
          const failCommentEvents = config.tracker?.comment_events ?? ["completed", "failed", "timeout", "aborted"];
          const failStatus: RunCommentData["status"] = result.agentResult.status === "timeout" ? "timeout" : "failure";
          if (shouldPostComment(failStatus, failCommentEvents)) {
            const failCommentData: RunCommentData = {
              runId: issue.identifier,
              issueIdentifier: issue.identifier,
              status: failStatus,
              durationMs: runtimeMs,
              tokenUsage: tokenUsage.input > 0 ? { input: tokenUsage.input, output: tokenUsage.output } : undefined,
              errorSummary: result.agentResult.stderr,
              branch: result.branch,
            };
            const formattedFailComment = formatRunComment(failCommentData);
            tracker.postComment(issue.id, formattedFailComment).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn("dispatcher", `Failed to post Linear fail comment for ${issue.identifier}: ${msg}`);
            });
          }
        }
      } else {
        // Schedule error retry with backoff
        const delay = calculateBackoff(
          currentAttempts,
          orchestratorConfig.max_retry_backoff_ms,
        );
        metrics.recordRetry(issue.id);
        emitRunEvent({
          runId: "orchestrator",
          type: "orch_retry",
          timestamp: new Date().toISOString(),
          data: { issueId: issue.id, identifier: issue.identifier, attempt: currentAttempts, delayMs: delay },
        });
        scheduleRetry(
          issue.id,
          delay,
          () => {
            releaseIssue(state, issue.id);
          },
          state,
          governanceWithRunId?.retryRepo,
        );
      }
    }
  } catch (err) {
    // Unexpected error in worker
    const runtimeMs = Date.now() - startedAt;
    state.running.delete(issue.id);
    slotManager?.releaseTopLevel(issue.id);
    metrics.recordCompletion(issue.id, { input: 0, output: 0, total: 0 }, runtimeMs, "failed");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("dispatcher", `Unexpected worker error for ${issue.identifier}: ${msg}`);

    // Record outcome for unexpected failures
    if (outcomeDeps) {
      try {
        outcomeDeps.outcomeRepo.insert({
          id: issue.identifier,
          taskId: issue.id,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          status: "failure",
          failureMode: "unexpected_error",
          failureDetail: msg.slice(0, 2000),
          contextEnabled: kgContext ? 1 : 0,
        });
      } catch {
        // Best-effort — don't mask the original error
      }
    }

    releaseIssue(state, issue.id);
  }
}

function inferTaskTypeFromIssue(issue: TrackerIssue): string {
  const text = `${issue.title} ${issue.description}`.toLowerCase();
  if (text.includes("fix") || text.includes("bug")) return "bugfix";
  if (text.includes("add") || text.includes("implement") || text.includes("feature")) return "feature";
  if (text.includes("refactor") || text.includes("clean")) return "refactor";
  if (text.includes("test")) return "test";
  return "general";
}
