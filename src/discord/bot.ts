import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type MessageReaction,
  type ChatInputCommandInteraction,
  type User,
  type TextChannel,
  type Guild,
  type ThreadChannel,
} from "discord.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { PlanPreview } from "../analysis/cost-predictor.js";
import { buildPlanPreviewEmbed, buildReactionControlsHelp } from "./embeds.js";
import type { AlertEvent } from "../alerting/types.js";
import { buildAlertEmbed } from "./embeds.js";
import { REACTION_CONTROLS, type ThreadLifecycle } from "./types.js";

export interface DiscordBotDeps {
  config: ForgectlConfig;
  logger: Logger;
  daemonPort: number;
  daemonToken: string;
}

export interface DispatchResult {
  status: string;
  id?: string;
  parentIssueId?: string;
  childIssues?: string[];
}

const REPO_URL_REGEX = /https?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+/;
const REPO_NAME_REGEX = /repo:\s*([\w.\-]+\/[\w.\-]+)/i;

export function extractRepo(text: string): string | undefined {
  const urlMatch = text.match(REPO_URL_REGEX);
  if (urlMatch) {
    const url = urlMatch[0];
    const parts = url.replace(/https?:\/\/github\.com\//, "").split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  }
  const nameMatch = text.match(REPO_NAME_REGEX);
  if (nameMatch) return nameMatch[1];
  return undefined;
}

export function truncateTitle(text: string, maxLen = 50): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\u2026";
}

export async function dispatchTask(
  task: string,
  repo: string | undefined,
  daemonPort: number,
  daemonToken: string,
): Promise<DispatchResult> {
  const body: Record<string, unknown> = { title: truncateTitle(task), description: task };
  if (repo) body.repo = repo;

  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dispatch failed (${res.status}): ${text}`);
  }

  return (await res.json()) as DispatchResult;
}

export async function fetchStatus(daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/runs`, {
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) return "Failed to fetch status.";
  const runs = (await res.json()) as Array<{ id: string; status: string; issueId?: string }>;
  if (runs.length === 0) return "No active runs.";
  return runs
    .slice(0, 10)
    .map((r) => `\u2022 \`${r.id}\` \u2014 ${r.status}`)
    .join("\n");
}

export async function triggerClaudeMdUpdate(workspace: string, daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/claude-md/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken}`,
    },
    body: JSON.stringify({ workspace }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { status: string; pr_url?: string };
  if (data.pr_url) return `CLAUDE.md updated! PR: ${data.pr_url}`;
  return `CLAUDE.md update: ${data.status}`;
}

export async function cancelRun(runId: string, daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: { message: "Unknown error" } }))) as { error?: { message?: string } };
    return `Failed to cancel: ${data.error?.message ?? res.statusText}`;
  }
  return `Run \`${runId}\` cancelled.`;
}

export async function retryRun(runId: string, daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: { message: "Unknown error" } }))) as { error?: { message?: string } };
    return `Failed to retry: ${data.error?.message ?? res.statusText}`;
  }
  return `Run \`${runId}\` retried.`;
}

export async function fetchBudget(daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/budget`, {
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) return "Failed to fetch budget.";
  const data = (await res.json()) as {
    dayCostUsd: number;
    dayInputTokens: number;
    dayOutputTokens: number;
    maxPerDay: number | null;
    maxPerRun: number | null;
  };
  const lines = [
    `**Today's Cost:** $${data.dayCostUsd.toFixed(4)}`,
    `**Tokens:** ${data.dayInputTokens.toLocaleString()} in / ${data.dayOutputTokens.toLocaleString()} out`,
  ];
  if (data.maxPerDay !== null) lines.push(`**Daily Limit:** $${data.maxPerDay.toFixed(2)}`);
  if (data.maxPerRun !== null) lines.push(`**Per-Run Limit:** $${data.maxPerRun.toFixed(2)}`);
  return lines.join("\n");
}

