import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { AgentAdapter, AgentOptions } from "../agent/types.js";
import type { ValidationStep } from "../config/schema.js";
import { runValidationStep, type StepResult } from "./step.js";
import { formatFeedback, formatLintFeedback } from "./feedback.js";
import { invokeAgent } from "../agent/invoke.js";
import {
  createLoopDetectorState,
  recordValidationError,
  recordFileWrite,
  recordToolCall,
  type LoopPattern,
} from "../agent/loop-detector.js";
import { execInContainer } from "../container/runner.js";
import { extractFailureSignature, type FailureSignature } from "./failure-signature.js";
import { emitRunEvent } from "../logging/events.js";

export interface RepeatedFailureInfo {
  count: number;
  stepName: string;
  signature: string;
}

export interface ValidationResult {
  passed: boolean;
  totalAttempts: number;
  stepResults: Array<{
    name: string;
    passed: boolean;
    attempts: number;
  }>;
  /** Combined stdout+stderr from all steps in the final validation pass. Undefined when no steps are configured. */
  lastOutput?: string;
  /** Set when a loop pattern is detected during validation retries. */
  loopDetected?: LoopPattern;
  /** Set when the same failure signature repeats beyond maxSameFailures threshold. */
  repeatedFailure?: RepeatedFailureInfo;
}

/**
 * Run all validation steps. If any fail, format feedback, re-invoke the agent,
 * then restart ALL validation steps from the top. Repeat up to maxRetries.
 */
