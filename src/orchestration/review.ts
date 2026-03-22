import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { ExecutionResult } from "./single.js";
import { prepareExecution } from "./single.js";
import { createAgentSession } from "../agent/session.js";
import { buildPrompt } from "../context/prompt.js";
import { createContainer, destroyContainer } from "../container/runner.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { prepareClaudeMounts, prepareCodexMounts } from "../auth/mount.js";
import { runValidationLoop } from "../validation/runner.js";
import { collectOutput } from "../output/collector.js";
import { cleanupRun, type CleanupContext } from "../container/cleanup.js";
import { Timer } from "../utils/timer.js";
import { emitRunEvent } from "../logging/events.js";

export type ReviewSeverity = "MUST_FIX" | "SHOULD_FIX" | "NIT";

export interface ReviewComment {
  file: string;
  line: number;
  severity: ReviewSeverity;
  message: string;
  suggested_fix?: string;
}

export interface ReviewResult {
  approved: boolean;
  feedback: string;
  comments: ReviewComment[];
}

/** Max self-addressing rounds. No exceptions. */
const MAX_SELF_ADDRESS_ROUNDS = 2;

export function buildReviewPrompt(plan: RunPlan, round: number): string {
  const parts: string[] = [];

  // 1. Reviewer system prompt (from workflow definition)
  parts.push(plan.orchestration.review.system);

  // 2. Context about the task
  parts.push(`\n--- Original Task ---\n${plan.task}\n`);

  // 3. Instructions
  if (plan.output.mode === "git") {
    parts.push(`The implementer's changes are in this workspace. Run \`git diff HEAD~1\` to see the changes.`);
  } else {
    parts.push(`The implementer's output files are in ${plan.output.path}. Review their contents.`);
  }

  parts.push(`\nThis is review round ${round}. If the output is acceptable, respond with exactly: LGTM`);
  parts.push(`If there are issues, output a JSON array of structured comments between \`\`\`json and \`\`\` markers.`);
  parts.push(`Each comment must have: file (string), line (number), severity ("MUST_FIX" | "SHOULD_FIX" | "NIT"), message (string), and optionally suggested_fix (string).`);
  parts.push(`Example:`);
  parts.push("```json");
  parts.push(`[{"file":"src/foo.ts","line":42,"severity":"MUST_FIX","message":"Missing null check","suggested_fix":"Add if (x != null) guard"}]`);
  parts.push("```");

  return parts.join("\n");
}

/**
 * Parse structured review comments from a JSON code block in the reviewer output.
 * Returns an empty array if no valid structured comments are found.
 */
export function parseReviewComments(stdout: string): ReviewComment[] {
  const jsonMatch = /```json\s*([\s\S]*?)```/.exec(stdout);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    if (!Array.isArray(parsed)) return [];

    const validSeverities = new Set<string>(["MUST_FIX", "SHOULD_FIX", "NIT"]);
    return parsed.filter(
      (c: unknown): c is ReviewComment =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>).file === "string" &&
        typeof (c as Record<string, unknown>).line === "number" &&
        typeof (c as Record<string, unknown>).severity === "string" &&
        validSeverities.has((c as Record<string, unknown>).severity as string) &&
        typeof (c as Record<string, unknown>).message === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Filter comments to only actionable severities (MUST_FIX and SHOULD_FIX).
 * NITs are ignored in the self-addressing loop.
 */
export function filterActionableComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => c.severity === "MUST_FIX" || c.severity === "SHOULD_FIX");
}

export function parseReviewResult(stdout: string): ReviewResult {
  const trimmed = stdout.trim();
  const lastLines = trimmed.split("\n").slice(-5).join("\n").trim();

  // Check for approval markers (case-insensitive)
  const approved = /\b(LGTM|APPROVED)\b/i.test(lastLines);
  const comments = approved ? [] : parseReviewComments(stdout);

  return {
    approved,
    feedback: approved ? "" : trimmed,
    comments,
  };
}