export async function fetchRepos(daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/repos`, {
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) return "Failed to fetch repos.";
  const repos = (await res.json()) as Array<{ name: string; source: string }>;
  if (repos.length === 0) return "No tracked repositories.";
  return repos.map((r) => `- \`${r.name}\` (${r.source})`).join("\n");
}

export async function fetchDigestData(daemonPort: number, daemonToken: string): Promise<{
  runs: Array<{ id: string; status: string; task?: string }>;
  budget: { dayCostUsd: number; maxPerDay: number | null } | null;
}> {
  const [runsRes, budgetRes] = await Promise.allSettled([
    fetch(`http://127.0.0.1:${daemonPort}/api/v1/runs`, { headers: { Authorization: `Bearer ${daemonToken}` } }),
    fetch(`http://127.0.0.1:${daemonPort}/api/v1/budget`, { headers: { Authorization: `Bearer ${daemonToken}` } }),
  ]);

  let runs: Array<{ id: string; status: string; task?: string }> = [];
  if (runsRes.status === "fulfilled" && runsRes.value.ok) {
    runs = (await runsRes.value.json()) as typeof runs;
  }

  let budget: { dayCostUsd: number; maxPerDay: number | null } | null = null;
  if (budgetRes.status === "fulfilled" && budgetRes.value.ok) {
    budget = (await budgetRes.value.json()) as typeof budget;
  }

  return { runs, budget };
}

export function formatDigest(data: {
  runs: Array<{ id: string; status: string; task?: string }>;
  budget: { dayCostUsd: number; maxPerDay: number | null } | null;
}): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [`**forgectl Daily Digest \u2014 ${now}**\n`];

  const total = data.runs.length;
  const failed = data.runs.filter((r) => r.status === "failed").length;
  const completed = data.runs.filter((r) => r.status === "completed").length;
  const running = data.runs.filter((r) => r.status === "running").length;

  lines.push(`**Runs:** ${total} total, ${completed} completed, ${failed} failed, ${running} running`);

  if (data.budget) {
    lines.push(`**Cost:** $${data.budget.dayCostUsd.toFixed(4)}`);
    if (data.budget.maxPerDay !== null) {
      lines.push(`**Budget:** $${data.budget.dayCostUsd.toFixed(2)} / $${data.budget.maxPerDay.toFixed(2)}`);
    }
  }

  if (failed > 0) {
    lines.push("\n**Failed Runs:**");
    for (const r of data.runs.filter((r) => r.status === "failed").slice(0, 5)) {
      const task = r.task ? ` \u2014 ${r.task.slice(0, 60)}` : "";
      lines.push(`- \`${r.id}\`${task}`);
    }
  }

  return lines.join("\n");
}

