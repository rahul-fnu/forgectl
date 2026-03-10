import type { RunResult } from "./comments.js";

/** Octokit-like interface for check run API calls. */
interface OctokitChecks {
  rest: {
    checks: {
      create(params: {
        owner: string;
        repo: string;
        head_sha: string;
        name: string;
        status: string;
        external_id?: string;
      }): Promise<{ data: { id: number } }>;
      update(params: {
        owner: string;
        repo: string;
        check_run_id: number;
        status: string;
        conclusion?: string;
        output?: { title: string; summary: string };
      }): Promise<unknown>;
    };
  };
}

/**
 * Create a check run on a commit with in_progress status.
 * Returns the check run ID for subsequent updates.
 */
export async function createCheckRun(
  octokit: OctokitChecks,
  owner: string,
  repo: string,
  headSha: string,
  runId: string,
): Promise<number> {
  const response = await octokit.rest.checks.create({
    owner,
    repo,
    head_sha: headSha,
    name: "forgectl",
    status: "in_progress",
    external_id: runId,
  });
  return response.data.id;
}

/**
 * Update a check run's status and optional output.
 */
export async function updateCheckRun(
  octokit: OctokitChecks,
  owner: string,
  repo: string,
  checkRunId: number,
  status: string,
  output?: { title: string; summary: string },
): Promise<void> {
  const params: Parameters<typeof octokit.rest.checks.update>[0] = {
    owner,
    repo,
    check_run_id: checkRunId,
    status,
  };
  if (output) {
    params.output = output;
  }
  await octokit.rest.checks.update(params);
}

/**
 * Complete a check run with success or failure conclusion and summary output.
 */
export async function completeCheckRun(
  octokit: OctokitChecks,
  owner: string,
  repo: string,
  checkRunId: number,
  success: boolean,
  summary: string,
): Promise<void> {
  const conclusion = success ? "success" : "failure";
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion,
    output: {
      title: `forgectl - ${conclusion}`,
      summary,
    },
  });
}

/**
 * Build a markdown summary for a check run output from a run result.
 */
export function buildCheckSummary(result: RunResult): string {
  const lines: string[] = [];
  const emoji = result.status === "success" ? "+" : "x";

  lines.push(`## Run \`${result.runId}\``);
  lines.push("");
  lines.push(`**Status:** ${result.status} | **Duration:** ${result.duration}`);

  if (result.cost?.estimated_usd) {
    lines.push(`**Estimated cost:** ${result.cost.estimated_usd}`);
  }

  if (result.workflow || result.agent) {
    const parts: string[] = [];
    if (result.workflow) parts.push(`Workflow: \`${result.workflow}\``);
    if (result.agent) parts.push(`Agent: \`${result.agent}\``);
    lines.push(parts.join(" | "));
  }

  if (result.changes && result.changes.length > 0) {
    lines.push("");
    lines.push("### Changes");
    for (const file of result.changes) {
      lines.push(`- \`${file}\``);
    }
  }

  if (result.validationResults && result.validationResults.length > 0) {
    lines.push("");
    lines.push("### Validation");
    for (const v of result.validationResults) {
      const icon = v.passed ? "pass" : "FAIL";
      lines.push(`- [${icon}] **${v.step}**${v.output ? `: ${v.output}` : ""}`);
    }
  }

  if (result.cost) {
    lines.push("");
    lines.push("### Cost");
    if (result.cost.input_tokens !== undefined) {
      lines.push(`- Input tokens: ${result.cost.input_tokens}`);
    }
    if (result.cost.output_tokens !== undefined) {
      lines.push(`- Output tokens: ${result.cost.output_tokens}`);
    }
    if (result.cost.estimated_usd) {
      lines.push(`- Estimated: ${result.cost.estimated_usd}`);
    }
  }

  return lines.join("\n");
}