export function buildFixPrompt(reviewFeedback: string, round: number): string {
  return [
    `REVIEW FEEDBACK (round ${round}):`,
    "",
    reviewFeedback,
    "",
    "Fix all issues listed above. The reviewer will check again after you're done.",
  ].join("\n");
}

/**
 * Build a structured fix prompt from parsed review comments.
 * Includes file, line, severity, and suggested_fix for each actionable comment.
 */
export function buildStructuredFixPrompt(comments: ReviewComment[], round: number): string {
  const parts: string[] = [
    `REVIEW COMMENTS (round ${round}) — address all items below:`,
    "",
  ];

  for (const c of comments) {
    parts.push(`[${c.severity}] ${c.file}:${c.line} — ${c.message}`);
    if (c.suggested_fix) {
      parts.push(`  Suggested fix: ${c.suggested_fix}`);
    }
    parts.push("");
  }

  parts.push("Fix all MUST_FIX and SHOULD_FIX issues. The reviewer will check again after you're done.");
  return parts.join("\n");
}

/**
 * Build a diff-scoped re-review prompt that limits the reviewer to only
 * changed files and previously flagged issues.
 */
export function buildDiffScopedReviewPrompt(
  plan: RunPlan,
  round: number,
  changedFiles: string[],
  previousComments: ReviewComment[],
): string {
  const parts: string[] = [];

  parts.push(plan.orchestration.review.system);
  parts.push(`\n--- Original Task ---\n${plan.task}\n`);

  parts.push(`This is re-review round ${round}. Only review the following changed files:`);
  for (const f of changedFiles) {
    parts.push(`  - ${f}`);
  }

  if (previousComments.length > 0) {
    parts.push(`\nPreviously flagged issues to verify are fixed:`);
    for (const c of previousComments) {
      parts.push(`  [${c.severity}] ${c.file}:${c.line} — ${c.message}`);
    }
  }

  parts.push(`\nDo NOT review files outside the list above. Do NOT flag new issues on already-approved code.`);
  parts.push(`If all previously flagged issues are resolved, respond with exactly: LGTM`);
  parts.push(`Otherwise, output remaining issues as a JSON array between \`\`\`json and \`\`\` markers.`);
  parts.push(`Each comment must have: file, line, severity ("MUST_FIX" | "SHOULD_FIX" | "NIT"), message, and optionally suggested_fix.`);

  return parts.join("\n");
}

/**
 * Copy the workspace from the implementer container to the reviewer container
 * using Docker's getArchive/putArchive (tar streaming).
 */
async function snapshotWorkspace(
  sourceContainer: Docker.Container,
  targetContainer: Docker.Container,
  sourcePath: string,
): Promise<void> {
  const archive = await sourceContainer.getArchive({ path: sourcePath });
  await targetContainer.putArchive(archive, { path: "/" });
}

/**
 * Prepare credentials and mounts for the reviewer container.
 */
async function prepareReviewerCredentials(
  agentType: string,
  runId: string,
  round: number,
  cleanup: CleanupContext,
): Promise<{ binds: string[]; agentEnv: string[] }> {
  const binds: string[] = [];
  const agentEnv: string[] = [];

  if (agentType === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) throw new Error("No Claude Code credentials configured for reviewer");
    const mounts = prepareClaudeMounts(auth, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`ANTHROPIC_API_KEY=${auth.apiKey}`);
    }
    agentEnv.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  } else {
    const auth = await getCodexAuth();
    if (!auth) throw new Error("No Codex credentials configured for reviewer. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    const mounts = prepareCodexMounts(auth, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
    }
    if (mounts.env.CODEX_HOME) {
      agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
    }
  }

  return { binds, agentEnv };
}

