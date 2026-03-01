import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { AgentAdapter, AgentOptions } from "../agent/types.js";
import { runValidationStep, type StepResult } from "./step.js";
import { formatFeedback } from "./feedback.js";
import { invokeAgent } from "../agent/invoke.js";

export interface ValidationResult {
  passed: boolean;
  totalAttempts: number;
  stepResults: Array<{
    name: string;
    passed: boolean;
    attempts: number;
  }>;
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

  while (attempt <= maxRetries) {
    attempt++;
    logger.info("validation", `Validation round ${attempt}/${maxRetries + 1}`);

    const results: StepResult[] = [];
    let allPassed = true;

    for (const step of steps) {
      logger.debug("validation", `Running: ${step.name} — ${step.command}`);
      const result = await runValidationStep(container, step, plan.input.mountPath);
      results.push(result);
      stepAttemptCounts[step.name]++;
      stepLastPassed[step.name] = result.passed;

      if (result.passed) {
        logger.info("validation", `✔ ${step.name} passed (${result.durationMs}ms)`);
      } else {
        logger.warn("validation", `✗ ${step.name} failed (exit ${result.exitCode})`);
        allPassed = false;
      }
    }

    if (allPassed) {
      logger.info("validation", "All validation steps passed");
      return {
        passed: true,
        totalAttempts: attempt,
        stepResults: steps.map(s => ({
          name: s.name,
          passed: true,
          attempts: stepAttemptCounts[s.name],
        })),
      };
    }

    if (attempt > maxRetries) {
      break;
    }

    // Feed errors back to agent
    const failedSteps = results.filter(r => !r.passed);
    const feedback = formatFeedback(failedSteps, plan.workflow.name);
    logger.info("validation", `${failedSteps.length} step(s) failed, sending feedback to agent`);

    // Re-invoke agent with feedback
    logger.info("agent", "Agent fixing validation failures...");
    const fixResult = await invokeAgent(
      container, adapter, feedback, agentOptions, agentEnv, `fix-${attempt}`
    );

    if (fixResult.exitCode !== 0) {
      logger.warn("agent", `Agent fix attempt exited with code ${fixResult.exitCode}`);
    }
  }

  // Exhausted retries
  logger.error("validation", `Validation failed after ${attempt} attempts`);
  return {
    passed: false,
    totalAttempts: attempt,
    stepResults: steps.map(s => ({
      name: s.name,
      passed: stepLastPassed[s.name],
      attempts: stepAttemptCounts[s.name],
    })),
  };
}
