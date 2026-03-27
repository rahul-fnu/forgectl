import crypto from "node:crypto";
import type { AlertEvent, WebhookTarget } from "./types.js";

const TIMEOUT_MS = 5000;

export function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function dispatchWebhook(target: WebhookTarget, event: AlertEvent): Promise<void> {
  if (!target.events.includes(event.type)) return;

  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (target.secret) {
    headers["X-Forgectl-Signature"] = signPayload(body, target.secret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await fetch(target.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
