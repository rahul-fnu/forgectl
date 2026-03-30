import type { RunResult } from "../github/comments.js";
import type { AlertEvent, AlertEventType } from "../alerting/types.js";
import type { ChildStatus } from "../github/sub-issue-rollup.js";
import type { PlanPreview } from "../analysis/cost-predictor.js";

const COLOR_MAP: Record<AlertEventType, number> = {
  run_completed: 0x2eb886,
  run_failed: 0xa30200,
  cost_ceiling_hit: 0xdaa038,
  usage_limit_detected: 0xdaa038,
  review_escalated: 0xdaa038,
};

const STAGE_LABELS: Record<string, string> = {
  agent_executing: "Agent executing",
  validating: "Validation",
  collecting_output: "Output collection",
};

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export function buildAlertEmbed(event: AlertEvent): DiscordEmbed {
  const color = COLOR_MAP[event.type] ?? 0x808080;
  const fields: DiscordEmbed["fields"] = [
    { name: "Event", value: event.type, inline: true },
    { name: "Run", value: event.runId, inline: true },
  ];
  if (event.issueIdentifier) {
    fields.push({ name: "Issue", value: event.issueIdentifier, inline: true });
  }
  return {
    title: "forgectl Alert",
    description: event.message,
    color,
    fields,
    footer: { text: "forgectl" },
    timestamp: event.timestamp,
  };
}

export function buildProgressEmbed(
  runId: string,
  completedStages: string[],
  status: string,
  validationAttempt?: number,
  error?: string,
): DiscordEmbed {
  const lines: string[] = [];
  const stages = ["agent_executing", "validating", "collecting_output"] as const;

  for (const stage of stages) {
    const label = STAGE_LABELS[stage];
    const checked = completedStages.includes(stage);
    let displayLabel = label;
    if (stage === "validating" && validationAttempt) {
      displayLabel = `${label} (attempt ${validationAttempt})`;
    }
    lines.push(`${checked ? "✅" : "⬜"} ${displayLabel}`);
  }

  if (error) {
    lines.push(`\n**Error:** ${error}`);
  }

  let color = 0x5865f2; // blurple
  if (status === "completed") color = 0x2eb886;
  else if (status === "failed") color = 0xa30200;

  return {
    title: `Run \`${runId}\``,
    description: lines.join("\n"),
    color,
    footer: { text: `Status: ${status}` },
  };
}

export function buildResultEmbed(result: RunResult, prUrl?: string): DiscordEmbed {
  const color = result.status === "success" ? 0x2eb886 : 0xa30200;
  const emoji = result.status === "success" ? "✅" : "❌";
  const statusText = result.status === "success" ? "Completed" : "Failed";

  const fields: DiscordEmbed["fields"] = [
    { name: "Duration", value: result.duration, inline: true },
  ];

  if (result.workflow) {
    fields.push({ name: "Workflow", value: result.workflow, inline: true });
  }
  if (result.agent) {
    fields.push({ name: "Agent", value: result.agent, inline: true });
  }
  if (result.cost?.estimated_usd) {
    fields.push({ name: "Cost", value: `$${result.cost.estimated_usd}`, inline: true });
  }
  if (result.cost?.input_tokens || result.cost?.output_tokens) {
    const tokens = `In: ${result.cost?.input_tokens ?? 0} / Out: ${result.cost?.output_tokens ?? 0}`;
    fields.push({ name: "Tokens", value: tokens, inline: true });
  }
  if (prUrl) {
    fields.push({ name: "PR", value: prUrl, inline: false });
  }
  if (result.validationResults && result.validationResults.length > 0) {
    const valLines = result.validationResults.map(
      (v) => `${v.passed ? "✅" : "❌"} ${v.step}`,
    );
    fields.push({ name: "Validation", value: valLines.join("\n"), inline: false });
  }

  return {
    title: `${emoji} ${statusText}`,
    description: `Run \`${result.runId}\``,
    color,
    fields,
    footer: { text: "forgectl" },
  };
}

