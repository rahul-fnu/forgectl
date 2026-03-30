import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "../output/types.js";
import type { ValidationResult } from "../validation/runner.js";
import { getAgentAdapter } from "../agent/registry.js";
import { createAgentSession } from "../agent/session.js";
import { buildPrompt, buildHandoffContext } from "../context/prompt.js";
import { createContainer } from "../container/runner.js";
import { ensureImage } from "../container/builder.js";
import { prepareRepoWorkspace, prepareFilesWorkspace } from "../container/workspace.js";
import { createIsolatedNetwork, applyFirewall } from "../container/network.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { prepareClaudeMounts, prepareCodexMounts } from "../auth/mount.js";
import { runValidationLoop, runLintGate, type LintGateResult } from "../validation/runner.js";
import { runReviewAgent, serializeReviewOutput } from "../validation/review-agent.js";
import type { ReviewOutput } from "../validation/review-agent.js";
import { invokeAgent } from "../agent/invoke.js";
import { createLoopDetectorState, recordReviewComments } from "../agent/loop-detector.js";
import { collectOutput } from "../output/collector.js";
import { cleanupRun, type CleanupContext } from "../container/cleanup.js";
import { Timer } from "../utils/timer.js";
import { emitRunEvent } from "../logging/events.js";
import { checkCostCeiling, BudgetExceededError } from "../agent/budget.js";
import { isComplexTask } from "../workflow/types.js";
import { buildFeatureBranchName } from "../planner/decompose-to-issues.js";

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

  // 3. Prepare credentials and build direct env vars
  const agentEnv: string[] = [];

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
    if (!plan.noTeam && plan.team && plan.team.size > 1) {
      const teammates = plan.team.size - 1;
      agentEnv.push(`CLAUDE_NUM_TEAMMATES=${teammates}`);
    }
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

  // 4. Create network (only for allowlist mode)
  if (plan.container.network.mode === "allowlist") {
    logger.info("prepare", "Creating isolated network...");
    await createIsolatedNetwork(plan.container.network.dockerNetwork);
    cleanup.networkName = plan.container.network.dockerNetwork;
  }

  // 5. Create container with resolved image
  logger.info("prepare", "Starting container...");
  const resolvedPlan = { ...plan, container: { ...plan.container, image: resolvedImage } };
  const container = await createContainer(resolvedPlan, binds);
  cleanup.container = container;

  // 6. Apply firewall (only for allowlist mode)
  if (plan.container.network.mode === "allowlist" && plan.container.network.allow) {
    logger.info("prepare", "Applying network firewall...");
    await applyFirewall(container, plan.container.network.allow);
  }

  // Build adapter and options
  const adapter = getAgentAdapter(plan.agent.type);
  const agentOptions = {
    model: plan.agent.model,
    maxTurns: plan.agent.maxTurns,
    timeout: plan.agent.timeout,
    flags: [...plan.agent.flags],
    workingDir: plan.input.mountPath,
  };

  return { container, adapter, agentOptions, agentEnv, resolvedImage };
}

export async function executeSingleAgent(
  plan: RunPlan,
  logger: Logger,
  noCleanup = false,
): Promise<ExecutionResult> {
  const timer = new Timer();
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  try {
    // --- Phase: Prepare ---
    const { container, adapter, agentOptions, agentEnv } = await prepareExecution(plan, logger, cleanup);

    // --- Feature branch for complex tasks ---
    if (!plan.featureBranch && isComplexTask(plan)) {
      plan = { ...plan, featureBranch: buildFeatureBranchName(plan.task) };
      logger.info("prepare", `Complex task detected — using feature branch: ${plan.featureBranch}`);
    }

    // --- Phase: Execute ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "execute" } });

    // Build handoff context from plan entries (if provided by pipeline or orchestrator)
    const handoffContext = plan.handoffEntries
      ? buildHandoffContext(plan.handoffEntries)
      : undefined;
    const prompt = buildPrompt(plan, { handoffContext });
    logger.info("agent", `Running ${plan.agent.type}...`);

    const session = createAgentSession(plan.agent.type, container, agentOptions, agentEnv, {
      onOutput: (chunk, stream) => {
        emitRunEvent({
          runId: plan.runId,
          type: "agent_output",
          timestamp: new Date().toISOString(),
          data: { stream, chunk },
        });
      },
    });
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

    // --- Phase: Lint Gate ---
    const lintOnOutput = (chunk: string, stream: "stdout" | "stderr") => {
      emitRunEvent({
        runId: plan.runId,
        type: "agent_output",
        timestamp: new Date().toISOString(),
        data: { stream, chunk, phase: "lint_fix" },
      });
    };
    let lintGateResult: LintGateResult | undefined;
    if (plan.validation.lintSteps.length > 0) {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "lint" } });
      logger.info("validation", `Running ${plan.validation.lintSteps.length} lint steps...`);
      lintGateResult = await runLintGate(
        container, plan.validation.lintSteps, plan.input.mountPath,
        adapter, agentOptions, agentEnv, logger, lintOnOutput,
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

    // --- Phase: Review Agent with self-addressing loop ---
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

        const mustFix = reviewOutput.comments.filter(c => c.severity === "MUST_FIX");
        if (mustFix.length === 0) {
          logger.info("review-agent", "No MUST_FIX comments — review passed");
          break;
        }

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

        if (plan.validation.lintSteps.length > 0) {
          const reLint = await runLintGate(
            container, plan.validation.lintSteps, plan.input.mountPath,
            adapter, agentOptions, agentEnv, logger, lintOnOutput,
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

    if (err instanceof BudgetExceededError) {
      emitRunEvent({
        runId: plan.runId,
        type: "failed",
        timestamp: new Date().toISOString(),
        data: { reason: "cost_ceiling_exceeded", error: message },
      });
    } else {
      emitRunEvent({
        runId: plan.runId,
        type: "failed",
        timestamp: new Date().toISOString(),
        data: { error: message },
      });
    }

    return {
      success: false,
      validation: { passed: false, totalAttempts: 0, stepResults: [] },
      durationMs: timer.elapsed(),
      error: message,
    };
  } finally {
    if (!noCleanup) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup)");
    }
  }
}
