import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "./types.js";
import { collectGitOutput } from "./git.js";

export async function collectOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<OutputResult> {
  return collectGitOutput(container, plan, logger);
}
