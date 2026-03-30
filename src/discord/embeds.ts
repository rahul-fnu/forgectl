import type { RunResult } from "../github/comments.js";
import type { AlertEvent, AlertEventType } from "../alerting/types.js";
import type { ChildStatus } from "../github/sub-issue-rollup.js";
import type { PlanPreview } from "../analysis/cost-predictor.js";
import type { RunEvent } from "../logging/events.js";

const COLOR_MAP: Record<AlertEventType, number> = {
  run_completed: 0x2eb886,
  run_failed: 0xa30200,
  cost_ceiling_hit: 0xdaa038,
  usage_limit_detected: 0xdaa038,
  review_escalated: 0xdaa038,
  claude_md_update: 0x5865f2,
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
  event: RunEvent,
): DiscordEmbed {
  const d = event.data;
  let description: string;

  switch (event.type) {
    case "phase":
      description = `Phase: **${String(d.phase ?? "unknown")}**`;
      break;
    case "agent_started":
      description = "Agent started working...";
      break;
    case "validation_step_completed": {
      const name = String(d.name ?? d.step ?? "check");
      const passed = Boolean(d.passed);
      description = `Validation step **${name}** ${passed ? "passed" : "failed"}`;
      break;
    }
    case "retry":
    case "agent_retry":
      description = `Retrying (attempt ${d.attempt ?? "?"})`;
      break;
    case "cost":
      description = `Current cost: **$${Number(d.costUsd ?? 0).toFixed(4)}**`;
      break;
    default:
      description = `Event: ${event.type}`;
      break;
  }

  return {
    title: `Run \`${runId}\``,
    description,
    color: 0x5865f2,
    footer: { text: `Event: ${event.type}` },
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
  totalRuns?: number;
  successRate?: number;
  totalCost?: number;
  avgDuration?: string;
}): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [];

  if (stats.totalRuns !== undefined) {
    fields.push({ name: "Total Runs", value: String(stats.totalRuns), inline: true });
  }
  if (stats.successRate !== undefined) {
    fields.push({ name: "Success Rate", value: `${(stats.successRate * 100).toFixed(1)}%`, inline: true });
  }
  if (stats.totalCost !== undefined) {
    fields.push({ name: "Total Cost", value: `$${stats.totalCost.toFixed(2)}`, inline: true });
  }
  if (stats.avgDuration !== undefined) {
    fields.push({ name: "Avg Duration", value: stats.avgDuration, inline: true });
  }

  return {
    title: "Analytics Summary",
    color: 0x5865f2,
    fields,
    footer: { text: "forgectl" },
  };
}

const MAX_DESCRIPTION_LEN = 4000;

function truncateDescription(text: string, maxLen = MAX_DESCRIPTION_LEN): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

export function buildTaskSubmittedEmbed(runId: string, task: string): DiscordEmbed {
  return {
    title: "Task Dispatched",
    description: truncateDescription(task),
    color: 0x5865f2,
    fields: [
      { name: "Run ID", value: runId, inline: true },
    ],
    footer: { text: "forgectl" },
  };
}

export function buildCompletedEmbed(
  runId: string,
  details: { filesChanged?: number; prUrl?: string; costUsd?: number; branch?: string },
): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [];

  if (details.filesChanged !== undefined) {
    fields.push({ name: "Files Changed", value: String(details.filesChanged), inline: true });
  }
  if (details.costUsd !== undefined) {
    fields.push({ name: "Cost", value: `$${details.costUsd}`, inline: true });
  }
  if (details.branch !== undefined) {
    fields.push({ name: "Branch", value: details.branch, inline: true });
  }
  if (details.prUrl !== undefined) {
    fields.push({ name: "Pull Request", value: details.prUrl, inline: false });
  }

  return {
    title: "Run Completed",
    description: `Run \`${runId}\``,
    color: 0x2eb886,
    fields,
    footer: { text: "forgectl" },
  };
}

export function buildFailedEmbed(
  runId: string,
  details: { error: string },
): DiscordEmbed {
  const errorValue = details.error.length > 1024
    ? details.error.slice(0, 1024)
    : details.error;

  return {
    title: "Run Failed",
    description: `Run \`${runId}\``,
    color: 0xa30200,
    fields: [
      { name: "Error", value: errorValue, inline: false },
    ],
    footer: { text: "forgectl" },
  };
}

export function buildClarificationEmbed(runId: string, question: string): DiscordEmbed {
  return {
    title: "Clarification Needed",
    description: truncateDescription(question),
    color: 0xdaa038,
    fields: [
      { name: "Run ID", value: runId, inline: true },
    ],
    footer: { text: "Reply in this thread to answer the agent's question" },
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
