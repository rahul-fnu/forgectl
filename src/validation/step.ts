import type Docker from "dockerode";
import { execInContainer, type ExecResult } from "../container/runner.js";
import type { ValidationStep } from "../config/schema.js";
import { parseDuration } from "../utils/duration.js";

export interface StepResult {
  step: ValidationStep;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a single validation step inside the container.
 */
export async function runValidationStep(
  container: Docker.Container,
  step: ValidationStep,
  workingDir: string
): Promise<StepResult> {
  const timeout = step.timeout ? parseDuration(step.timeout) : 60_000;

  const result: ExecResult = await execInContainer(
    container,
    ["sh", "-c", step.command],
    { workingDir, timeout }
  );

  return {
    step,
    passed: step.expect_failure === true ? result.exitCode !== 0 : result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
