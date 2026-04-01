export type AlertEventType =
  | "run_failed"
  | "run_completed"
  | "cost_ceiling_hit"
  | "usage_limit_detected"
  | "review_escalated";

export interface AlertEvent {
  type: AlertEventType;
  timestamp: string;
  runId: string;
  issueIdentifier?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WebhookTarget {
  url: string;
  events: AlertEventType[];
  secret?: string;
}

export interface AlertingConfig {
  webhooks?: WebhookTarget[];
  slack_webhook_url?: string;
}
