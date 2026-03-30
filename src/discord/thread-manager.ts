import type {
  Client,
  TextChannel,
  ThreadChannel,
  MessageCreateOptions,
} from "discord.js";
import type { DiscordEmbed } from "./embeds.js";
import type { ThreadLifecycle } from "./types.js";

export class ThreadManager {
  private threads = new Map<string, string>();
  private lifecycles = new Map<string, ThreadLifecycle>();
  private client: Client;
  private channelId: string;

  constructor(client: Client, channelId: string) {
    this.client = client;
    this.channelId = channelId;
  }

  private async getChannel(): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel || !("threads" in channel)) {
      throw new Error(`Channel ${this.channelId} is not a text channel`);
    }
    return channel as TextChannel;
  }

  async getOrCreateThread(runId: string, title: string): Promise<ThreadChannel> {
    const existingThreadId = this.threads.get(runId);
    if (existingThreadId) {
      try {
        const channel = await this.client.channels.fetch(existingThreadId);
        if (channel) return channel as ThreadChannel;
      } catch {
        this.threads.delete(runId);
      }
    }

    const textChannel = await this.getChannel();
    const thread = await textChannel.threads.create({
      name: title.slice(0, 100),
      autoArchiveDuration: 1440, // 24 hours
    });
    this.threads.set(runId, thread.id);
    return thread;
  }

  async sendToThread(runId: string, options: MessageCreateOptions): Promise<void> {
    const threadId = this.threads.get(runId);
    if (!threadId) return;
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel;
      if (thread) {
        await thread.send(options);
      }
    } catch {
      // Swallow errors -- thread may have been deleted
    }
  }

  async sendEmbed(runId: string, embed: DiscordEmbed): Promise<void> {
    await this.sendToThread(runId, { embeds: [embed] });
  }

  async sendMessage(runId: string, content: string): Promise<void> {
    await this.sendToThread(runId, { content });
  }

  getThreadId(runId: string): string | undefined {
    return this.threads.get(runId);
  }

  setThreadId(runId: string, threadId: string): void {
    this.threads.set(runId, threadId);
  }

  removeThread(runId: string): void {
    this.threads.delete(runId);
    this.lifecycles.delete(runId);
  }

  findRunByThread(threadId: string): string | undefined {
    for (const [runId, tid] of this.threads) {
      if (tid === threadId) return runId;
    }
    return undefined;
  }

  setLifecycle(runId: string, lifecycle: ThreadLifecycle): void {
    this.lifecycles.set(runId, lifecycle);
  }

  getLifecycle(runId: string): ThreadLifecycle | undefined {
    return this.lifecycles.get(runId);
  }

  updateLifecycleStatus(runId: string, status: ThreadLifecycle["status"]): void {
    const lifecycle = this.lifecycles.get(runId);
    if (lifecycle) {
      lifecycle.status = status;
      lifecycle.updatedAt = Date.now();
    }
  }

  getActiveLifecycles(): ThreadLifecycle[] {
    return Array.from(this.lifecycles.values()).filter(
      (lc) => lc.status !== "completed" && lc.status !== "failed" && lc.status !== "cancelled",
    );
  }
}
