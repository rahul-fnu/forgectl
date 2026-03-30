import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  type Message,
  type MessageReaction,
  type ChatInputCommandInteraction,
  type User,
  type Guild,
  type CategoryChannel,
} from "discord.js";
import { eq } from "drizzle-orm";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { PlanPreview } from "../analysis/cost-predictor.js";
import type { AppDatabase } from "../storage/database.js";
import { channelRepos } from "../storage/schema.js";
import { buildPlanPreviewEmbed } from "./embeds.js";

export interface DiscordBotDeps {
  config: ForgectlConfig;
  logger: Logger;
  daemonPort: number;
  daemonToken: string;
  db?: AppDatabase;
}

export interface DispatchResult {
  status: string;
  id?: string;
  parentIssueId?: string;
  childIssues?: string[];
}

const REPO_URL_REGEX = /https?:\/\/github\.com\/[\w.\-]+\/[\w.\-]+/;
const REPO_NAME_REGEX = /repo:\s*([\w.\-]+\/[\w.\-]+)/i;

const STACK_KEYWORDS: Record<string, string> = {
  python: "python",
  django: "python",
  flask: "python",
  fastapi: "python",
  node: "node",
  express: "node",
  typescript: "typescript",
  react: "typescript",
  nextjs: "typescript",
  go: "go",
  golang: "go",
  rust: "rust",
};

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

export function extractStack(text: string): string | null {
  const stackMatch = text.match(/\*\*Stack\*\*[:\s]*(.+)/i);
  if (stackMatch) {
    const stackLine = stackMatch[1].toLowerCase();
    for (const [keyword, s] of Object.entries(STACK_KEYWORDS)) {
      if (stackLine.includes(keyword)) return s;
    }
  }
  const lower = text.toLowerCase();
  for (const [keyword, s] of Object.entries(STACK_KEYWORDS)) {
    if (lower.includes(keyword)) return s;
  }
  return null;
}

