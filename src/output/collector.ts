import type Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";
import type { Logger } from "../logging/logger.js";
import type { OutputResult } from "./types.js";
import { collectGitOutput } from "./git.js";
import { collectFileOutput } from "./files.js";

export async function collectOutput(
  container: Docker.Container,
  plan: RunPlan,
  logger: Logger
): Promise<OutputResult> {
  if (plan.output.mode === "git") {
    return collectGitOutput(container, plan, logger);
  }
  return collectFileOutput(container, plan, logger);
}