export async function runValidationLoop(
  container: Docker.Container,
  plan: RunPlan,
  adapter: AgentAdapter,
  agentOptions: AgentOptions,
  agentEnv: string[],
  logger: Logger
): Promise<ValidationResult> {
  const steps = plan.validation.steps;
  if (steps.length === 0) {
    logger.info("validation", "No validation steps configured");
    return { passed: true, totalAttempts: 0, stepResults: [] };
  }

  const maxRetries = Math.max(...steps.map(s => s.retries));
  const stepAttemptCounts: Record<string, number> = {};
  const stepLastPassed: Record<string, boolean> = {};
  for (const step of steps) {
    stepAttemptCounts[step.name] = 0;
    stepLastPassed[step.name] = false;
  }

  let attempt = 0;
  let lastResults: StepResult[] = [];
  const loopState = createLoopDetectorState();
  let detectedLoop: LoopPattern | null = null;
  const maxAttempts = maxRetries + 1;
  const failureSignatures = new Map<string, FailureSignature[]>();
  const maxSameFailures = plan.validation.maxSameFailures ?? 2;
  const onRepeatedFailure = plan.validation.onRepeatedFailure ?? "abort";
  let strategyChanged = false;

  while (attempt < maxAttempts) {
    attempt++;
    logger.info("validation", `Validation round ${attempt}/${maxAttempts}`);

    const results: StepResult[] = [];
    let allPassed = true;

    for (const step of steps) {
      logger.debug("validation", `Running: ${step.name} — ${step.command}`);
      emitRunEvent({
        runId: plan.runId,
        type: "validation_step_started",
        timestamp: new Date().toISOString(),
        data: { step: step.name, attempt },
      });
      const result = await runValidationStep(container, step, plan.input.mountPath);
      results.push(result);
      stepAttemptCounts[step.name]++;
      stepLastPassed[step.name] = result.passed;

      emitRunEvent({
        runId: plan.runId,
        type: "validation_step_completed",
        timestamp: new Date().toISOString(),
        data: { step: step.name, attempt, passed: result.passed, durationMs: result.durationMs },
      });

      if (result.passed) {
        logger.info("validation", `✔ ${step.name} passed (${result.durationMs}ms)`);
      } else {
        logger.warn("validation", `✗ ${step.name} failed (exit ${result.exitCode})`);
        allPassed = false;

        // Extract failure signature and track repeats
        const errorOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
        const signature = extractFailureSignature(step.name, errorOutput);
        const prev = failureSignatures.get(step.name) ?? [];
        const isRepeat = prev.some(s => s.key === signature.key);
        prev.push(signature);
        failureSignatures.set(step.name, prev);

        emitRunEvent({
          runId: plan.runId,
          type: "validation_step",
          timestamp: new Date().toISOString(),
          data: {
            step: step.name,
            attempt,
            passed: false,
            signature,
            isRepeat,
          },
        });

        // Check for repeated failure signatures (escalation)
        const sameKeyCount = prev.filter(s => s.key === signature.key).length;
        if (sameKeyCount >= maxSameFailures) {
          const repeatedFailure: RepeatedFailureInfo = {
            count: sameKeyCount,
            stepName: step.name,
            signature: signature.key,
          };

          if (onRepeatedFailure === "change_strategy" && !strategyChanged) {
            // First repeated failure in change_strategy mode: inject meta-prompt and continue
            strategyChanged = true;
            emitRunEvent({
              runId: plan.runId,
              type: "escalation",
              timestamp: new Date().toISOString(),
              data: { action: "change_strategy", count: sameKeyCount, stepName: step.name },
            });
            logger.warn("validation", `Repeated failure detected for ${step.name}, requesting strategy change`);
            // Reset signatures for this step so a second repeat can be detected
            failureSignatures.set(step.name, [signature]);
          } else {
            // Abort (or second repeat in change_strategy mode)
            const action = onRepeatedFailure === "change_strategy" ? "abort" : onRepeatedFailure;
            emitRunEvent({
              runId: plan.runId,
              type: "escalation",
              timestamp: new Date().toISOString(),
              data: { action, count: sameKeyCount, stepName: step.name },
            });
            logger.error("validation", `Repeated failure escalation (${action}) for ${step.name}`);
            const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
            return {
              passed: false,
              totalAttempts: attempt,
              stepResults: steps.map(s => ({
                name: s.name,
                passed: stepLastPassed[s.name],
                attempts: stepAttemptCounts[s.name],
              })),
              lastOutput: lastOutput || undefined,
              repeatedFailure,
            };
          }
        }

        // Check for repeated validation errors
        const loopCheck = recordValidationError(loopState, errorOutput);
        if (loopCheck) {
          detectedLoop = loopCheck;
          logger.error("validation", `Loop detected: ${loopCheck.detail}`);
        }
      }
    }

    lastResults = results;

    // Halt immediately on loop detection
    if (detectedLoop) {
      logger.error("validation", `Halting agent — loop pattern: ${detectedLoop.type}`);
      const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
      return {
        passed: false,
        totalAttempts: attempt,
        stepResults: steps.map(s => ({
          name: s.name,
          passed: stepLastPassed[s.name],
          attempts: stepAttemptCounts[s.name],
        })),
        lastOutput: lastOutput || undefined,
        loopDetected: detectedLoop,
      };
    }

    if (allPassed) {
      logger.info("validation", "All validation steps passed");
      const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
      return {
        passed: true,
        totalAttempts: attempt,
        stepResults: steps.map(s => ({
          name: s.name,
          passed: true,
          attempts: stepAttemptCounts[s.name],
        })),
        lastOutput: lastOutput || undefined,
      };
    }

    if (attempt >= maxAttempts) {
      break;
    }

    // Feed errors back to agent
    const failedSteps = results.filter(r => !r.passed);
    let feedback = formatFeedback(failedSteps, plan.workflow.name);
    logger.info("validation", `${failedSteps.length} step(s) failed, sending feedback to agent`);

    // Inject strategy change meta-prompt if triggered this round
    if (strategyChanged) {
      feedback = `The previous approach is not working. You must try a fundamentally different approach to fix this issue.\n\n${feedback}`;
    }

    // Re-invoke agent with feedback
    emitRunEvent({
      runId: plan.runId,
      type: "agent_retry",
      timestamp: new Date().toISOString(),
      data: { attempt, failedSteps: failedSteps.map(s => s.name) },
    });
    logger.info("agent", "Agent fixing validation failures...");
    const fixResult = await invokeAgent(
      container, adapter, feedback, agentOptions, agentEnv, `fix-${attempt}`,
      (chunk, stream) => {
        emitRunEvent({
          runId: plan.runId,
          type: "agent_output",
          timestamp: new Date().toISOString(),
          data: { stream, chunk, phase: "validation_fix", attempt },
        });
      },
    );

    if (fixResult.exitCode !== 0) {
      logger.warn("agent", `Agent fix attempt exited with code ${fixResult.exitCode}`);
    }

    // Track file writes via git diff after agent fix
    try {
      const diffResult = await execInContainer(container, [
        "git", "diff", "--name-only", "HEAD",
      ], { workingDir: plan.input.mountPath });
      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        const changedFiles = diffResult.stdout.trim().split("\n");
        for (const file of changedFiles) {
          const fileLoop = recordFileWrite(loopState, file);
          if (fileLoop) {
            detectedLoop = fileLoop;
            logger.error("validation", `Loop detected: ${fileLoop.detail}`);
          }
        }
      }
    } catch {
      // Best-effort — git diff may fail in non-git workspaces
    }

    // Track repeated tool calls by hashing the fix invocation
    const toolLoop = recordToolCall(loopState, "agent-fix", feedback);
    if (toolLoop) {
      detectedLoop = toolLoop;
      logger.error("validation", `Loop detected: ${toolLoop.detail}`);
    }

    // Halt immediately if file write or tool call loop detected
    if (detectedLoop) {
      logger.error("validation", `Halting agent — loop pattern: ${detectedLoop.type}`);
      const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
      return {
        passed: false,
        totalAttempts: attempt,
        stepResults: steps.map(s => ({
          name: s.name,
          passed: stepLastPassed[s.name],
          attempts: stepAttemptCounts[s.name],
        })),
        lastOutput: lastOutput || undefined,
        loopDetected: detectedLoop,
      };
    }
  }

  // Exhausted retries — capture output from the final pass
  logger.error("validation", `Validation failed after ${attempt} attempts`);
  const lastOutput = lastResults.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
  return {
    passed: false,
    totalAttempts: attempt,
    stepResults: steps.map(s => ({
      name: s.name,
      passed: stepLastPassed[s.name],
      attempts: stepAttemptCounts[s.name],
    })),
    lastOutput: lastOutput || undefined,
  };
}

