import type { AlertEvent, AlertingConfig } from "./types.js";
import { dispatchWebhook } from "./webhook.js";
import { dispatchSlack } from "./slack.js";

export class AlertManager {
  private config: AlertingConfig;

  constructor(config: AlertingConfig) {
    this.config = config;
  }

  async fire(event: AlertEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.config.webhooks) {
      for (const target of this.config.webhooks) {
        promises.push(
          dispatchWebhook(target, event).catch(() => {
            // fire-and-forget: swallow errors
          }),
        );
      }
    }

    if (this.config.slack_webhook_url) {
      promises.push(
        dispatchSlack(this.config.slack_webhook_url, event).catch(() => {
          // fire-and-forget: swallow errors
        }),
      );
    }

    await Promise.allSettled(promises);
  }
}
