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

export interface RichCommentData extends CommentData {
  filesChanged?: Array<{ path: string; additions: number; deletions: number }>;
  costEstimate?: { inputCost: number; outputCost: number; totalCost: number; currency: string };
  validationDetails?: Array<{ name: string; passed: boolean; error?: string; stderr?: string; durationMs?: number }>;
}

/** Maximum comment length (safety margin below GitHub's 65535 limit). */
const MAX_COMMENT_LENGTH = 60000;

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

function isRichData(data: CommentData | RichCommentData): data is RichCommentData {
  const rich = data as RichCommentData;
  return !!(rich.filesChanged || rich.costEstimate || rich.validationDetails);
}

/**
 * Build file changes section.
 */
function buildFileChangesSection(files: Array<{ path: string; additions: number; deletions: number }>, maxFiles: number): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("### Changes");
  lines.push("");

  const displayed = files.slice(0, maxFiles);
  for (const file of displayed) {
    lines.push(`- \`${file.path}\` (+${file.additions} -${file.deletions})`);
  }

  if (files.length > maxFiles) {
    lines.push(`- ... and ${files.length - maxFiles} more files`);
  }

  return lines;
}

/**
 * Build cost estimate section.
 */
function buildCostSection(cost: { inputCost: number; outputCost: number; totalCost: number; currency: string }, tokenUsage: TokenUsage): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("### Estimated Cost");
  lines.push("");
  lines.push(`**Total:** ~$${cost.totalCost.toFixed(4)}`);
  lines.push(`- Input: $${cost.inputCost.toFixed(4)} (${formatNumber(tokenUsage.input)} tokens)`);
  lines.push(`- Output: $${cost.outputCost.toFixed(4)} (${formatNumber(tokenUsage.output)} tokens)`);
  return lines;
}

/**
 * Build enhanced validation details section with collapsible stderr.
 */
function buildValidationDetailsSection(
  details: Array<{ name: string; passed: boolean; error?: string; stderr?: string; durationMs?: number }>,
  maxStderrLength?: number,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("### Validation Details");
  lines.push("");

  for (const step of details) {
    const durationStr = step.durationMs !== undefined ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : "";

    if (!step.passed && step.stderr) {
      const stderr = maxStderrLength && step.stderr.length > maxStderrLength
        ? step.stderr.slice(0, maxStderrLength) + "\n... (truncated)"
        : step.stderr;

      lines.push("<details>");
      lines.push(`<summary>${step.name} -- failed${durationStr}</summary>`);
      lines.push("");
      lines.push("```");
      lines.push(stderr);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
    } else {
      const status = step.passed ? "passed" : "failed";
      const errorSuffix = step.error ? ` -- ${step.error}` : "";
      lines.push(`- ${step.name}: ${status}${durationStr}${errorSuffix}`);
    }
  }

  return lines;
}

/**
 * Build a structured markdown comment for posting to a tracker after a worker run.
 */
export function buildResultComment(data: CommentData | RichCommentData): string {
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

  // Validation results section (legacy format, always included if present)
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

  // Rich sections (only if RichCommentData)
  if (isRichData(data)) {
    const rich = data;

    // Cost estimate
    if (rich.costEstimate) {
      lines.push(...buildCostSection(rich.costEstimate, data.tokenUsage));
    }

    // File changes
    if (rich.filesChanged && rich.filesChanged.length > 0) {
      lines.push(...buildFileChangesSection(rich.filesChanged, 20));
    }

    // Enhanced validation details
    if (rich.validationDetails && rich.validationDetails.length > 0) {
      lines.push(...buildValidationDetailsSection(rich.validationDetails));
    }
  }

  let comment = lines.join("\n");

  // Length guard
  if (comment.length > MAX_COMMENT_LENGTH) {
    comment = applyLengthGuard(data, statusEmoji);
  }

  return comment;
}

/**
 * Rebuild comment with progressive truncation to stay under the limit.
 */
function applyLengthGuard(data: CommentData | RichCommentData, statusEmoji: string): string {
  const rich = data as RichCommentData;

  // Strategy 1: reduce files to 10, truncate stderr to 500 chars
  {
    const lines = buildBaseLines(data, statusEmoji);

    if (rich.costEstimate) {
      lines.push(...buildCostSection(rich.costEstimate, data.tokenUsage));
    }

    if (rich.filesChanged && rich.filesChanged.length > 0) {
      lines.push(...buildFileChangesSection(rich.filesChanged, 10));
    }

    if (rich.validationDetails && rich.validationDetails.length > 0) {
      lines.push(...buildValidationDetailsSection(rich.validationDetails, 500));
    }

    lines.push("");
    lines.push("*Comment truncated for length*");

    const result = lines.join("\n");
    if (result.length <= MAX_COMMENT_LENGTH) return result;
  }

  // Strategy 2: remove file changes entirely, keep truncated stderr
  {
    const lines = buildBaseLines(data, statusEmoji);

    if (rich.costEstimate) {
      lines.push(...buildCostSection(rich.costEstimate, data.tokenUsage));
    }

    if (rich.validationDetails && rich.validationDetails.length > 0) {
      lines.push(...buildValidationDetailsSection(rich.validationDetails, 500));
    }

    lines.push("");
    lines.push("*Comment truncated for length*");

    const result = lines.join("\n");
    if (result.length <= MAX_COMMENT_LENGTH) return result;
  }

  // Strategy 3: remove everything rich, just base comment
  const lines = buildBaseLines(data, statusEmoji);
  lines.push("");
  lines.push("*Comment truncated for length*");
  return lines.join("\n");
}

/**
 * Build the base (non-rich) lines of the comment.
 */
function buildBaseLines(data: CommentData | RichCommentData, statusEmoji: string): string[] {
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

  lines.push("");
  lines.push("### Token Usage");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Input | ${formatNumber(data.tokenUsage.input)} |`);
  lines.push(`| Output | ${formatNumber(data.tokenUsage.output)} |`);
  lines.push(`| Total | ${formatNumber(data.tokenUsage.total)} |`);

  return lines;
}
