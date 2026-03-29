import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type Interaction,
} from "discord.js";
import type { DiscordBotConfig } from "./types.js";
import type { RunEvent } from "../logging/events.js";
import { StreamSubscriber } from "./stream-subscriber.js";
import {
  buildTaskSubmittedEmbed,
  buildCompletedEmbed,
  buildFailedEmbed,
  buildProgressEmbed,
  buildClarificationEmbed,
  buildStatsEmbed,
  type DiscordEmbed,
} from "./embeds.js";

interface ActiveRun {
  runId: string;
  threadId: string;
  channelId: string;
  subscriber: StreamSubscriber;
  lastProgressUpdate: number;
}

const PROGRESS_THROTTLE_MS = 3000;

export class DiscordBot {
  private client: Client;
  private config: DiscordBotConfig;
  private activeRuns = new Map<string, ActiveRun>();
  // Maps thread ID -> run ID for clarification replies
  private threadToRun = new Map<string, string>();
  private stopping = false;

  constructor(config: DiscordBotConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, (msg) => void this.handleMessage(msg));
    this.client.on(Events.InteractionCreate, (interaction) => void this.handleInteraction(interaction));
  }

  async start(): Promise<void> {
    await this.client.login(this.config.token);
    console.log(`Discord bot logged in as ${this.client.user?.tag}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const run of this.activeRuns.values()) {
      run.subscriber.stop();
    }
    this.activeRuns.clear();
    this.threadToRun.clear();
    this.client.destroy();
  }

  private isAllowedChannel(channelId: string): boolean {
    if (!this.config.allowed_channel_ids || this.config.allowed_channel_ids.length === 0) {
      return true;
    }
    return this.config.allowed_channel_ids.includes(channelId);
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || this.stopping) return;

    // Check if this is a reply in a thread that maps to an active run (clarification flow)
    if (message.channel.isThread()) {
      const runId = this.threadToRun.get(message.channel.id);
      if (runId) {
        await this.handleClarificationReply(message, runId);
        return;
      }
    }

    // Check channel permissions
    const channelId = message.channel.isThread()
      ? (message.channel as ThreadChannel).parentId ?? message.channel.id
      : message.channel.id;
    if (!this.isAllowedChannel(channelId)) return;

    const content = message.content.trim();

    // Handle special commands
    if (content.startsWith("!forgectl ")) {
      const subcommand = content.slice("!forgectl ".length).trim();
      if (subcommand === "stats" || subcommand === "summary") {
        await this.handleStatsCommand(message);
        return;
      }
      if (subcommand === "status") {
        await this.handleStatusCommand(message);
        return;
      }
      if (subcommand.startsWith("help")) {
        await message.reply({
          embeds: [{
            title: "forgectl Discord Bot",
            description: [
              "**Send any message** to dispatch a task to forgectl.",
              "",
              "**Commands:**",
              "`!forgectl stats` - Show analytics summary",
              "`!forgectl status` - Show daemon status",
              "`!forgectl help` - Show this help",
              "",
              "**In task threads:**",
              "Reply to answer agent clarification questions.",
              "Use the buttons to approve/reject/retry runs.",
            ].join("\n"),
            color: 0x2f80ed,
          }],
        });
        return;
      }
    }

    // Any other message = dispatch as task
    if (content.length > 0) {
      await this.dispatchTask(message, content);
    }
  }

  private async dispatchTask(message: Message, task: string): Promise<void> {
    const daemonUrl = this.config.daemon_url;

    let runId: string;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.daemon_token) {
        headers["Authorization"] = `Bearer ${this.config.daemon_token}`;
      }

      const res = await fetch(`${daemonUrl}/api/v1/dispatch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: task, description: `Dispatched from Discord by ${message.author.tag}` }),
      });

      if (!res.ok) {
        // Fall back to /runs endpoint
        const runRes = await fetch(`${daemonUrl}/runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ task }),
        });

        if (!runRes.ok) {
          await message.reply(`Failed to dispatch task: ${runRes.status} ${runRes.statusText}`);
          return;
        }
        const runData = (await runRes.json()) as { id: string; status: string };
        runId = runData.id;
      } else {
        const data = (await res.json()) as { id?: string; parentIssue?: string; status: string };
        runId = data.id ?? data.parentIssue ?? `dispatch-${Date.now()}`;
      }
    } catch (err) {
      await message.reply(`Failed to connect to forgectl daemon: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Create a thread for this task
    let thread: ThreadChannel;
    try {
      if (message.channel.type === ChannelType.GuildText) {
        thread = await (message.channel as TextChannel).threads.create({
          name: `Task: ${task.slice(0, 90)}`,
          autoArchiveDuration: 1440,
          reason: `forgectl run ${runId}`,
        });
      } else {
        // DM or other channel type - reply inline
        await message.reply({ embeds: [buildTaskSubmittedEmbed(runId, task)] });
        this.subscribeToRun(runId, message.channel.id, message.channel.id);
        return;
      }
    } catch {
      await message.reply({ embeds: [buildTaskSubmittedEmbed(runId, task)] });
      return;
    }

    await thread.send({ embeds: [buildTaskSubmittedEmbed(runId, task)] });
    this.threadToRun.set(thread.id, runId);
    this.subscribeToRun(runId, thread.id, message.channel.id);
  }

  private subscribeToRun(runId: string, threadId: string, channelId: string): void {
    const subscriber = new StreamSubscriber();
    const activeRun: ActiveRun = {
      runId,
      threadId,
      channelId,
      subscriber,
      lastProgressUpdate: 0,
    };
    this.activeRuns.set(runId, activeRun);

    void subscriber.subscribe({
      daemonUrl: this.config.daemon_url,
      daemonToken: this.config.daemon_token,
      runId,
      onEvent: (event) => void this.handleRunEvent(activeRun, event),
      onError: (err) => {
        void this.sendToThread(threadId, `Stream connection error: ${err.message}`);
      },
      onClose: () => {
        this.activeRuns.delete(runId);
      },
    });
  }

  private async handleRunEvent(run: ActiveRun, event: RunEvent): Promise<void> {
    if (this.stopping) return;

    switch (event.type) {
      case "completed": {
        const embed = buildCompletedEmbed(run.runId, event.data);
        const row = this.buildActionButtons(run.runId);
        await this.sendEmbedToThread(run.threadId, embed, [row]);
        run.subscriber.stop();
        this.activeRuns.delete(run.runId);
        await this.notifyIfConfigured(`Run \`${run.runId}\` completed.`);
        break;
      }

      case "failed": {
        const embed = buildFailedEmbed(run.runId, event.data);
        const row = this.buildRetryButton(run.runId);
        await this.sendEmbedToThread(run.threadId, embed, [row]);
        run.subscriber.stop();
        this.activeRuns.delete(run.runId);
        await this.notifyIfConfigured(`Run \`${run.runId}\` failed.`);
        break;
      }

      case "approval_required":
      case "output_approval_required": {
        const question = String(event.data.question ?? event.data.message ?? "Approval needed");
        const embed = buildClarificationEmbed(run.runId, question);
        const row = this.buildApprovalButtons(run.runId);
        await this.sendEmbedToThread(run.threadId, embed, [row]);
        await this.notifyIfConfigured(`Run \`${run.runId}\` needs attention: ${question.slice(0, 200)}`);
        break;
      }

      case "usage_limit_paused":
      case "escalation": {
        const msg = String(event.data.message ?? event.data.reason ?? event.type);
        await this.sendToThread(run.threadId, `**Attention:** ${msg}`);
        await this.notifyIfConfigured(`Run \`${run.runId}\`: ${msg.slice(0, 200)}`);
        break;
      }

      default: {
        // Throttle progress updates
        const now = Date.now();
        if (now - run.lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
        run.lastProgressUpdate = now;

        const significantTypes = new Set([
          "phase", "validation_step_started", "validation_step_completed",
          "agent_started", "retry", "cost",
        ]);
        if (significantTypes.has(event.type)) {
          const embed = buildProgressEmbed(run.runId, event);
          await this.sendEmbedToThread(run.threadId, embed);
        }
        break;
      }
    }
  }

  private async handleClarificationReply(message: Message, runId: string): Promise<void> {
    const input = message.content.trim();
    if (!input) return;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.daemon_token) {
        headers["Authorization"] = `Bearer ${this.config.daemon_token}`;
      }

      const res = await fetch(`${this.config.daemon_url}/api/v1/runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input }),
      });

      if (res.ok) {
        await message.react("\u2705");
      } else {
        const data = (await res.json()) as { error?: { message?: string } };
        await message.reply(`Could not forward reply: ${data.error?.message ?? res.statusText}`);
      }
    } catch (err) {
      await message.reply(`Failed to forward reply: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;

    const [action, runId] = interaction.customId.split(":");
    if (!runId) return;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.daemon_token) {
      headers["Authorization"] = `Bearer ${this.config.daemon_token}`;
    }

    try {
      switch (action) {
        case "approve": {
          const res = await fetch(
            `${this.config.daemon_url}/api/v1/runs/${encodeURIComponent(runId)}/approve`,
            { method: "POST", headers },
          );
          if (res.ok) {
            await interaction.reply({ content: `Run \`${runId}\` approved.`, ephemeral: true });
          } else {
            await interaction.reply({ content: `Failed to approve: ${res.statusText}`, ephemeral: true });
          }
          break;
        }

        case "reject": {
          const res = await fetch(
            `${this.config.daemon_url}/api/v1/runs/${encodeURIComponent(runId)}/reject`,
            { method: "POST", headers, body: JSON.stringify({ reason: "Rejected via Discord" }) },
          );
          if (res.ok) {
            await interaction.reply({ content: `Run \`${runId}\` rejected.`, ephemeral: true });
          } else {
            await interaction.reply({ content: `Failed to reject: ${res.statusText}`, ephemeral: true });
          }
          break;
        }

        case "retry": {
          const res = await fetch(`${this.config.daemon_url}/runs`, {
            method: "POST",
            headers,
            body: JSON.stringify({ task: `Retry of ${runId}` }),
          });
          if (res.ok) {
            const data = (await res.json()) as { id: string };
            await interaction.reply({ content: `Retry submitted: \`${data.id}\``, ephemeral: true });
          } else {
            await interaction.reply({ content: `Failed to retry: ${res.statusText}`, ephemeral: true });
          }
          break;
        }

        default:
          await interaction.reply({ content: "Unknown action", ephemeral: true });
      }
    } catch (err) {
      await interaction.reply({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    }
  }

  private async handleStatsCommand(message: Message): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.daemon_token) {
        headers["Authorization"] = `Bearer ${this.config.daemon_token}`;
      }

      const res = await fetch(`${this.config.daemon_url}/api/v1/analytics/summary`, { headers });
      if (!res.ok) {
        await message.reply(`Failed to fetch stats: ${res.statusText}`);
        return;
      }

      const stats = (await res.json()) as Record<string, unknown>;
      await message.reply({ embeds: [buildStatsEmbed(stats)] });
    } catch (err) {
      await message.reply(`Failed to fetch stats: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleStatusCommand(message: Message): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.daemon_token) {
        headers["Authorization"] = `Bearer ${this.config.daemon_token}`;
      }

      const res = await fetch(`${this.config.daemon_url}/health`, { headers });
      if (!res.ok) {
        await message.reply("Daemon is not reachable.");
        return;
      }

      const health = (await res.json()) as { status: string; timestamp: string };
      await message.reply(`Daemon status: **${health.status}** (${health.timestamp})`);
    } catch {
      await message.reply("Daemon is not reachable.");
    }
  }

  private buildActionButtons(runId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${runId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject:${runId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`retry:${runId}`)
        .setLabel("Retry")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  private buildApprovalButtons(runId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${runId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject:${runId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
    );
  }

  private buildRetryButton(runId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`retry:${runId}`)
        .setLabel("Retry")
        .setStyle(ButtonStyle.Primary),
    );
  }

  private async sendToThread(threadId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch {
      // Channel may no longer exist
    }
  }

  private async sendEmbedToThread(
    threadId: string,
    embed: DiscordEmbed,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isTextBased()) {
        const payload: { embeds: DiscordEmbed[]; components?: ActionRowBuilder<ButtonBuilder>[] } = {
          embeds: [embed],
        };
        if (components) payload.components = components;
        await (channel as TextChannel).send(payload as any);
      }
    } catch {
      // Channel may no longer exist
    }
  }

  private async notifyIfConfigured(content: string): Promise<void> {
    if (!this.config.notification_channel_id) return;
    await this.sendToThread(this.config.notification_channel_id, content);
  }
}
