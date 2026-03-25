import { formatDuration } from "../utils/duration.js";

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
