import type { AlertEvent, AlertEventType } from "./types.js";

const TIMEOUT_MS = 5000;

const COLOR_MAP: Record<AlertEventType, number> = {
  run_completed: 0x2eb886,
  run_failed: 0xa30200,
  cost_ceiling_hit: 0xdaa038,
  usage_limit_detected: 0xdaa038,
  review_escalated: 0xdaa038,
};

export function formatDiscordPayload(event: AlertEvent): Record<string, unknown> {
  const color = COLOR_MAP[event.type] ?? 0x808080;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Event", value: event.type, inline: true },
    { name: "Run", value: event.runId, inline: true },
  ];

  if (event.issueIdentifier) {
    fields.push({ name: "Issue", value: event.issueIdentifier, inline: true });
  }

  return {
    embeds: [
      {
        title: "forgectl Alert",
        description: event.message,
        color,
        fields,
        footer: { text: "forgectl" },
        timestamp: event.timestamp,
      },
    ],
  };
}

export async function dispatchDiscord(webhookUrl: string, event: AlertEvent): Promise<void> {
  const body = JSON.stringify(formatDiscordPayload(event));

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