export interface LintGateResult {
  passed: boolean;
  lintIterations: number;
  stepResults: Array<{
    name: string;
    passed: boolean;
    attempts: number;
  }>;
  lastOutput?: string;
}

/**
 * Run lint steps as the first validation pass before any LLM-based review.
 * Lint failures go directly back to the executing agent with exact error output.
 * Returns a structured result with lint_iterations count.
 */
export async function runLintGate(
  container: Docker.Container,
  lintSteps: ValidationStep[],
  workingDir: string,
  adapter: AgentAdapter,
  agentOptions: AgentOptions,
  agentEnv: string[],
  logger: Logger,
  onAgentOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<LintGateResult> {
  if (lintSteps.length === 0) {
    return { passed: true, lintIterations: 0, stepResults: [] };
  }

  const maxRetries = Math.max(...lintSteps.map(s => s.retries));
  const stepAttemptCounts: Record<string, number> = {};
  const stepLastPassed: Record<string, boolean> = {};
  for (const step of lintSteps) {
    stepAttemptCounts[step.name] = 0;
    stepLastPassed[step.name] = false;
  }

  let iteration = 0;
  let lastResults: StepResult[] = [];
  const maxLintAttempts = maxRetries + 1;

  while (iteration < maxLintAttempts) {
    iteration++;
    logger.info("validation", `Lint gate iteration ${iteration}/${maxLintAttempts}`);

    const results: StepResult[] = [];
    let allPassed = true;

    for (const step of lintSteps) {
      logger.debug("validation", `Lint: ${step.name} — ${step.command}`);
      const result = await runValidationStep(container, step, workingDir);
      results.push(result);
      stepAttemptCounts[step.name]++;
      stepLastPassed[step.name] = result.passed;

      if (result.passed) {
        logger.info("validation", `Lint ✔ ${step.name} passed (${result.durationMs}ms)`);
      } else {
        logger.warn("validation", `Lint ✗ ${step.name} failed (exit ${result.exitCode})`);
        allPassed = false;
      }
    }

    lastResults = results;

    if (allPassed) {
      logger.info("validation", "All lint checks passed");
      const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
      return {
        passed: true,
        lintIterations: iteration,
        stepResults: lintSteps.map(s => ({
          name: s.name,
          passed: true,
          attempts: stepAttemptCounts[s.name],
        })),
        lastOutput: lastOutput || undefined,
      };
    }

    if (iteration >= maxLintAttempts) {
      break;
    }

    // Feed lint errors directly back to agent
    const failedSteps = results.filter(r => !r.passed);
    const feedback = formatLintFeedback(failedSteps);
    logger.info("validation", `${failedSteps.length} lint step(s) failed, sending exact errors to agent`);

    logger.info("agent", "Agent fixing lint failures...");
    const fixResult = await invokeAgent(
      container, adapter, feedback, agentOptions, agentEnv, `lint-fix-${iteration}`,
      onAgentOutput,
    );

    if (fixResult.exitCode !== 0) {
      logger.warn("agent", `Agent lint fix attempt exited with code ${fixResult.exitCode}`);
    }
  }

  logger.error("validation", `Lint gate failed after ${iteration} iterations`);
  const lastOutput = lastResults.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");
  return {
    passed: false,
    lintIterations: iteration,
    stepResults: lintSteps.map(s => ({
      name: s.name,
      passed: stepLastPassed[s.name],
      attempts: stepAttemptCounts[s.name],
    })),
    lastOutput: lastOutput || undefined,
  };
}

/**
 * Run all validation steps once with no retries and no agent re-invocation.
 * Used as a final gate before output collection — if any step fails,
 * the run is marked failed and no PR is created.
 */
export async function runValidationGate(
  container: Docker.Container,
  steps: ValidationStep[],
  workingDir: string,
  logger: Logger,
): Promise<ValidationResult> {
  if (steps.length === 0) {
    return { passed: true, totalAttempts: 0, stepResults: [] };
  }

  logger.info("validation", "Running post-validation build gate");

  const results: StepResult[] = [];
  let allPassed = true;

  for (const step of steps) {
    const result = await runValidationStep(container, step, workingDir);
    results.push(result);

    if (result.passed) {
      logger.info("validation", `Gate ✔ ${step.name} passed`);
    } else {
      logger.error("validation", `Gate ✗ ${step.name} failed (exit ${result.exitCode})`);
      allPassed = false;
    }
  }

  const lastOutput = results.map(r => [r.stdout, r.stderr].filter(Boolean).join("\n")).join("\n");

  return {
    passed: allPassed,
    totalAttempts: 1,
    stepResults: steps.map((s, i) => ({
      name: s.name,
      passed: results[i].passed,
      attempts: 1,
    })),
    lastOutput: lastOutput || undefined,
  };
}
