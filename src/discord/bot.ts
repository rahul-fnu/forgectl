import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";

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

export async function fetchStats(daemonPort: number, daemonToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/analytics/summary`, {
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!res.ok) return "Failed to fetch stats.";
  const data = (await res.json()) as Record<string, unknown>;
  return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

export class DiscordBot {
  private client: Client;
  private threadMap = new Map<string, string>();
  private config: ForgectlConfig;
  private logger: Logger;
  private daemonPort: number;
  private daemonToken: string;

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
