import type Docker from "dockerode";
import type { AgentAdapter, AgentOptions } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { ReviewFindingsRepository } from "../storage/repositories/review-findings.js";
import { invokeAgent } from "../agent/invoke.js";
import { load as yamlLoad } from "js-yaml";

export type ReviewSeverity = "MUST_FIX" | "SHOULD_FIX" | "NIT";

export interface ReviewComment {
  file: string;
  line: number;
  severity: ReviewSeverity;
  category: string;
  comment: string;
  suggested_fix?: string;
}

export interface ReviewSummary {
  must_fix: number;
  should_fix: number;
  nit: number;
  overall: string;
}

export interface ReviewOutput {
  comments: ReviewComment[];
  summary: ReviewSummary;
}

const VALID_SEVERITIES = new Set<string>(["MUST_FIX", "SHOULD_FIX", "NIT"]);

/**
 * Build the prompt for the review agent.
 * Instructs the agent to review code for architectural issues, edge cases,
 * error handling, abstraction level, and coupling — things linters can't catch.
 */
export function buildReviewAgentPrompt(task: string, workingDir: string): string {
  return [
    "You are an expert code reviewer. The code in this workspace has already passed linting.",
    "Focus ONLY on issues that linters cannot catch:",
    "",
    "1. Does this match architectural patterns? (module boundaries, dependency direction, naming conventions)",
    "2. Are there edge cases the tests don't cover?",
    "3. Does error handling match conventions? (typed errors, proper propagation, no swallowed exceptions)",
    "4. Is the abstraction level right — over-engineered or under-engineered?",
    "5. Does this change have unintended coupling to other modules?",
    "",
    `The original task was: ${task}`,
    "",
    `Review the changed files in ${workingDir}. Use \`git diff HEAD~1\` to see recent changes.`,
    "",
    "Output your review as YAML in the EXACT format below (no markdown fences, no extra text before or after the YAML):",
    "",
    "comments:",
    "  - file: path/to/file.ts",
    "    line: 42",
    "    severity: MUST_FIX",
    "    category: error_handling",
    '    comment: "Description of the issue"',
    '    suggested_fix: "How to fix it"',
    "summary:",
    "  must_fix: 1",
    "  should_fix: 0",
    "  nit: 0",
    '  overall: "Brief overall assessment"',
    "",
    "Severity levels:",
    "- MUST_FIX: Blocks merge. Correctness bugs, security issues, data loss risks.",
    "- SHOULD_FIX: Address if straightforward. Missing edge cases, weak error handling.",
    "- NIT: Style/preference. Surface in PR comments but don't block automation.",
    "",
    "If the code is clean and you have no comments, output:",
    "comments: []",
    "summary:",
    "  must_fix: 0",
    "  should_fix: 0",
    "  nit: 0",
    '  overall: "Code looks good"',
  ].join("\n");
}

/**
 * Parse the structured YAML review output from the agent.
 * Returns undefined if the output cannot be parsed as valid review YAML.
 */
export function parseReviewOutput(stdout: string): ReviewOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  // Try to extract YAML block — agent may wrap it in markdown fences
  let yamlText = trimmed;
  const fenceMatch = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fenceMatch) {
    yamlText = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(yamlText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;

  const obj = parsed as Record<string, unknown>;

  // Validate comments array
  const comments: ReviewComment[] = [];
  if (Array.isArray(obj.comments)) {
    for (const item of obj.comments) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;

      const file = typeof c.file === "string" ? c.file : undefined;
      const line = typeof c.line === "number" ? c.line : undefined;
      const severity = typeof c.severity === "string" ? c.severity.toUpperCase() : undefined;
      const category = typeof c.category === "string" ? c.category : "general";
      const comment = typeof c.comment === "string" ? c.comment : undefined;
      const suggested_fix = typeof c.suggested_fix === "string" ? c.suggested_fix : undefined;

      if (!file || !line || !severity || !VALID_SEVERITIES.has(severity) || !comment) {
        continue;
      }

      comments.push({
        file,
        line,
        severity: severity as ReviewSeverity,
        category,
        comment,
        ...(suggested_fix ? { suggested_fix } : {}),
      });
    }
  }

  // Validate summary
  let summary: ReviewSummary;
  if (obj.summary && typeof obj.summary === "object") {
    const s = obj.summary as Record<string, unknown>;
    summary = {
      must_fix: typeof s.must_fix === "number" ? s.must_fix : comments.filter(c => c.severity === "MUST_FIX").length,
      should_fix: typeof s.should_fix === "number" ? s.should_fix : comments.filter(c => c.severity === "SHOULD_FIX").length,
      nit: typeof s.nit === "number" ? s.nit : comments.filter(c => c.severity === "NIT").length,
      overall: typeof s.overall === "string" ? s.overall : "No summary provided",
    };
  } else {
    summary = {
      must_fix: comments.filter(c => c.severity === "MUST_FIX").length,
      should_fix: comments.filter(c => c.severity === "SHOULD_FIX").length,
      nit: comments.filter(c => c.severity === "NIT").length,
      overall: "No summary provided",
    };
  }

  return { comments, summary };
}