export function extractProjectName(text: string): string | null {
  const repoUrlMatch = text.match(
    /\*\*Repo:?\*\*[:\s]*https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)/i,
  );
  if (repoUrlMatch) return repoUrlMatch[1].replace(/\.git$/, "");

  const projMatch = text.match(/\*\*Project(?:\s+Name)?\*\*[:\s]*(\S+)/i);
  if (projMatch) return projMatch[1].replace(/[`"']/g, "");

  const createRepoMatch = text.match(/create\s+(?:a\s+)?(?:new\s+)?(?:repo|project|channel)\s+([\w.-]+)/i);
  if (createRepoMatch) return createRepoMatch[1];

  return null;
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

const PROJECTS_CATEGORY_NAME = "Projects";

export class DiscordBot {
  private client: Client;
  private threadMap = new Map<string, string>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private config: ForgectlConfig;
  private logger: Logger;
  private daemonPort: number;
  private daemonToken: string;
  private db: AppDatabase | undefined;

  constructor(deps: DiscordBotDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.daemonPort = deps.daemonPort;
    this.daemonToken = deps.daemonToken;
    this.db = deps.db;

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

    this.ensureChannelReposTable();
    await this.registerSlashCommands(token);
    await this.client.login(token);
    this.logger.info("discord", `Discord bot logged in as ${this.client.user?.tag ?? "unknown"}`);
  }

  async stop(): Promise<void> {
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

  private isGeneralChannel(channelId: string): boolean {
    const ids = this.config.discord?.channel_ids;
    if (!ids || ids.length === 0) return true;
    return ids.includes(channelId);
  }

  private isRepoChannel(channelId: string): { repoSlug: string; repoUrl: string } | null {
    if (!this.db) return null;
    const rows = this.db.select().from(channelRepos).where(eq(channelRepos.channelId, channelId)).all();
    if (rows.length === 0) return null;
    return { repoSlug: rows[0].repoSlug, repoUrl: rows[0].repoUrl };
  }

  private ensureChannelReposTable(): void {
    if (!this.db) return;
    this.db.$client.exec(`
      CREATE TABLE IF NOT EXISTS channel_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL UNIQUE,
        channel_name TEXT NOT NULL,
        repo_slug TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        stack TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  async handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;

    const repoMapping = this.isRepoChannel(msg.channelId);
    if (repoMapping) {
      await this.handleRepoChannelMessage(msg, repoMapping);
      return;
    }

    if (!this.isGeneralChannel(msg.channelId)) return;

    const text = msg.content.trim();
    if (!text) return;

    const projectName = extractProjectName(text);
    if (projectName && this.db) {
      await this.handleProjectCreation(msg, projectName, text);
      return;
    }

    const repo = extractRepo(text);
    const threadName = `Working on: ${truncateTitle(text)}`;

    try {
      const thread = await msg.startThread({ name: threadName });
      const result = await dispatchTask(text, repo, this.daemonPort, this.daemonToken);

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

  private async handleProjectCreation(msg: Message, projectName: string, text: string): Promise<void> {
    const guild = msg.guild;
    if (!guild) {
      await msg.reply("Project creation is only available in servers.");
      return;
    }

    const stack = extractStack(text) ?? "typescript";
    const org = this.resolveOrg();

    if (!org) {
      await msg.reply("No GitHub org configured. Set `project.github_org` in config.");
      return;
    }

    const githubToken = process.env.GITHUB_TOKEN ?? this.config.tracker?.token;
    if (!githubToken) {
      await msg.reply("No GitHub token available. Set GITHUB_TOKEN env var.");
      return;
    }

    try {
      await msg.reply(`Creating project **${projectName}** (${stack})...`);

      const { createProject } = await import("../project/create.js");
      const { Octokit } = await import("@octokit/core");
      const octokit = new Octokit({ auth: githubToken });

      const result = await createProject(octokit, {
        name: projectName,
        stack: stack as any,
        org,
        description: `Created via Discord by ${msg.author.tag}`,
        private: true,
      });

      const category = await this.getOrCreateProjectsCategory(guild);
      const channelName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);
      const topic = `Repo: ${result.htmlUrl} | Stack: ${stack}`;

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic,
      });

      this.db!.insert(channelRepos).values({
        channelId: channel.id,
        channelName,
        repoSlug: result.repoSlug,
        repoUrl: result.htmlUrl,
        stack,
        createdAt: new Date().toISOString(),
      }).run();

      await msg.reply(
        `Project created!\n` +
        `**Repo:** ${result.htmlUrl}\n` +
        `**Channel:** <#${channel.id}>\n` +
        `**Stack:** ${stack}`,
      );

      this.logger.info("discord", `Created project ${result.repoSlug} with channel #${channelName}`);
    } catch (err) {
      this.logger.error("discord", `Failed to create project: ${err}`);
      try {
        await msg.reply(`Failed to create project: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore reply failure */ }
    }
  }

  private async handleRepoChannelMessage(
    msg: Message,
    mapping: { repoSlug: string; repoUrl: string },
  ): Promise<void> {
    const task = msg.content.trim();
    if (!task) return;

    const threadName = `Working on: ${truncateTitle(task)}`;

    try {
      const thread = await msg.startThread({ name: threadName });
      const result = await dispatchTask(task, mapping.repoSlug, this.daemonPort, this.daemonToken);

      if (result.status === "decomposed" && result.childIssues) {
        const issueList = result.childIssues.map((c) => `• ${c}`).join("\n");
        await thread.send(`Task decomposed into sub-issues:\n${issueList}`);
        if (result.parentIssueId) {
          this.threadMap.set(thread.id, result.parentIssueId);
        }
      } else {
        await thread.send(`Task dispatched to **${mapping.repoSlug}**! Run ID: \`${result.id}\``);
        if (result.id) {
          this.threadMap.set(thread.id, result.id);
        }
      }
    } catch (err) {
      this.logger.error("discord", `Failed to handle repo channel message: ${err}`);
      try {
        await msg.reply(`Failed to dispatch task: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore reply failure */ }
    }
  }

  private async getOrCreateProjectsCategory(guild: Guild): Promise<CategoryChannel> {
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name === PROJECTS_CATEGORY_NAME,
    );
    if (existing) return existing as CategoryChannel;

    const category = await guild.channels.create({
      name: PROJECTS_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
    return category as CategoryChannel;
  }

  private resolveOrg(): string | null {
    const project = (this.config as any).project;
    if (project?.github_org) return project.github_org;
    if (this.config.tracker?.repo) {
      const parts = this.config.tracker.repo.split("/");
      if (parts.length >= 2) return parts[0];
    }
    return null;
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
