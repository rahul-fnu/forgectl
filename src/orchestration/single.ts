import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "../output/types.js";
import type { ValidationResult } from "../validation/runner.js";
import type { SnapshotRepository } from "../storage/repositories/snapshots.js";
import type { LockRepository } from "../storage/repositories/locks.js";
import type { AgentAdapter } from "../agent/types.js";
import { getAgentAdapter } from "../agent/registry.js";
import { createAgentSession } from "../agent/session.js";
import { buildPrompt } from "../context/prompt.js";
import { createContainer } from "../container/runner.js";
import { ensureImage } from "../container/builder.js";
import { prepareRepoWorkspace, prepareFilesWorkspace } from "../container/workspace.js";
import { createIsolatedNetwork, applyFirewall } from "../container/network.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { prepareClaudeMounts, prepareCodexMounts } from "../auth/mount.js";
import { prepareSkillMounts } from "../skills/mount.js";
import { runValidationLoop, runLintGate, type LintGateResult } from "../validation/runner.js";
import { runReviewAgent, serializeReviewOutput } from "../validation/review-agent.js";
import type { ReviewOutput } from "../validation/review-agent.js";
import { invokeAgent } from "../agent/invoke.js";
import { createLoopDetectorState, recordReviewComments } from "../agent/loop-detector.js";
import { collectOutput } from "../output/collector.js";
import { cleanupRun, type CleanupContext } from "../container/cleanup.js";
import { Timer } from "../utils/timer.js";
import { emitRunEvent } from "../logging/events.js";
import { saveCheckpoint } from "../durability/checkpoint.js";
import { acquireLock, releaseLock } from "../durability/locks.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { needsPostApproval } from "../governance/autonomy.js";
import { enterPendingOutputApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";
import { checkCostCeiling, BudgetExceededError } from "../agent/budget.js";

/** Optional durability dependencies for checkpoint/lock support. */
export interface DurabilityDeps {
  snapshotRepo?: SnapshotRepository;
  lockRepo?: LockRepository;
  daemonPid?: number;
  runRepo?: RunRepository;
}

export interface ReviewSummary {
  totalRounds: number;
  approved: boolean;
  approvedOnRound?: number;
  comments?: import("./review.js").ReviewComment[];
  escalatedToHuman?: boolean;
  reviewCommentsJson?: string;
}

export interface ExecutionResult {
  success: boolean;
  output?: OutputResult;
  validation: ValidationResult;
  durationMs: number;
  error?: string;
  review?: ReviewSummary;
  reviewCommentsJson?: string;
}

/**
 * Shared prepare phase: ensure image, prepare workspace, credentials,
 * network, create container, apply firewall.
 *
 * The caller owns the `cleanup` context — resources are added to it
 * progressively so cleanup works even if this function throws partway through.
 */
export async function prepareExecution(
  plan: RunPlan,
  logger: Logger,
  cleanup: CleanupContext,
) {
  emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "prepare" } });

  // 1. Ensure Docker image exists
  logger.info("prepare", `Ensuring image: ${plan.container.image}`);
  const resolvedImage = await ensureImage(plan.container.image, plan.container.dockerfile);

  // 2. Prepare workspace
  const binds: string[] = [];
  if (plan.input.mode === "repo") {
    logger.info("prepare", "Preparing repo workspace...");
    const workspaceDir = prepareRepoWorkspace(plan.input.sources[0], plan.input.exclude);
    cleanup.tempDirs.push(workspaceDir);
    binds.push(`${workspaceDir}:${plan.input.mountPath}`);
  } else {
    logger.info("prepare", "Preparing file workspace...");
    const { inputDir, outputDir } = prepareFilesWorkspace(plan.input.sources);
    cleanup.tempDirs.push(inputDir, outputDir);
    binds.push(`${inputDir}:${plan.input.mountPath}:ro`);
    binds.push(`${outputDir}:${plan.output.path}`);
  }

  // 3. Prepare credentials and build direct env vars (no shell subcommands)
  const agentEnv: string[] = [];

  // Warn if team config is present but agent is not claude-code
  if (plan.team && !plan.noTeam && plan.agent.type !== "claude-code") {
    logger.warn(
      "prepare",
      `Team mode is only supported for claude-code agent; ignoring team config for ${plan.agent.type}`,
    );
  }

  if (plan.agent.type === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) throw new Error("No Claude Code credentials configured");
    const mounts = prepareClaudeMounts(auth, plan.runId);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`ANTHROPIC_API_KEY=${auth.apiKey}`);
    }
    for (const [k, v] of Object.entries(mounts.env)) {
      agentEnv.push(`${k}=${v}`);
    }
    agentEnv.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    // Team mode: set CLAUDE_NUM_TEAMMATES if team configured and not disabled
    if (!plan.noTeam && plan.team && plan.team.size > 1) {
      const teammates = plan.team.size - 1;
      agentEnv.push(`CLAUDE_NUM_TEAMMATES=${teammates}`);
    }
  } else if (plan.agent.type === "browser-use") {
    // Browser-use needs LLM credentials -- try Claude first (forgectl is Claude-first), fall back to OpenAI
    try {
      const claudeAuth = await getClaudeAuth();
      if (claudeAuth?.type === "api_key" && claudeAuth.apiKey) {
        agentEnv.push(`ANTHROPIC_API_KEY=${claudeAuth.apiKey}`);
      }
    } catch {
      // Claude key is optional for browser-use
    }
    // Also check OpenAI as fallback/alternative
    try {
      const codexAuth = await getCodexAuth();
      if (codexAuth?.type === "api_key" && codexAuth.apiKey) {
        agentEnv.push(`OPENAI_API_KEY=${codexAuth.apiKey}`);
      }
    } catch {
      // OpenAI key is optional for browser-use
    }
    // Docker env vars for Chromium sandbox workaround
    agentEnv.push("IN_DOCKER=True");
    agentEnv.push("BROWSER_USE_CHROME_NO_SANDBOX=1");
    // No bind mounts needed -- sidecar runs inside container
  } else {
    const auth = await getCodexAuth();
    if (!auth) throw new Error("No Codex credentials configured. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    const mounts = prepareCodexMounts(auth, plan.runId);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
    }
    if (mounts.env.CODEX_HOME) {
      agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
    }
  }

  // 4. Skill mounts (Claude Code only)
  let skillAddDirFlags: string[] = [];
  if (plan.agent.type === "claude-code") {
    const { mounts: skillMounts, addDirFlags } = prepareSkillMounts(
      plan.workflow.skills ?? [],
      plan.noSkills ?? false,
    );
    binds.push(...skillMounts.binds);
    skillAddDirFlags = addDirFlags;
  }

  // 5. Create network (only for allowlist mode)
  if (plan.container.network.mode === "allowlist") {
    logger.info("prepare", "Creating isolated network...");
    await createIsolatedNetwork(plan.container.network.dockerNetwork);
    cleanup.networkName = plan.container.network.dockerNetwork;
  }

  // 6. Create container with resolved image
  logger.info("prepare", "Starting container...");
  const resolvedPlan = { ...plan, container: { ...plan.container, image: resolvedImage } };
  const container = await createContainer(resolvedPlan, binds);
  cleanup.container = container;

  // 7. Apply firewall (only for allowlist mode)
  if (plan.container.network.mode === "allowlist" && plan.container.network.allow) {
    logger.info("prepare", "Applying network firewall...");
    await applyFirewall(container, plan.container.network.allow);
  }

  // Build adapter and options
  // browser-use has no CLI adapter -- it uses BrowserUseSession directly via createAgentSession
  const adapter = plan.agent.type === "browser-use"
    ? { name: "browser-use", buildShellCommand: () => "" } as AgentAdapter
    : getAgentAdapter(plan.agent.type);
  const agentOptions = {
    model: plan.agent.model,
    maxTurns: plan.agent.maxTurns,
    timeout: plan.agent.timeout,
    flags: [...plan.agent.flags, ...skillAddDirFlags],
    workingDir: plan.input.mountPath,
  };

  return { container, adapter, agentOptions, agentEnv, resolvedImage };
}

