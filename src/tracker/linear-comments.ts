import { formatDuration } from "../utils/duration.js";
import type { RunSummary } from "../storage/repositories/runs.js";

export interface RunCommentData {
  runId: string;
  issueIdentifier: string;
  status: "success" | "failure" | "timeout" | "aborted" | "cost_ceiling_exceeded";
  durationMs: number;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  prUrl?: string;
  validationResults?: Array<{ name: string; passed: boolean; attempts: number }>;
  errorSummary?: string;
  branch?: string;
  runSummary?: RunSummary;
}

const STATUS_EMOJI: Record<RunCommentData["status"], string> = {
  success: "✅",
  failure: "❌",
  timeout: "⏰",
  aborted: "🛑",
  cost_ceiling_exceeded: "💰",
};

const STATUS_LABEL: Record<RunCommentData["status"], string> = {
  success: "Success",
  failure: "Failure",
  timeout: "Timeout",
  aborted: "Aborted",
  cost_ceiling_exceeded: "Cost Ceiling Exceeded",
};

export function formatRunComment(result: RunCommentData): string {
  const lines: string[] = [];
  const emoji = STATUS_EMOJI[result.status];
  const label = STATUS_LABEL[result.status];
  const duration = formatDuration(result.durationMs);

  lines.push(`${emoji} **forgectl run \`${result.runId}\`** — ${label}`);
  lines.push("");
  lines.push(`**Duration:** ${duration}`);

  if (result.tokenUsage) {
    const total = result.tokenUsage.input + result.tokenUsage.output;
    let tokenLine = `**Tokens:** ${total.toLocaleString()} (${result.tokenUsage.input.toLocaleString()} in / ${result.tokenUsage.output.toLocaleString()} out)`;
    if (result.costUsd != null) {
      tokenLine += ` · **Cost:** $${result.costUsd.toFixed(2)}`;
    }
    lines.push(tokenLine);
  } else if (result.costUsd != null) {
    lines.push(`**Cost:** $${result.costUsd.toFixed(2)}`);
  }

  if (result.prUrl) {
    lines.push(`**PR:** ${result.prUrl}`);
  }

  if (result.branch) {
    lines.push(`**Branch:** \`${result.branch}\``);
  }

  if (result.validationResults && result.validationResults.length > 0) {
    lines.push("");
    lines.push("**Validation:**");
    for (const v of result.validationResults) {
      const icon = v.passed ? "✅" : "❌";
      lines.push(`- ${icon} ${v.name} (${v.attempts} attempt${v.attempts !== 1 ? "s" : ""})`);
    }
  }

  if (result.errorSummary) {
    const truncated =
      result.errorSummary.length > 500
        ? result.errorSummary.slice(0, 500) + "…"
        : result.errorSummary;
    lines.push("");
    lines.push(`**Error:** ${truncated}`);
  }

  if (result.runSummary) {
    lines.push("");
    lines.push("**Run Summary:**");
    lines.push(`- **Approach:** ${result.runSummary.approach}`);
    lines.push(`- **Key Actions:** ${result.runSummary.keyActions}`);
    lines.push(`- **Obstacles:** ${result.runSummary.obstacles}`);
    lines.push(`- **Retries:** ${result.runSummary.retries}`);
    lines.push(`- **Outcome:** ${result.runSummary.outcome}`);
    lines.push(`- **Token Efficiency:** ${result.runSummary.tokenEfficiency}`);
  }

  return lines.join("\n");
}

export interface CostCeilingAbortData {
  runId: string;
  reason: string;
  costUsd?: number;
  task: string;
  maxCostUsd?: number;
  maxTokens?: number;
}

export function formatCostCeilingAbortComment(data: CostCeilingAbortData): string {
  const lines: string[] = [];
  lines.push(`💰 **forgectl run \`${data.runId}\`** — Cost Ceiling Exceeded`);
  lines.push("");
  lines.push(`**Reason:** ${data.reason}`);
  if (data.costUsd != null) {
    lines.push(`**Cumulative cost:** $${data.costUsd.toFixed(2)}`);
  }
  lines.push(`**Task:** ${data.task}`);
  lines.push("");
  lines.push("**Suggestion:** Increase the budget in the task spec or simplify the task to reduce cost.");
  if (data.maxCostUsd != null) {
    lines.push(`Current max_cost_usd: $${data.maxCostUsd.toFixed(2)}`);
  }
  if (data.maxTokens != null) {
    lines.push(`Current max_tokens: ${data.maxTokens.toLocaleString()}`);
  }
  return lines.join("\n");
}

export function shouldPostComment(
  status: RunCommentData["status"],
  commentEvents: string[],
): boolean {
  const statusToEvent: Record<RunCommentData["status"], string> = {
    success: "completed",
    failure: "failed",
    timeout: "timeout",
    aborted: "aborted",
    cost_ceiling_exceeded: "failed",
  };
  return commentEvents.includes(statusToEvent[status]);
}
