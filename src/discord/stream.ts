import { EventEmitter } from "node:events";
import type { RunEvent } from "../logging/events.js";
import { runEvents } from "../logging/events.js";

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordPoster {
  postToThread(threadId: string, message: DiscordMessage): Promise<void>;
}

interface SubIssueRun {
  runId: string;
  identifier: string;
}

interface StreamOptions {
  runId: string;
  threadId: string;
  poster: DiscordPoster;
  port: number;
  token?: string;
  subIssues?: SubIssueRun[];
}

const THROTTLE_MS = 3000;
const MAX_AGENT_OUTPUT_LEN = 1500;

const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;

interface PendingBatch {
  messages: DiscordMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  lastSent: number;
}

export function formatRunEvent(event: RunEvent, prefix?: string): DiscordMessage | null {
  const d = event.data;
  const tag = prefix ? `[${prefix}] ` : "";

  switch (event.type) {
    case "agent_started":
      return { content: `${tag}Agent started working...` };

    case "agent_output": {
      if (d.stream !== "stderr") return null;
      const chunk = String(d.chunk ?? "").trim();
      if (!chunk) return null;
      const hasError = /error|ERR|fail/i.test(chunk);
      if (!hasError) return null;
      const truncated = chunk.length > MAX_AGENT_OUTPUT_LEN
        ? chunk.slice(0, MAX_AGENT_OUTPUT_LEN) + "\n...(truncated)"
        : chunk;
      return { content: `${tag}\`\`\`\n${truncated}\n\`\`\`` };
    }

    case "validation_step_started": {
      const name = d.step ?? d.name ?? "check";
      return { content: `${tag}Running: ${name}...` };
    }

    case "validation_step_completed": {
      const name = d.step ?? d.name ?? "check";
      if (d.passed) {
        const dur = typeof d.durationMs === "number" ? ` (${(d.durationMs / 1000).toFixed(1)}s)` : "";
        return { content: `${tag}${name} PASSED${dur}` };
      }
      const errOut = d.error ? `\n\`\`\`\n${String(d.error).slice(0, MAX_AGENT_OUTPUT_LEN)}\n\`\`\`` : "";
      return { content: `${tag}${name} FAILED${errOut}` };
    }

    case "agent_retry": {
      const attempt = d.attempt ?? "?";
      const max = d.maxAttempts ?? d.max ?? "?";
      return { content: `${tag}Retry attempt ${attempt}/${max} -- feeding errors back to agent` };
    }

    case "completed": {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
      if (d.durationMs != null) {
        fields.push({ name: "Duration", value: `${(Number(d.durationMs) / 1000).toFixed(1)}s`, inline: true });
      }
      if (d.costUsd != null) {
        fields.push({ name: "Cost", value: `$${Number(d.costUsd).toFixed(2)}`, inline: true });
      }
      if (d.prUrl) {
        fields.push({ name: "PR", value: String(d.prUrl), inline: false });
      }
      return {
        embeds: [{
          title: `${tag}Run Completed`,
          description: d.status === "success" ? "All checks passed" : String(d.status ?? "completed"),
          color: COLOR_GREEN,
          fields,
        }],
      };
    }

    case "failed": {
      const summary = d.error ?? d.reason ?? "Unknown error";
      return {
        embeds: [{
          title: `${tag}Run Failed`,
          description: String(summary).slice(0, 2000),
          color: COLOR_RED,
        }],
      };
    }

    default:
      return null;
  }
}

export class DiscordRunStream extends EventEmitter {
  private batches = new Map<string, PendingBatch>();
  private cleanups: Array<() => void> = [];
  private poster: DiscordPoster;
  private threadId: string;

  constructor(private options: StreamOptions) {
    super();
    this.poster = options.poster;
    this.threadId = options.threadId;
  }

  start(): void {
    this.subscribeToRun(this.options.runId);

    if (this.options.subIssues) {
      for (const sub of this.options.subIssues) {
        this.subscribeToRun(sub.runId, sub.identifier);
      }
    }
  }

  stop(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];

    for (const [, batch] of this.batches) {
      if (batch.timer) clearTimeout(batch.timer);
      if (batch.messages.length > 0) {
        this.flushBatch(batch);
      }
    }
    this.batches.clear();
  }

  private subscribeToRun(runId: string, prefix?: string): void {
    const handler = (event: RunEvent) => {
      const msg = formatRunEvent(event, prefix);
      if (msg) this.enqueue(runId, msg);
    };

    runEvents.on(`run:${runId}`, handler);
    this.cleanups.push(() => runEvents.off(`run:${runId}`, handler));
  }

  private enqueue(runId: string, msg: DiscordMessage): void {
    let batch = this.batches.get(runId);
    if (!batch) {
      batch = { messages: [], timer: null, lastSent: 0 };
      this.batches.set(runId, batch);
    }

    batch.messages.push(msg);

    const now = Date.now();
    const elapsed = now - batch.lastSent;

    if (elapsed >= THROTTLE_MS) {
      this.flushBatch(batch);
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => {
        batch!.timer = null;
        this.flushBatch(batch!);
      }, THROTTLE_MS - elapsed);
    }
  }

  private flushBatch(batch: PendingBatch): void {
    if (batch.messages.length === 0) return;

    const messages = batch.messages.splice(0);
    batch.lastSent = Date.now();

    const merged = mergeMessages(messages);
    this.poster.postToThread(this.threadId, merged).catch((err) => {
      this.emit("error", err);
    });
  }
}

export function mergeMessages(messages: DiscordMessage[]): DiscordMessage {
  if (messages.length === 1) return messages[0];

  const contentParts: string[] = [];
  const embeds: DiscordEmbed[] = [];

  for (const msg of messages) {
    if (msg.content) contentParts.push(msg.content);
    if (msg.embeds) embeds.push(...msg.embeds);
  }

  const result: DiscordMessage = {};
  if (contentParts.length > 0) result.content = contentParts.join("\n");
  if (embeds.length > 0) result.embeds = embeds;
  return result;
}

export interface CostSummaryData {
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  subIssues: Array<{
    identifier: string;
    prUrl?: string;
    status: string;
  }>;
}

export function formatCostSummary(data: CostSummaryData): DiscordMessage {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Total Tokens", value: data.totalTokens.toLocaleString(), inline: true },
    { name: "Cost", value: `$${data.costUsd.toFixed(2)}`, inline: true },
    { name: "Duration", value: `${(data.durationMs / 1000).toFixed(1)}s`, inline: true },
  ];

  for (const sub of data.subIssues) {
    const val = sub.prUrl ? `[${sub.status}](${sub.prUrl})` : sub.status;
    fields.push({ name: sub.identifier, value: val, inline: true });
  }

  return {
    embeds: [{
      title: "Run Summary",
      color: COLOR_GREEN,
      fields,
    }],
  };
}