export async function executeSingleAgent(
  plan: RunPlan,
  logger: Logger,
  noCleanup = false,
  deps: DurabilityDeps = {},
): Promise<ExecutionResult> {
  const timer = new Timer();
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };
  const { snapshotRepo, lockRepo, daemonPid, runRepo } = deps;

  // --- Lock acquisition ---
  // Acquire workspace lock using the runId as both key and owner
  const workspaceKey = plan.input.sources[0];
  if (lockRepo && daemonPid && workspaceKey) {
    const gotLock = acquireLock(lockRepo, {
      lockType: "workspace",
      lockKey: workspaceKey,
      ownerId: plan.runId,
      daemonPid,
    });
    if (!gotLock) {
      throw new Error(`Cannot execute run ${plan.runId}: workspace ${workspaceKey} is locked by another run`);
    }
  }

  try {
    // --- Phase: Prepare ---
    const { container, adapter, agentOptions, agentEnv } = await prepareExecution(plan, logger, cleanup);
    if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "prepare");

    // --- Phase: Execute ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "execute" } });

    const prompt = buildPrompt(plan);
    logger.info("agent", `Running ${plan.agent.type}...`);

    // Use AgentSession for the top-level invocation
    const session = createAgentSession(plan.agent.type, container, agentOptions, agentEnv);
    const agentResult = await session.invoke(prompt);
    await session.close();

    // --- Cost ceiling check ---
    const ceilingConfig = {
      maxCostUsd: plan.costCeiling?.maxCostUsd,
      maxTokens: plan.costCeiling?.maxTokens,
    };
    if (ceilingConfig.maxCostUsd !== undefined || ceilingConfig.maxTokens !== undefined) {
      const costUsd = agentResult.tokenUsage
        ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
        : 0;
      const cumulative = {
        inputTokens: agentResult.tokenUsage?.input ?? 0,
        outputTokens: agentResult.tokenUsage?.output ?? 0,
        costUsd,
      };
      const ceilingResult = checkCostCeiling(cumulative, ceilingConfig);
      if (ceilingResult.percentUsed >= 80 && !ceilingResult.exceeded) {
        logger.warn("budget", `Run ${plan.runId} at 80% of cost ceiling (${ceilingResult.percentUsed.toFixed(1)}% used)`);
      }
      if (ceilingResult.exceeded) {
        throw new BudgetExceededError("per_run", cumulative.costUsd, ceilingConfig.maxCostUsd ?? 0);
      }
    }

    logger.info("agent", `Agent finished (status=${agentResult.status}, ${agentResult.durationMs}ms)`);
    if (agentResult.stdout) logger.info("agent", `STDOUT: ${agentResult.stdout.slice(0, 2000)}`);
    if (agentResult.stderr) logger.info("agent", `STDERR: ${agentResult.stderr.slice(0, 2000)}`);
    if (agentResult.status === "failed") {
      logger.warn("agent", `Agent finished with status: ${agentResult.status}`);
      if (agentResult.stderr) {
        logger.debug("agent", `stderr: ${agentResult.stderr.slice(0, 500)}`);
      }
    }
    if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "execute", { agentStatus: agentResult.status });

    // --- Phase: Lint Gate ---
    let lintGateResult: LintGateResult | undefined;
    if (plan.validation.lintSteps.length > 0) {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "lint" } });
      logger.info("validation", `Running ${plan.validation.lintSteps.length} lint steps...`);
      lintGateResult = await runLintGate(
        container, plan.validation.lintSteps, plan.input.mountPath,
        adapter, agentOptions, agentEnv, logger,
      );
      if (!lintGateResult.passed) {
        logger.error("validation", `Lint gate failed after ${lintGateResult.lintIterations} iterations`);
        if (plan.validation.onFailure === "abandon") {
          emitRunEvent({ runId: plan.runId, type: "failed", timestamp: new Date().toISOString(), data: { reason: "lint_gate_failed" } });
          return {
            success: false,
            validation: {
              passed: false,
              totalAttempts: lintGateResult.lintIterations,
              stepResults: lintGateResult.stepResults,
              lastOutput: lintGateResult.lastOutput,
            },
            durationMs: timer.elapsed(),
            error: "Lint gate failed and on_failure is set to 'abandon'",
          };
        }
      }
    }

    // --- Phase: Validate ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "validate" } });

    logger.info("validate", `Running ${plan.validation.steps.length} validation steps...`);
    const validationResult = await runValidationLoop(
      container, plan, adapter, agentOptions, agentEnv, logger
    );
    if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "validate", { passed: validationResult.passed });

    // --- Phase: Review Agent with self-addressing loop (only after validation passes) ---
    const MAX_REVIEW_SELF_ADDRESS_ROUNDS = 2;
    let reviewOutput: ReviewOutput | undefined;
    let reviewRounds = 0;
    if (validationResult.passed) {
      const reviewLoopState = createLoopDetectorState();

      for (let round = 1; round <= MAX_REVIEW_SELF_ADDRESS_ROUNDS; round++) {
        reviewRounds = round;
        try {
          reviewOutput = await runReviewAgent(
            container, adapter, agentOptions, agentEnv, plan.task, logger,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("review-agent", `Review agent failed (non-blocking): ${msg}`);
          break;
        }

        if (!reviewOutput) break;

        // Check for MUST_FIX comments that need self-addressing
        const mustFix = reviewOutput.comments.filter(c => c.severity === "MUST_FIX");
        if (mustFix.length === 0) {
          logger.info("review-agent", "No MUST_FIX comments — review passed");
          break;
        }

        // Check for review loop (same comments repeated)
        const loopCheck = recordReviewComments(reviewLoopState, reviewOutput.comments);
        if (loopCheck) {
          logger.error("review-agent", `Review loop detected: ${loopCheck.detail}`);
          emitRunEvent({
            runId: plan.runId, type: "loop_detected", timestamp: new Date().toISOString(),
            data: { pattern: loopCheck.type, detail: loopCheck.detail, round },
          });
          break;
        }

        if (round >= MAX_REVIEW_SELF_ADDRESS_ROUNDS) {
          logger.warn("review-agent", `${mustFix.length} MUST_FIX comment(s) remain after ${round} review rounds`);
          break;
        }

        // Feed MUST_FIX + SHOULD_FIX comments back to the agent
        const actionable = reviewOutput.comments.filter(c => c.severity === "MUST_FIX" || c.severity === "SHOULD_FIX");
        const fixParts = [
          `REVIEW COMMENTS (round ${round}) — address all items below:`,
          "",
        ];
        for (const c of actionable) {
          fixParts.push(`[${c.severity}] ${c.file}:${c.line} — ${c.comment}`);
          if (c.suggested_fix) fixParts.push(`  Suggested fix: ${c.suggested_fix}`);
          fixParts.push("");
        }
        fixParts.push("Fix all MUST_FIX and SHOULD_FIX issues. The reviewer will check again.");
        const fixPrompt = fixParts.join("\n");

        logger.info("review-agent", `Feeding ${actionable.length} actionable comments to agent (round ${round})...`);
        await invokeAgent(container, adapter, fixPrompt, agentOptions, agentEnv, `review-fix-${round}`);

        // Re-run lint gate + validation after fix
        if (plan.validation.lintSteps.length > 0) {
          const reLint = await runLintGate(
            container, plan.validation.lintSteps, plan.input.mountPath,
            adapter, agentOptions, agentEnv, logger,
          );
          if (!reLint.passed) {
            logger.warn("review-agent", "Lint gate failed after review fix — stopping self-addressing");
            break;
          }
        }
        if (plan.validation.steps.length > 0) {
          const reVal = await runValidationLoop(container, plan, adapter, agentOptions, agentEnv, logger);
          if (!reVal.passed) {
            logger.warn("review-agent", "Validation failed after review fix — stopping self-addressing");
            break;
          }
        }
      }
    }
    const reviewCommentsJson = reviewOutput ? serializeReviewOutput(reviewOutput) : undefined;
    const hasMustFix = reviewOutput ? reviewOutput.summary.must_fix > 0 : false;
    const reviewSummary: ReviewSummary | undefined = reviewRounds > 0
      ? {
          totalRounds: reviewRounds,
          approved: !hasMustFix,
          approvedOnRound: !hasMustFix ? reviewRounds : undefined,
          reviewCommentsJson,
        }
      : undefined;

    // --- Phase: Collect Output ---
    if (validationResult.passed || plan.validation.onFailure === "output-wip") {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "output" } });

      logger.info("output", `Collecting ${plan.output.mode} output...`);
      const output = await collectOutput(container, plan, logger);
      if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "output");

      // --- Post-execution approval gate ---
      const autonomy = plan.workflow.autonomy ?? "full";
      if (needsPostApproval(autonomy) && runRepo) {
        // Check auto-approve bypass (with actual cost from token usage)
        const actualCost = agentResult.tokenUsage
          ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
          : undefined;
        const autoApproveCtx = {
          labels: [] as string[],
          workflowName: plan.workflow.name,
          actualCost,
        };
        if (plan.workflow.auto_approve && evaluateAutoApprove(plan.workflow.auto_approve, autoApproveCtx)) {
          logger.info("governance", `Auto-approved post-gate for run ${plan.runId}`);
        } else {
          // Output is collected; enter pending_output_approval and return early
          enterPendingOutputApproval(runRepo, plan.runId);
          logger.info("governance", `Run ${plan.runId} requires output approval (autonomy=${autonomy})`);
          return {
            success: validationResult.passed,
            output,
            validation: validationResult,
            durationMs: timer.elapsed(),
            review: reviewSummary,
            reviewCommentsJson,
          };
        }
      }

      emitRunEvent({
        runId: plan.runId,
        type: "completed",
        timestamp: new Date().toISOString(),
        data: { success: true, output },
      });

      return {
        success: validationResult.passed,
        output,
        validation: validationResult,
        durationMs: timer.elapsed(),
        review: reviewSummary,
        reviewCommentsJson,
      };
    }

    // Validation failed and on_failure = "abandon"
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: new Date().toISOString(),
      data: { reason: "validation_failed" },
    });

    return {
      success: false,
      validation: validationResult,
      durationMs: timer.elapsed(),
      error: "Validation failed and on_failure is set to 'abandon'",
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("execution", message);
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: new Date().toISOString(),
      data: { error: message },
    });
    return {
      success: false,
      validation: { passed: false, totalAttempts: 0, stepResults: [] },
      durationMs: timer.elapsed(),
      error: message,
    };
  } finally {
    // --- Lock release ---
    if (lockRepo && workspaceKey) {
      releaseLock(lockRepo, "workspace", workspaceKey, plan.runId);
    }

    if (!noCleanup) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup)");
    }
  }
}
