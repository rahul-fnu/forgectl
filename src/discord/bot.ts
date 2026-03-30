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
} from "discord.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { PlanPreview } from "../analysis/cost-predictor.js";
import { buildPlanPreviewEmbed } from "./embeds.js";
import type { AlertEvent } from "../alerting/types.js";
import { buildAlertEmbed } from "./embeds.js";

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
  return text.slice(0, maxLen) + "…";
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
    .map((r) => `• \`${r.id}\` — ${r.status}`)
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
  const lines = [`**forgectl Daily Digest — ${now}**\n`];

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
      const task = r.task ? ` — ${r.task.slice(0, 60)}` : "";
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

  private resolveBotToken(): string {
    const cfgToken = this.config.discord?.bot_token;
    if (cfgToken) return cfgToken;
    return process.env.DISCORD_BOT_TOKEN ?? "";
  }

  private isListenChannel(channelId: string): boolean {
    const ids = this.config.discord?.channel_ids;
    if (!ids || ids.length === 0) return true;
    return ids.includes(channelId);
  }

  async handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;
    if (!this.isListenChannel(msg.channelId)) return;

    const task = msg.content.trim();
    if (!task) return;

    const repo = extractRepo(task);
    const threadName = `Working on: ${truncateTitle(task)}`;

    try {
      const thread = await msg.startThread({ name: threadName });

      const result = await dispatchTask(task, repo, this.daemonPort, this.daemonToken);

      if (result.status === "decomposed" && result.childIssues) {
        const issueList = result.childIssues.map((c) => `• ${c}`).join("\n");
        await thread.send(`Task decomposed into sub-issues:\n${issueList}`);
        if (result.parentIssueId) {
          this.threadMap.set(thread.id, result.parentIssueId);
        }
      } else {
        await thread.send(`Task dispatched! Run ID: \`${result.id}\``);
        if (result.id) {
          this.threadMap.set(thread.id, result.id);
        }
      }
    } catch (err) {
      this.logger.error("discord", `Failed to handle message: ${err}`);
      try {
        await msg.reply(`Failed to dispatch task: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore reply failure */ }
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
      await interaction.editReply(result);
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

    // Default: dispatch a task
    const task = interaction.options.getString("task");
    if (!task) {
      await interaction.reply("Please provide a task description.");
      return;
    }

    await interaction.deferReply();
    try {
      const repo = extractRepo(task);
      const result = await dispatchTask(task, repo, this.daemonPort, this.daemonToken);

      if (result.status === "decomposed" && result.childIssues) {
        const issueList = result.childIssues.map((c) => `• ${c}`).join("\n");
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

    await msg.react("\u2705");
    await msg.react("\u274c");

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

    const approval = this.pendingApprovals.get(reaction.message.id);
    if (!approval) return;

    const emoji = reaction.emoji.name;
    if (emoji !== "\u2705" && emoji !== "\u274c") return;

    const approved = emoji === "\u2705";
    this.pendingApprovals.delete(reaction.message.id);
    approval.resolve(approved);

    const statusText = approved ? "approved" : "rejected";
    this.logger.info("discord", `Plan for run ${approval.runId} ${statusText} by ${user.tag}`);

    try {
      await reaction.message.reply(
        `Plan ${statusText} by <@${user.id}>.${approved ? " Dispatching task..." : " Task cancelled."}`,
      );
    } catch { /* ignore reply failure */ }
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
    // Post digest daily — simple interval-based approach using digest_cron hour
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
        // Schedule the next one
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
        .addSubcommand((sub) => sub.setName("repos").setDescription("List tracked repositories"))
        .addSubcommand((sub) =>
          sub.setName("update-claude-md").setDescription("Update CLAUDE.md for a workspace").addStringOption((opt) =>
            opt.setName("workspace").setDescription("Workspace identifier").setRequired(true),
          ),
        ),
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