export async function executeReviewMode(
  plan: RunPlan,
  logger: Logger,
  noCleanup = false
): Promise<ExecutionResult> {
  const timer = new Timer();
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };
  const reviewerCleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  try {
    // --- Phase: Prepare (implementer) ---
    const { container, adapter, agentOptions, agentEnv, resolvedImage } =
      await prepareExecution(plan, logger, cleanup);

    // --- Phase: Execute ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "execute" } });

    const prompt = buildPrompt(plan);
    logger.info("agent", `Running ${plan.agent.type}...`);

    // Use AgentSession for the implementer invocation
    const implementerSession = createAgentSession(plan.agent.type, container, agentOptions, agentEnv);
    const agentResult = await implementerSession.invoke(prompt);
    await implementerSession.close();

    logger.info("agent", `Agent finished (status=${agentResult.status}, ${agentResult.durationMs}ms)`);
    if (agentResult.status === "failed") {
      logger.warn("agent", `Agent finished with status: ${agentResult.status}`);
      if (agentResult.stderr) {
        logger.debug("agent", `stderr: ${agentResult.stderr.slice(0, 500)}`);
      }
    }

    // --- Phase: Validate ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "validate" } });

    logger.info("validate", `Running ${plan.validation.steps.length} validation steps...`);
    let validationResult = await runValidationLoop(
      container, plan, adapter, agentOptions, agentEnv, logger
    );

    if (!validationResult.passed && plan.validation.onFailure === "abandon") {
      emitRunEvent({ runId: plan.runId, type: "failed", timestamp: new Date().toISOString(), data: { reason: "validation_failed" } });
      return {
        success: false,
        validation: validationResult,
        durationMs: timer.elapsed(),
        error: "Validation failed and on_failure is set to 'abandon'",
      };
    }

    // --- Phase: Review ---
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "review" } });

    const reviewAgent = plan.orchestration.review.agent;
    const reviewModel = plan.orchestration.review.model;

    // Self-addressing loop is hard-capped at MAX_SELF_ADDRESS_ROUNDS
    const maxRounds = Math.min(plan.orchestration.review.maxRounds, MAX_SELF_ADDRESS_ROUNDS);

    // Build a resolved plan for reviewer containers (same image as implementer)
    const resolvedPlan = { ...plan, container: { ...plan.container, image: resolvedImage } };

    const reviewOptions = {
      model: reviewModel,
      maxTurns: plan.agent.maxTurns,
      timeout: plan.agent.timeout,
      flags: plan.agent.flags,
      workingDir: plan.input.mountPath,
    };

    let approvedOnRound: number | undefined;
    let escalatedToHuman = false;
    const allReviewComments: ReviewComment[] = [];
    const reviewComments: Array<{ round: number; approved: boolean; feedback: string }> = [];

    for (let round = 1; round <= maxRounds; round++) {
      logger.info("review", `Starting review round ${round}/${maxRounds}...`);

      // Prepare reviewer credentials
      const reviewerCreds = await prepareReviewerCredentials(
        reviewAgent, plan.runId, round, reviewerCleanup
      );

      // Create reviewer container
      logger.info("review", "Launching reviewer container...");
      const reviewerContainer = await createContainer(resolvedPlan, reviewerCreds.binds);
      reviewerCleanup.container = reviewerContainer;

      // Snapshot workspace from implementer to reviewer
      await snapshotWorkspace(container, reviewerContainer, plan.input.mountPath);

      // Build review prompt — first round uses full review, subsequent rounds use diff-scoped
      let reviewPrompt: string;
      if (round === 1) {
        reviewPrompt = buildReviewPrompt(plan, round);
      } else {
        // Diff-scoped: only review changed files + previously flagged issues
        const changedFiles = [...new Set(allReviewComments.map((c) => c.file))];
        reviewPrompt = buildDiffScopedReviewPrompt(plan, round, changedFiles, allReviewComments);
      }

      logger.info("review", "Reviewer running...");
      const reviewerSession = createAgentSession(reviewAgent, reviewerContainer, reviewOptions, reviewerCreds.agentEnv);
      const reviewExecResult = await reviewerSession.invoke(reviewPrompt);
      await reviewerSession.close();

      // Parse review result with structured comments
      const parsed = parseReviewResult(reviewExecResult.stdout);

      // Destroy reviewer container for this round
      await destroyContainer(reviewerContainer);
      reviewerCleanup.container = undefined;

      reviewComments.push({ round, approved: parsed.approved, feedback: parsed.feedback });

      if (parsed.approved) {
        logger.info("review", `✔ Review round ${round}: APPROVED`);
        approvedOnRound = round;
        break;
      }

      // Extract actionable comments (MUST_FIX + SHOULD_FIX only)
      const actionable = filterActionableComments(parsed.comments);
      allReviewComments.push(...parsed.comments);

      logger.warn("review", `✗ Review round ${round}: ${parsed.comments.length} comments (${actionable.length} actionable)`);

      if (round < maxRounds) {
        // Self-addressing: feed structured comments back to implementing agent
        logger.info("review", "Feeding structured comments to implementer...");
        const fixPrompt = actionable.length > 0
          ? buildStructuredFixPrompt(actionable, round)
          : buildFixPrompt(parsed.feedback, round);

        logger.info("agent", "Agent fixing review issues...");
        const fixSession = createAgentSession(plan.agent.type, container, agentOptions, agentEnv);
        await fixSession.invoke(fixPrompt);
        await fixSession.close();

        // Re-validate after fix
        if (plan.validation.steps.length > 0) {
          logger.info("validate", "Re-validating after review fix...");
          validationResult = await runValidationLoop(
            container, plan, adapter, agentOptions, agentEnv, logger
          );

          if (!validationResult.passed && plan.validation.onFailure === "abandon") {
            emitRunEvent({
              runId: plan.runId, type: "failed", timestamp: new Date().toISOString(),
              data: { reason: "validation_failed_during_review" },
            });
            return {
              success: false,
              validation: validationResult,
              durationMs: timer.elapsed(),
              error: "Validation failed during review fix cycle",
              review: { totalRounds: round, approved: false, comments: allReviewComments },
            };
          }
        }
      } else {
        // Exhausted max rounds — escalate to human
        escalatedToHuman = true;
        logger.warn("review", `Escalating to human after ${maxRounds} failed review rounds`);
        emitRunEvent({
          runId: plan.runId,
          type: "escalation",
          timestamp: new Date().toISOString(),
          data: { reason: "review_max_rounds_exhausted", rounds: maxRounds, unresolvedComments: actionable.length },
        });
      }
    }

    // --- Phase: Collect Output ---
    const approved = approvedOnRound !== undefined;

    if (approved || validationResult.passed || plan.validation.onFailure === "output-wip") {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: new Date().toISOString(), data: { phase: "output" } });

      logger.info("output", `Collecting ${plan.output.mode} output...`);
      const output = await collectOutput(container, plan, logger);

      emitRunEvent({
        runId: plan.runId,
        type: "completed",
        timestamp: new Date().toISOString(),
        data: { success: approved, output },
      });

      return {
        success: approved,
        output,
        validation: validationResult,
        durationMs: timer.elapsed(),
        review: {
          totalRounds: approvedOnRound ?? maxRounds,
          approved,
          approvedOnRound,
          comments: allReviewComments,
          escalatedToHuman,
        },
      };
    }

    // Review not approved after max rounds
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: new Date().toISOString(),
      data: { reason: "review_not_approved" },
    });

    return {
      success: false,
      validation: validationResult,
      durationMs: timer.elapsed(),
      error: `Review not approved after ${maxRounds} rounds`,
      review: { totalRounds: maxRounds, approved: false, comments: allReviewComments, escalatedToHuman },
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
    // Always clean up reviewer resources
    await cleanupRun(reviewerCleanup);

    if (!noCleanup) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup)");
    }
  }
}
