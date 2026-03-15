import type { IssueContext } from "./types.js";

/** Progress state for a running forgectl run. */
export interface RunProgress {
  runId: string;
  status: string;
  completedStages: string[];
  validationAttempt?: number;
  error?: string;
}

/** Final result of a completed forgectl run. */
export interface RunResult {
  runId: string;
  status: "success" | "failure";
  duration: string;
  cost?: { input_tokens?: number; output_tokens?: number; estimated_usd?: string };
  changes?: string[];
  validationResults?: { step: string; passed: boolean; output?: string }[];
  workflow?: string;
  agent?: string;
}

/** Octokit-like interface for GitHub API calls. */
interface OctokitLike {
  rest: {
    issues: {
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

const STAGE_LABELS: Record<string, string> = {
  agent_executing: "Agent executing",
  validating: "Validation",
  validation_retry: "Validation",
  collecting_output: "Output collection",
};

const STAGES = ["agent_executing", "validating", "collecting_output"] as const;

/**
 * Build a progress comment with a checklist of run stages.
 * Designed to be posted once and updated in-place as the run progresses.
 */
export function buildProgressComment(progress: RunProgress): string {
  const lines: string[] = [];

  lines.push(`## forgectl run \`${progress.runId}\``);
  lines.push("");

  for (const stage of STAGES) {
    const label = STAGE_LABELS[stage];
    const checked = progress.completedStages.includes(stage);
    let displayLabel = label;

    if (stage === "validating" && progress.validationAttempt) {
      displayLabel = `${label} (attempt ${progress.validationAttempt})`;
    }

    lines.push(`- [${checked ? "x" : " "}] ${displayLabel}`);
  }

  lines.push("");

  if (progress.error) {
    lines.push(`> **Error:** ${progress.error}`);
    lines.push("");
  }

  if (progress.status === "started") {
    lines.push("_Starting up..._");
  } else if (progress.status === "completed") {
    lines.push("_Run complete._");
  } else if (progress.status === "failed") {
    lines.push("_Run failed._");
  } else {
    lines.push(`_Status: ${progress.status}_`);
  }

  return lines.join("\n");
}

/**
 * Build a result comment with collapsible details sections.
 * Posted when a run completes (success or failure).
 */
export function buildResultComment(result: RunResult): string {
  const lines: string[] = [];
  const emoji = result.status === "success" ? "✅" : "❌";
  const statusText = result.status === "success" ? "Completed" : "Failed";

  // Summary line
  let summary = `${emoji} **${statusText}** in ${result.duration}`;
  lines.push(summary);
  lines.push("");

  if (result.workflow || result.agent) {
    const parts: string[] = [];
    if (result.workflow) parts.push(`Workflow: \`${result.workflow}\``);
    if (result.agent) parts.push(`Agent: \`${result.agent}\``);
    lines.push(parts.join(" | "));
    lines.push("");
  }

  // Changes section
  if (result.changes && result.changes.length > 0) {
    lines.push("<details>");
    lines.push(`<summary>Changes (${result.changes.length} files)</summary>`);
    lines.push("");
    for (const file of result.changes) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // Validation section
  if (result.validationResults && result.validationResults.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Validation</summary>");
    lines.push("");
    for (const v of result.validationResults) {
      const icon = v.passed ? "✅" : "❌";
      lines.push(`- ${icon} **${v.step}**${v.output ? `: ${v.output}` : ""}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }


  return lines.join("\n");
}

/**
 * Build a clarification comment requesting input from the issue author.
 * The run is paused until the author replies.
 */
export function buildClarificationComment(
  question: string,
  issueAuthor: string,
): string {
  const lines: string[] = [];

  lines.push(`@${issueAuthor} I have a question before I can continue:`);
  lines.push("");
  lines.push(`> ${question}`);
  lines.push("");
  lines.push("Reply to this comment to continue the run.");
  lines.push("");
  lines.push("_Run paused -- will resume when you reply_");

  return lines.join("\n");
}

/**
 * Create a new progress comment on a GitHub issue.
 * Returns the comment ID for future updates.
 */
export async function createProgressComment(
  octokit: OctokitLike,
  context: IssueContext,
  progress: RunProgress,
): Promise<number> {
  const body = buildProgressComment(progress);
  const response = await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.issueNumber,
    body,
  });
  return response.data.id;
}

/**
 * Update an existing progress comment in-place.
 */
export async function updateProgressComment(
  octokit: OctokitLike,
  context: IssueContext,
  commentId: number,
  progress: RunProgress,
): Promise<void> {
  const body = buildProgressComment(progress);
  await octokit.rest.issues.updateComment({
    owner: context.owner,
    repo: context.repo,
    comment_id: commentId,
    body,
  });
}