/**
 * Serialize review output to a JSON string suitable for review_comments_json.
 */
export function serializeReviewOutput(output: ReviewOutput): string {
  return JSON.stringify(output);
}

/**
 * Run the review agent inside a container. Only call this AFTER lint validation passes.
 *
 * Returns the parsed review output, or undefined if the agent fails or produces
 * unparseable output.
 */
export async function runReviewAgent(
  container: Docker.Container,
  adapter: AgentAdapter,
  agentOptions: AgentOptions,
  agentEnv: string[],
  task: string,
  logger: Logger,
): Promise<ReviewOutput | undefined> {
  const prompt = buildReviewAgentPrompt(task, agentOptions.workingDir);

  logger.info("review-agent", "Running review agent...");

  const result = await invokeAgent(
    container,
    adapter,
    prompt,
    agentOptions,
    agentEnv,
    "review",
  );

  if (result.exitCode !== 0) {
    logger.warn("review-agent", `Review agent exited with code ${result.exitCode}`);
    if (result.stderr) {
      logger.debug("review-agent", `stderr: ${result.stderr.slice(0, 500)}`);
    }
  }

  const output = parseReviewOutput(result.stdout);
  if (!output) {
    logger.warn("review-agent", "Could not parse review agent output as structured YAML");
    logger.debug("review-agent", `Raw output: ${result.stdout.slice(0, 1000)}`);
    return undefined;
  }

  logger.info(
    "review-agent",
    `Review complete: ${output.summary.must_fix} must-fix, ${output.summary.should_fix} should-fix, ${output.summary.nit} nit`,
  );

  return output;
}

/**
 * Extract the module directory from a file path.
 * e.g. "src/storage/repositories/runs.ts" -> "src/storage"
 */
export function extractModule(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length >= 2) {
    return parts.slice(0, 2).join("/");
  }
  return parts[0] || "*";
}

/**
 * Accumulate review findings from a review output.
 * Upserts each comment's category+pattern+module into the findings table,
 * then promotes any findings that have reached the threshold.
 */
export function accumulateFindings(
  output: ReviewOutput,
  repo: ReviewFindingsRepository,
  logger: Logger,
): number {
  for (const comment of output.comments) {
    const module = extractModule(comment.file);
    repo.upsertFinding({
      category: comment.category,
      pattern: comment.category,
      module,
      exampleComment: comment.comment,
    });
  }

  const promoted = repo.promoteEligible();
  if (promoted > 0) {
    logger.info("review-agent", `Promoted ${promoted} recurring findings to conventions`);
  }
  return promoted;
}

/**
 * Record calibration data from human review overrides.
 * Call this when a human overrides review agent comments.
 */
export function recordReviewCalibration(
  repo: ReviewFindingsRepository,
  module: string,
  totalComments: number,
  overriddenComments: number,
  logger: Logger,
): void {
  repo.recordCalibration(module, totalComments, overriddenComments);
  const calibration = repo.getCalibration(module);
  if (calibration && calibration.falsePositiveRate > 0.3) {
    logger.warn(
      "review-agent",
      `Miscalibration detected for module ${module}: ${(calibration.falsePositiveRate * 100).toFixed(1)}% false positive rate`,
    );
  }
}
