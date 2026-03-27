import type { AlertEvent, AlertEventType } from "./types.js";

const TIMEOUT_MS = 5000;

const COLOR_MAP: Record<AlertEventType, string> = {
  run_completed: "#2eb886",   // green
  run_failed: "#a30200",      // red
  cost_ceiling_hit: "#daa038", // orange
  usage_limit_detected: "#daa038",
  review_escalated: "#daa038",
};

export function formatSlackBlocks(event: AlertEvent): Record<string, unknown> {
  const color = COLOR_MAP[event.type] ?? "#808080";

  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*Event:*\n${event.type}` },
    { type: "mrkdwn", text: `*Run:*\n${event.runId}` },
  ];

  if (event.issueIdentifier) {
    fields.push({ type: "mrkdwn", text: `*Issue:*\n${event.issueIdentifier}` });
  }

  return {
    attachments: [
      {
        color,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: event.message },
          },
          {
            type: "section",
            fields,
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `forgectl | ${event.timestamp}` },
            ],
          },
        ],
      },
    ],
  };
}

export async function dispatchSlack(webhookUrl: string, event: AlertEvent): Promise<void> {
  const body = JSON.stringify(formatSlackBlocks(event));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
