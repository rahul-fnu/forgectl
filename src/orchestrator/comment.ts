import type { AgentStatus, TokenUsage } from "../agent/session.js";

export interface CommentData {
  status: AgentStatus;
  durationMs: number;
  agentType: string;
  attempt: number;
  tokenUsage: TokenUsage;
  validationResults?: Array<{ name: string; passed: boolean; error?: string }>;
  branch?: string;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "45s", "2m 34s", "1h 1m 1s"
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/**
 * Format a number with comma separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Build a structured markdown comment for posting to a tracker after a worker run.
 */
export function buildResultComment(data: CommentData): string {
  const statusEmoji = data.status === "completed" ? "Pass" : "Fail";
  const lines: string[] = [];

  lines.push("## forgectl Agent Report");
  lines.push("");
  lines.push(`**Status:** ${statusEmoji}`);
  lines.push(`**Agent:** ${data.agentType}`);
  lines.push(`**Attempt:** ${data.attempt}`);
  lines.push(`**Duration:** ${formatDuration(data.durationMs)}`);

  if (data.branch) {
    lines.push(`**Branch:** \`${data.branch}\``);
  }

  // Validation results section
  if (data.validationResults && data.validationResults.length > 0) {
    lines.push("");
    lines.push("### Validation Results");
    lines.push("");
    for (const result of data.validationResults) {
      const check = result.passed ? "[x]" : "[ ]";
      const errorSuffix = result.error ? ` — ${result.error}` : "";
      lines.push(`- ${check} ${result.name}${errorSuffix}`);
    }
  }

  // Token usage table
  lines.push("");
  lines.push("### Token Usage");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Input | ${formatNumber(data.tokenUsage.input)} |`);
  lines.push(`| Output | ${formatNumber(data.tokenUsage.output)} |`);
  lines.push(`| Total | ${formatNumber(data.tokenUsage.total)} |`);

  return lines.join("\n");
}