export async function fetchStats(daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/analytics/summary`, {
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) return "Failed to fetch stats.";
  const data = (await res.json()) as Record<string, unknown>;
  return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

export interface PendingApproval {
  runId: string;
  messageId: string;
  task: string;
  repo: string | undefined;
  resolve: (approved: boolean) => void;
}

export class DiscordBot {
  private client: Client;
  private threadMap = new Map<string, string>();
  private lifecycles = new Map<string, ThreadLifecycle>();
  private channelRepoMap = new Map<string, { repo: string; workflow?: string }>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private config: ForgectlConfig;
  private logger: Logger;
  private daemonPort: number;
  private daemonToken: string;
  private statusChannelId: string | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DiscordBotDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.daemonPort = deps.daemonPort;
    this.daemonToken = deps.daemonToken;

    // Build channel-to-repo lookup from config
    if (this.config.discord?.channel_repos) {
      for (const mapping of this.config.discord.channel_repos) {
        this.channelRepoMap.set(mapping.channel_id, {
          repo: mapping.repo,
          workflow: mapping.workflow,
        });
      }
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, (msg: Message) => {
      void this.handleMessage(msg);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleSlashCommand(interaction as ChatInputCommandInteraction);
      }
    });

    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.handleReaction(reaction as MessageReaction, user as User);
    });
  }

  async start(): Promise<void> {
    const token = this.resolveBotToken();
    if (!token) {
      this.logger.warn("discord", "No bot token configured, Discord bot not started");
      return;
    }

    await this.registerSlashCommands(token);
    await this.client.login(token);
    this.logger.info("discord", `Discord bot logged in as ${this.client.user?.tag ?? "unknown"}`);

    await this.ensureStatusChannel();
    this.startDigestSchedule();
  }

  async stop(): Promise<void> {
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    this.client.destroy();
  }

  getClient(): Client {
    return this.client;
  }

  getThreadMap(): Map<string, string> {
    return this.threadMap;
  }

  getLifecycles(): Map<string, ThreadLifecycle> {
    return this.lifecycles;
  }

  getChannelRepoMap(): Map<string, { repo: string; workflow?: string }> {
    return this.channelRepoMap;
  }

  /** Resolve repo for a channel: channel_repos mapping first, then extract from message text. */
  resolveRepoForChannel(channelId: string, messageText: string): string | undefined {
    const mapping = this.channelRepoMap.get(channelId);
    if (mapping) return mapping.repo;
    return extractRepo(messageText);
  }

  private resolveBotToken(): string {
    const cfgToken = this.config.discord?.bot_token;
    if (cfgToken) return cfgToken;
    return process.env.DISCORD_BOT_TOKEN ?? "";
  }

  private isListenChannel(channelId: string): boolean {
    // If channel_repos is configured, only listen on mapped channels + any in channel_ids
    if (this.channelRepoMap.size > 0) {
      if (this.channelRepoMap.has(channelId)) return true;
    }
    const ids = this.config.discord?.channel_ids;
    if (!ids || ids.length === 0) {
      // If no channel_repos and no channel_ids, listen everywhere
      return this.channelRepoMap.size === 0;
    }
    return ids.includes(channelId);
  }

  async handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;
    if (!this.isListenChannel(msg.channelId)) return;

    const task = msg.content.trim();
    if (!task) return;

    // Channel = repo: resolve repo from channel mapping first
    const repo = this.resolveRepoForChannel(msg.channelId, task);
    const repoTag = repo ? ` [${repo}]` : "";
    const threadName = `Task: ${truncateTitle(task, 80)}`;

    try {
      const thread = await msg.startThread({ name: threadName });

      const result = await dispatchTask(task, repo, this.daemonPort, this.daemonToken);

      const lifecycle: ThreadLifecycle = {
        runId: result.id ?? result.parentIssueId ?? "",
        threadId: thread.id,
        channelId: msg.channelId,
        repo,
        task,
        status: "dispatched",
        userId: msg.author.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (result.status === "decomposed" && result.childIssues) {
        const issueList = result.childIssues.map((c) => `\u2022 ${c}`).join("\n");
        await thread.send(`Task decomposed into sub-issues${repoTag}:\n${issueList}`);
        if (result.parentIssueId) {
          this.threadMap.set(thread.id, result.parentIssueId);
          lifecycle.runId = result.parentIssueId;
        }
      } else {
        await thread.send(`Task dispatched${repoTag}! Run ID: \`${result.id}\``);
        if (result.id) {
          this.threadMap.set(thread.id, result.id);
        }
      }

      // Store lifecycle for thread tracking
      this.lifecycles.set(thread.id, lifecycle);

      // Add reaction controls to the dispatch confirmation
      if (this.config.discord?.reaction_controls !== false) {
        await this.addReactionControls(thread, lifecycle.status);
      }
    } catch (err) {
      this.logger.error("discord", `Failed to handle message: ${err}`);
      try {
        await msg.reply(`Failed to dispatch task: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore reply failure */ }
    }
  }

  /** Add appropriate reaction controls to the last message in a thread. */
  private async addReactionControls(thread: ThreadChannel, status: string): Promise<void> {
    try {
      const messages = await thread.messages.fetch({ limit: 1 });
      const lastMsg = messages.first();
      if (!lastMsg) return;

      if (status === "dispatched" || status === "running" || status === "validating") {
        await lastMsg.react(REACTION_CONTROLS.CANCEL);
        await lastMsg.react(REACTION_CONTROLS.PAUSE);
        await lastMsg.react(REACTION_CONTROLS.LOGS);
      } else if (status === "failed") {
        await lastMsg.react(REACTION_CONTROLS.RETRY);
        await lastMsg.react(REACTION_CONTROLS.LOGS);
      } else if (status === "paused") {
        await lastMsg.react(REACTION_CONTROLS.APPROVE);
        await lastMsg.react(REACTION_CONTROLS.CANCEL);
      }
    } catch (err) {
      this.logger.warn("discord", `Failed to add reaction controls: ${err}`);
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(false);

    if (sub === "status") {
      await interaction.deferReply();
      const status = await fetchStatus(this.daemonPort, this.daemonToken);
      await interaction.editReply(status);
      return;
    }

    if (sub === "stats") {
      await interaction.deferReply();
      const stats = await fetchStats(this.daemonPort, this.daemonToken);
      await interaction.editReply(stats);
      return;
    }

    if (sub === "cancel") {
      await interaction.deferReply();
      const runId = interaction.options.getString("run_id") ?? "";
      if (!runId) {
        await interaction.editReply("Please provide a run ID.");
        return;
      }
      const result = await cancelRun(runId, this.daemonPort, this.daemonToken);
      await interaction.editReply(result);
      return;
    }

    if (sub === "budget") {
      await interaction.deferReply();
      const result = await fetchBudget(this.daemonPort, this.daemonToken);
      await interaction.editReply(result);
      return;
    }

    if (sub === "repos") {
      await interaction.deferReply();
      const result = await fetchRepos(this.daemonPort, this.daemonToken);

      // Also show channel-repo mappings
      if (this.channelRepoMap.size > 0) {
        const mappings = Array.from(this.channelRepoMap.entries())
          .map(([chId, m]) => `- <#${chId}> \u2192 \`${m.repo}\`${m.workflow ? ` (workflow: ${m.workflow})` : ""}`)
          .join("\n");
        await interaction.editReply(`${result}\n\n**Channel Mappings:**\n${mappings}`);
      } else {
        await interaction.editReply(result);
      }
      return;
    }

    if (sub === "update-claude-md") {
      await interaction.deferReply();
      const workspace = interaction.options.getString("workspace") ?? "";
      try {
        const result = await triggerClaudeMdUpdate(workspace, this.daemonPort, this.daemonToken);
        await interaction.editReply(result);
      } catch (err) {
        await interaction.editReply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (sub === "map-channel") {
      await interaction.deferReply();
      const channelId = interaction.options.getString("channel_id") ?? interaction.channelId;
      const repo = interaction.options.getString("repo") ?? "";
      const workflow = interaction.options.getString("workflow") ?? undefined;

      if (!repo) {
        await interaction.editReply("Please provide a repository (e.g., `owner/repo`).");
        return;
      }

      this.channelRepoMap.set(channelId, { repo, workflow });
      const workflowNote = workflow ? ` (workflow: ${workflow})` : "";
      await interaction.editReply(`Channel <#${channelId}> mapped to \`${repo}\`${workflowNote}. Messages in that channel will dispatch tasks to this repo.`);
      return;
    }

    if (sub === "unmap-channel") {
      await interaction.deferReply();
      const channelId = interaction.options.getString("channel_id") ?? interaction.channelId;
      const hadMapping = this.channelRepoMap.delete(channelId);
      if (hadMapping) {
        await interaction.editReply(`Channel <#${channelId}> unmapped. Messages will fall back to repo detection from message text.`);
      } else {
        await interaction.editReply(`Channel <#${channelId}> had no repo mapping.`);
      }
      return;
    }

    if (sub === "controls") {
      await interaction.deferReply();
      const embed = buildReactionControlsHelp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Default: dispatch a task
    const task = interaction.options.getString("task");
    if (!task) {
      await interaction.reply("Please provide a task description.");
      return;
    }

    await interaction.deferReply();
    try {
      const repo = this.resolveRepoForChannel(interaction.channelId, task);
      const result = await dispatchTask(task, repo, this.daemonPort, this.daemonToken);

      if (result.status === "decomposed" && result.childIssues) {
        const issueList = result.childIssues.map((c) => `\u2022 ${c}`).join("\n");
        await interaction.editReply(`Task decomposed into sub-issues:\n${issueList}`);
      } else {
        await interaction.editReply(`Task dispatched! Run ID: \`${result.id}\``);
      }
    } catch (err) {
      await interaction.editReply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async postPlanPreview(
    channelId: string,
    preview: PlanPreview,
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) return false;

    const embed = buildPlanPreviewEmbed(preview);
    const msg = await (channel as { send: (opts: unknown) => Promise<Message> }).send({
      embeds: [embed],
    });

    await msg.react(REACTION_CONTROLS.APPROVE);
    await msg.react(REACTION_CONTROLS.REJECT);

    return new Promise<boolean>((resolve) => {
      const approval: PendingApproval = {
        runId: preview.runId,
        messageId: msg.id,
        task: preview.task,
        repo: undefined,
        resolve,
      };
      this.pendingApprovals.set(msg.id, approval);
    });
  }

  private async handleReaction(reaction: MessageReaction, user: User): Promise<void> {
    if (user.bot) return;

    const emoji = reaction.emoji.name;

    // Handle plan approval reactions
    const approval = this.pendingApprovals.get(reaction.message.id);
    if (approval) {
      if (emoji === REACTION_CONTROLS.APPROVE || emoji === REACTION_CONTROLS.REJECT) {
        const approved = emoji === REACTION_CONTROLS.APPROVE;
        this.pendingApprovals.delete(reaction.message.id);
        approval.resolve(approved);

        const statusText = approved ? "approved" : "rejected";
        this.logger.info("discord", `Plan for run ${approval.runId} ${statusText} by ${user.tag}`);

        try {
          await reaction.message.reply(
            `Plan ${statusText} by <@${user.id}>.${approved ? " Dispatching task..." : " Task cancelled."}`,
          );
        } catch { /* ignore reply failure */ }
        return;
      }
    }

    // Handle thread lifecycle reaction controls
    if (!this.config.discord?.reaction_controls !== false) return;

    await this.handleLifecycleReaction(reaction, user, emoji);
  }

  /** Handle reaction-based controls on thread messages. */
  private async handleLifecycleReaction(reaction: MessageReaction, user: User, emoji: string | null): Promise<void> {
    if (!emoji) return;

    // Find the lifecycle for this thread
    const channel = reaction.message.channel;
    if (!channel.isThread()) return;

    const lifecycle = this.lifecycles.get(channel.id);
    if (!lifecycle) return;

    const runId = lifecycle.runId;
    if (!runId) return;

    try {
      switch (emoji) {
        case REACTION_CONTROLS.CANCEL: {
          const result = await cancelRun(runId, this.daemonPort, this.daemonToken);
          lifecycle.status = "cancelled";
          lifecycle.updatedAt = Date.now();
          await channel.send(`${REACTION_CONTROLS.CANCEL} ${result} (by <@${user.id}>)`);
          break;
        }
        case REACTION_CONTROLS.RETRY: {
          const result = await retryRun(runId, this.daemonPort, this.daemonToken);
          lifecycle.status = "dispatched";
          lifecycle.updatedAt = Date.now();
          await channel.send(`${REACTION_CONTROLS.RETRY} ${result} (by <@${user.id}>)`);
          break;
        }
        case REACTION_CONTROLS.LOGS: {
          const status = await fetchStatus(this.daemonPort, this.daemonToken);
          await channel.send(`${REACTION_CONTROLS.LOGS} **Run Status:**\n${status}`);
          break;
        }
        case REACTION_CONTROLS.PAUSE: {
          // Post pause request - the daemon handles actual pausing
          await channel.send(`${REACTION_CONTROLS.PAUSE} Pause requested for run \`${runId}\` by <@${user.id}>.`);
          lifecycle.status = "paused";
          lifecycle.updatedAt = Date.now();
          break;
        }
        case REACTION_CONTROLS.APPROVE: {
          await channel.send(`${REACTION_CONTROLS.APPROVE} Approved by <@${user.id}>.`);
          break;
        }
        case REACTION_CONTROLS.REJECT: {
          const result = await cancelRun(runId, this.daemonPort, this.daemonToken);
          lifecycle.status = "cancelled";
          lifecycle.updatedAt = Date.now();
          await channel.send(`${REACTION_CONTROLS.REJECT} Rejected by <@${user.id}>. ${result}`);
          break;
        }
      }
    } catch (err) {
      this.logger.error("discord", `Failed to handle reaction control: ${err}`);
      try {
        await channel.send(`Failed to process reaction: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore */ }
    }
  }

  /** Update lifecycle status from external events (e.g., daemon run events). */
  updateLifecycleStatus(threadId: string, status: ThreadLifecycle["status"]): void {
    const lifecycle = this.lifecycles.get(threadId);
    if (lifecycle) {
      lifecycle.status = status;
      lifecycle.updatedAt = Date.now();
    }
  }

  /** Find lifecycle by run ID. */
  findLifecycleByRunId(runId: string): ThreadLifecycle | undefined {
    for (const lifecycle of this.lifecycles.values()) {
      if (lifecycle.runId === runId) return lifecycle;
    }
    return undefined;
  }

  getPendingApprovals(): Map<string, PendingApproval> {
    return this.pendingApprovals;
  }

  getStatusChannelId(): string | null {
    return this.statusChannelId;
  }

  async ensureStatusChannel(): Promise<void> {
    const guildId = this.config.discord?.guild_id;
    if (!guildId) return;

    const channelName = this.config.discord?.status_channel_name ?? "forgectl-status";

    try {
      const guild: Guild = await this.client.guilds.fetch(guildId);
      const channels = await guild.channels.fetch();
      const existing = channels.find(
        (ch) => ch?.name === channelName && ch.type === ChannelType.GuildText,
      );

      if (existing) {
        this.statusChannelId = existing.id;
        this.logger.info("discord", `Using existing status channel #${channelName} (${existing.id})`);
      } else {
        const created = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: "forgectl status updates, alerts, and daily digests",
        });
        this.statusChannelId = created.id;
        this.logger.info("discord", `Created status channel #${channelName} (${created.id})`);
      }
    } catch (err) {
      this.logger.warn("discord", `Failed to ensure status channel: ${err}`);
    }
  }

  async postAlert(event: AlertEvent): Promise<void> {
    if (!this.statusChannelId) return;
    if (this.config.discord?.alerts_enabled === false) return;

    try {
      const channel = await this.client.channels.fetch(this.statusChannelId);
      if (!channel || !("send" in channel)) return;
      const embed = buildAlertEmbed(event);
      await (channel as TextChannel).send({ embeds: [embed] });

      // Also post to the relevant thread if there's a lifecycle for this run
      if (event.runId) {
        const lifecycle = this.findLifecycleByRunId(event.runId);
        if (lifecycle) {
          try {
            const thread = await this.client.channels.fetch(lifecycle.threadId) as ThreadChannel;
            if (thread) {
              await thread.send({ embeds: [embed] });
              // Update lifecycle status based on alert type
              if (event.type === "run_completed") {
                this.updateLifecycleStatus(lifecycle.threadId, "completed");
              } else if (event.type === "run_failed") {
                this.updateLifecycleStatus(lifecycle.threadId, "failed");
              }
            }
          } catch { /* thread may be archived */ }
        }
      }
    } catch (err) {
      this.logger.warn("discord", `Failed to post alert: ${err}`);
    }
  }

  async postDigest(): Promise<void> {
    if (!this.statusChannelId) return;

    try {
      const data = await fetchDigestData(this.daemonPort, this.daemonToken);
      const message = formatDigest(data);
      const channel = await this.client.channels.fetch(this.statusChannelId);
      if (!channel || !("send" in channel)) return;
      await (channel as TextChannel).send(message);
      this.logger.info("discord", "Daily digest posted");
    } catch (err) {
      this.logger.warn("discord", `Failed to post digest: ${err}`);
    }
  }

  startDigestSchedule(): void {
    const cronExpr = this.config.discord?.digest_cron ?? "0 9 * * *";
    const hourMatch = cronExpr.match(/^\d+\s+(\d+)/);
    const targetHour = hourMatch ? parseInt(hourMatch[1], 10) : 9;

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(targetHour, 0, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      const delayMs = next.getTime() - now.getTime();

      this.digestTimer = setTimeout(() => {
        void this.postDigest();
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();
    this.logger.info("discord", `Daily digest scheduled at hour ${targetHour}`);
  }

  private async registerSlashCommands(token: string): Promise<void> {
    const guildId = this.config.discord?.guild_id;
    if (!guildId) return;

    const commands = [
      new SlashCommandBuilder()
        .setName("forge")
        .setDescription("Interact with forgectl")
        .addSubcommand((sub) =>
          sub.setName("run").setDescription("Dispatch a task").addStringOption((opt) =>
            opt.setName("task").setDescription("Task description").setRequired(true),
          ),
        )
        .addSubcommand((sub) => sub.setName("status").setDescription("Show current runs"))
        .addSubcommand((sub) => sub.setName("stats").setDescription("Show analytics summary"))
        .addSubcommand((sub) =>
          sub.setName("cancel").setDescription("Cancel a running task").addStringOption((opt) =>
            opt.setName("run_id").setDescription("Run ID to cancel").setRequired(true),
          ),
        )
        .addSubcommand((sub) => sub.setName("budget").setDescription("Show budget status"))
        .addSubcommand((sub) => sub.setName("repos").setDescription("List tracked repositories and channel mappings"))
        .addSubcommand((sub) =>
          sub.setName("update-claude-md").setDescription("Update CLAUDE.md for a workspace").addStringOption((opt) =>
            opt.setName("workspace").setDescription("Workspace identifier").setRequired(true),
          ),
        )
        .addSubcommand((sub) =>
          sub.setName("map-channel").setDescription("Map a channel to a repository")
            .addStringOption((opt) => opt.setName("repo").setDescription("Repository (owner/repo)").setRequired(true))
            .addStringOption((opt) => opt.setName("channel_id").setDescription("Channel ID (defaults to current)"))
            .addStringOption((opt) => opt.setName("workflow").setDescription("Workflow override")),
        )
        .addSubcommand((sub) =>
          sub.setName("unmap-channel").setDescription("Remove channel-repo mapping")
            .addStringOption((opt) => opt.setName("channel_id").setDescription("Channel ID (defaults to current)")),
        )
        .addSubcommand((sub) => sub.setName("controls").setDescription("Show reaction controls help")),
    ];

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(this.client.application?.id ?? "", guildId), {
        body: commands.map((c) => c.toJSON()),
      });
    } catch (err) {
      this.logger.warn("discord", `Failed to register slash commands: ${err}`);
    }
  }
}

export async function startDiscordBot(deps: DiscordBotDeps): Promise<DiscordBot> {
  const bot = new DiscordBot(deps);
  await bot.start();
  return bot;
}
