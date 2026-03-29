import type { RunEvent } from "../logging/events.js";

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
  url?: string;
}

const COLOR_SUCCESS = 0x2eb886;
const COLOR_FAILURE = 0xa30200;
const COLOR_WARNING = 0xdaa038;
const COLOR_INFO = 0x2f80ed;
const COLOR_PROGRESS = 0x808080;

export function buildTaskSubmittedEmbed(runId: string, task: string): DiscordEmbed {
  return {
    title: "Task Dispatched",
    description: task.length > 4000 ? task.slice(0, 4000) + "..." : task,
    color: COLOR_INFO,
    fields: [{ name: "Run ID", value: `\`${runId}\``, inline: true }],
    timestamp: new Date().toISOString(),
  };
}

export function buildCompletedEmbed(runId: string, data: Record<string, unknown>): DiscordEmbed {
  const fields: EmbedField[] = [
    { name: "Run ID", value: `\`${runId}\``, inline: true },
    { name: "Status", value: "Completed", inline: true },
  ];

  if (data.filesChanged !== undefined) {
    fields.push({ name: "Files Changed", value: String(data.filesChanged), inline: true });
  }
  if (data.prUrl) {
    fields.push({ name: "Pull Request", value: String(data.prUrl) });
  }
  if (data.branch) {
    fields.push({ name: "Branch", value: `\`${data.branch}\``, inline: true });
  }
  if (data.costUsd !== undefined) {
    fields.push({ name: "Cost", value: `$${Number(data.costUsd).toFixed(4)}`, inline: true });
  }

  return {
    title: "Run Completed",
    color: COLOR_SUCCESS,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function buildFailedEmbed(runId: string, data: Record<string, unknown>): DiscordEmbed {
  const fields: EmbedField[] = [
    { name: "Run ID", value: `\`${runId}\``, inline: true },
    { name: "Status", value: "Failed", inline: true },
  ];

  if (data.error) {
    fields.push({ name: "Error", value: String(data.error).slice(0, 1024) });
  }

  return {
    title: "Run Failed",
    color: COLOR_FAILURE,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function buildProgressEmbed(runId: string, event: RunEvent): DiscordEmbed {
  let description = "";
  const data = event.data;

  switch (event.type) {
    case "phase":
      description = `Phase: **${data.phase ?? "unknown"}**`;
      break;
    case "validation_step_started":
      description = `Validation: \`${data.name ?? data.command ?? "step"}\``;
      break;
    case "validation_step_completed":
      description = data.passed
        ? `Validation passed: \`${data.name ?? "step"}\``
        : `Validation failed: \`${data.name ?? "step"}\``;
      break;
    case "agent_started":
      description = "Agent started working...";
      break;
    case "retry":
      description = `Retrying (attempt ${data.attempt ?? "?"})`;
      break;
    case "cost":
      description = `Cost update: $${Number(data.costUsd ?? 0).toFixed(4)}`;
      break;
    default:
      description = data.message ? String(data.message) : event.type;
  }

  return {
    description,
    color: COLOR_PROGRESS,
    footer: { text: `${runId} | ${event.type}` },
  };
}

export function buildClarificationEmbed(runId: string, question: string): DiscordEmbed {
  return {
    title: "Clarification Needed",
    description: question.length > 4000 ? question.slice(0, 4000) + "..." : question,
    color: COLOR_WARNING,
    fields: [{ name: "Run ID", value: `\`${runId}\``, inline: true }],
    footer: { text: "Reply in this thread to answer" },
    timestamp: new Date().toISOString(),
  };
}

export function buildReviewEmbed(runId: string, data: Record<string, unknown>): DiscordEmbed {
  const fields: EmbedField[] = [
    { name: "Run ID", value: `\`${runId}\``, inline: true },
  ];

  if (data.round !== undefined) {
    fields.push({ name: "Review Round", value: String(data.round), inline: true });
  }
  if (data.comments !== undefined) {
    fields.push({ name: "Comments", value: String(data.comments), inline: true });
  }

  return {
    title: "Review Result",
    color: COLOR_INFO,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function buildStatsEmbed(stats: Record<string, unknown>): DiscordEmbed {
  const fields: EmbedField[] = [];

  if (stats.totalRuns !== undefined) fields.push({ name: "Total Runs", value: String(stats.totalRuns), inline: true });
  if (stats.successRate !== undefined) fields.push({ name: "Success Rate", value: `${(Number(stats.successRate) * 100).toFixed(1)}%`, inline: true });
  if (stats.totalCost !== undefined) fields.push({ name: "Total Cost", value: `$${Number(stats.totalCost).toFixed(2)}`, inline: true });
  if (stats.avgDuration !== undefined) fields.push({ name: "Avg Duration", value: String(stats.avgDuration), inline: true });

  return {
    title: "Analytics Summary",
    color: COLOR_INFO,
    fields,
    timestamp: new Date().toISOString(),
  };
}