export function buildSubIssueProgressEmbed(
  parentTitle: string,
  children: ChildStatus[],
): DiscordEmbed {
  const EMOJI: Record<ChildStatus["state"], string> = {
    completed: "✅",
    in_progress: "⏳",
    pending: "⬜",
    failed: "❌",
    blocked: "⛔",
  };

  const lines = children.map((child) => {
    let line = `${EMOJI[child.state]} [${child.title}](${child.url})`;
    if (child.state === "failed" && child.errorSummary) {
      line += ` \u2014 ${child.errorSummary}`;
    }
    return line;
  });

  const completed = children.filter((c) => c.state === "completed").length;

  return {
    title: `Sub-Issue Progress: ${parentTitle}`,
    description: lines.join("\n"),
    color: 0x5865f2,
    footer: { text: `Progress: ${completed}/${children.length} complete` },
  };
}

export function buildStatusEmbed(
  runs: Array<{ id: string; status: string; task?: string; startedAt?: string }>,
): DiscordEmbed {
  if (runs.length === 0) {
    return {
      title: "forgectl Status",
      description: "No active runs.",
      color: 0x808080,
    };
  }

  const lines = runs.map((r) => {
    const task = r.task ? ` — ${r.task.slice(0, 60)}` : "";
    return `**${r.id}** \`${r.status}\`${task}`;
  });

  return {
    title: "forgectl Status",
    description: lines.join("\n"),
    color: 0x5865f2,
    footer: { text: `${runs.length} run(s)` },
  };
}

export function buildStatsEmbed(stats: {
  totalRuns: number;
  succeeded: number;
  failed: number;
  avgDurationMs?: number;
  totalCostUsd?: number;
}): DiscordEmbed {
  const successRate =
    stats.totalRuns > 0
      ? ((stats.succeeded / stats.totalRuns) * 100).toFixed(1)
      : "0.0";

  const fields: DiscordEmbed["fields"] = [
    { name: "Total Runs", value: String(stats.totalRuns), inline: true },
    { name: "Succeeded", value: String(stats.succeeded), inline: true },
    { name: "Failed", value: String(stats.failed), inline: true },
    { name: "Success Rate", value: `${successRate}%`, inline: true },
  ];

  if (stats.avgDurationMs !== undefined) {
    const avgSec = (stats.avgDurationMs / 1000).toFixed(1);
    fields.push({ name: "Avg Duration", value: `${avgSec}s`, inline: true });
  }
  if (stats.totalCostUsd !== undefined) {
    fields.push({ name: "Total Cost", value: `$${stats.totalCostUsd.toFixed(2)}`, inline: true });
  }

  return {
    title: "forgectl Stats",
    description: `Success rate: **${successRate}%** across ${stats.totalRuns} runs`,
    color: 0x5865f2,
    fields,
    footer: { text: "forgectl" },
  };
}

export function buildPlanPreviewEmbed(preview: PlanPreview): DiscordEmbed {
  const { prediction } = preview;

  const bulletList = preview.planBullets.length > 0
    ? preview.planBullets.map((b) => `- ${b}`).join("\n")
    : "_(no plan details available)_";

  const confidencePct = (prediction.confidence * 100).toFixed(0);
  const durationMin = (prediction.estimatedDurationMs / 60_000).toFixed(1);

  const fields: DiscordEmbed["fields"] = [
    { name: "Estimated Cost", value: `$${prediction.estimatedCostUsd.toFixed(2)}`, inline: true },
    { name: "Estimated Turns", value: String(prediction.estimatedTurns), inline: true },
    { name: "Estimated Duration", value: `${durationMin} min`, inline: true },
    { name: "Confidence", value: `${confidencePct}% (${prediction.basedOnRuns} historical runs)`, inline: true },
    { name: "Plan", value: bulletList, inline: false },
  ];

  return {
    title: `Plan Preview: \`${preview.runId}\``,
    description: `React with \\u2705 to approve or \\u274c to reject.`,
    color: 0xdaa038,
    fields,
    footer: { text: "forgectl — awaiting approval" },
  };
}
