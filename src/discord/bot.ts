import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { ThreadManager } from "./thread-manager.js";
import {
  buildProgressEmbed,
  buildResultEmbed,
  buildStatusEmbed,
  buildStatsEmbed,
  buildSubIssueProgressEmbed,
} from "./embeds.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";
import type { Logger } from "../logging/logger.js";
import type { RunResult } from "../github/comments.js";
import type { ChildStatus } from "../github/sub-issue-rollup.js";

export interface DiscordBotConfig {
  botToken: string;
  channelId: string;
  applicationId?: string;
}

export interface DiscordBotDeps {
  logger: Logger;
  getActiveRuns: () => Array<{ id: string; status: string; task?: string; startedAt?: string }>;
  getStats: () => { totalRuns: number; succeeded: number; failed: number; avgDurationMs?: number; totalCostUsd?: number };
  dispatchTask: (task: string) => Promise<string>;
  resumeRun?: (runId: string, input: string) => { resumed: boolean; error?: string };
}

export class DiscordBot {
  private client: Client;
  private threadManager: ThreadManager | null = null;
  private config: DiscordBotConfig;
  private deps: DiscordBotDeps;
  private started = false;
  private eventCleanup: (() => void) | null = null;

  constructor(config: DiscordBotConfig, deps: DiscordBotDeps) {
    this.config = config;
    this.deps = deps;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.client.on(Events.ClientReady, () => {
      this.deps.logger.info("discord", `Bot logged in as ${this.client.user?.tag}`);
      this.threadManager = new ThreadManager(this.client, this.config.channelId);
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });

    await this.client.login(this.config.botToken);
    this.subscribeToRunEvents();

    if (this.config.applicationId) {
      await this.registerSlashCommands();
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.eventCleanup) {
      this.eventCleanup();
      this.eventCleanup = null;
    }
    this.client.destroy();
    this.started = false;
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.config.applicationId) return;

    const commands = [
      new SlashCommandBuilder()
        .setName("forge")
        .setDescription("forgectl commands")
        .addSubcommand((sub) =>
          sub.setName("status").setDescription("Show current runs"),
        )
        .addSubcommand((sub) =>
          sub.setName("stats").setDescription("Show analytics"),
        ),
    ];

    const rest = new REST().setToken(this.config.botToken);
    try {
      await rest.put(Routes.applicationCommands(this.config.applicationId), {
        body: commands.map((c) => c.toJSON()),
      });
      this.deps.logger.info("discord", "Slash commands registered");
    } catch (err) {
      this.deps.logger.warn("discord", `Failed to register slash commands: ${err}`);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.channel.id !== this.config.channelId && !message.channel.isThread()) return;

    // Handle replies in threads — forward as clarification input
    if (message.channel.isThread()) {
      const thread = message.channel as ThreadChannel;
      const runId = this.findRunIdByThreadId(thread.id);
      if (runId && this.deps.resumeRun) {
        const result = this.deps.resumeRun(runId, message.content);
        if (result.resumed) {
          await message.reply("Reply forwarded to agent.");
        } else if (result.error) {
          await message.reply(`Could not forward reply: ${result.error}`);
        }
      }
      return;
    }

    // Handle new task messages in the main channel
    const content = message.content.trim();
    if (!content) return;

    try {
      const runId = await this.deps.dispatchTask(content);
      if (!this.threadManager) return;

      const thread = await this.threadManager.getOrCreateThread(
        runId,
        `forge: ${content.slice(0, 80)}`,
      );
      await thread.send(`Task dispatched — run \`${runId}\``);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error("discord", `Failed to dispatch task: ${errMsg}`);
      try {
        await message.reply(`Failed to dispatch task: ${errMsg}`);
      } catch {
        // rate limit or permissions
      }
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "forge") return;

    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "status") {
        const runs = this.deps.getActiveRuns();
        const embed = buildStatusEmbed(runs);
        await interaction.reply({ embeds: [embed] });
      } else if (sub === "stats") {
        const stats = this.deps.getStats();
        const embed = buildStatsEmbed(stats);
        await interaction.reply({ embeds: [embed] });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error("discord", `Slash command error: ${errMsg}`);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `Error: ${errMsg}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `Error: ${errMsg}`, ephemeral: true });
        }
      } catch {
        // Swallow interaction error
      }
    }
  }

  private subscribeToRunEvents(): void {
    const handler = (event: RunEvent) => {
      void this.handleRunEvent(event);
    };
    runEvents.on("run", handler);
    this.eventCleanup = () => {
      runEvents.off("run", handler);
    };
  }

  private async handleRunEvent(event: RunEvent): Promise<void> {
    if (!this.threadManager) return;

    try {
      switch (event.type) {
        case "started":
        case "dispatch": {
          const title = (event.data.task as string) ?? (event.data.identifier as string) ?? event.runId;
          await this.threadManager.getOrCreateThread(event.runId, `forge: ${title.slice(0, 80)}`);
          const embed = buildProgressEmbed(event.runId, [], "started");
          await this.threadManager.sendEmbed(event.runId, embed);
          break;
        }

        case "phase": {
          const stage = event.data.phase as string;
          const completed = (event.data.completedStages as string[]) ?? [stage];
          const attempt = event.data.validationAttempt as number | undefined;
          const embed = buildProgressEmbed(event.runId, completed, "running", attempt);
          await this.threadManager.sendEmbed(event.runId, embed);
          break;
        }

        case "agent_output": {
          const output = event.data.output as string;
          if (output) {
            const truncated = output.length > 1900 ? output.slice(0, 1900) + "..." : output;
            await this.threadManager.sendMessage(event.runId, `\`\`\`\n${truncated}\n\`\`\``);
          }
          break;
        }

        case "prompt": {
          const question = event.data.question as string;
          if (question) {
            await this.threadManager.sendMessage(
              event.runId,
              `**Clarification needed:**\n> ${question}\n\nReply in this thread to respond.`,
            );
          }
          break;
        }

        case "completed": {
          const result: RunResult = {
            runId: event.runId,
            status: "success",
            duration: (event.data.duration as string) ?? "unknown",
            cost: event.data.cost as RunResult["cost"],
            workflow: event.data.workflow as string | undefined,
            agent: event.data.agent as string | undefined,
            validationResults: event.data.validationResults as RunResult["validationResults"],
          };
          const prUrl = event.data.prUrl as string | undefined;
          const embed = buildResultEmbed(result, prUrl);
          await this.threadManager.sendEmbed(event.runId, embed);
          break;
        }

        case "failed": {
          const result: RunResult = {
            runId: event.runId,
            status: "failure",
            duration: (event.data.duration as string) ?? "unknown",
            cost: event.data.cost as RunResult["cost"],
          };
          const embed = buildResultEmbed(result);
          await this.threadManager.sendEmbed(event.runId, embed);
          break;
        }

        case "validation_step_completed": {
          const step = event.data.step as string;
          const passed = event.data.passed as boolean;
          const icon = passed ? "✅" : "❌";
          await this.threadManager.sendMessage(
            event.runId,
            `${icon} Validation: **${step}** ${passed ? "passed" : "failed"}`,
          );
          break;
        }
      }
    } catch (err) {
      this.deps.logger.warn("discord", `Failed to handle run event ${event.type}: ${err}`);
    }
  }

  async postSubIssueProgress(
    parentRunId: string,
    parentTitle: string,
    children: ChildStatus[],
  ): Promise<void> {
    if (!this.threadManager) return;
    const embed = buildSubIssueProgressEmbed(parentTitle, children);
    await this.threadManager.sendEmbed(parentRunId, embed);
  }

  private findRunIdByThreadId(threadId: string): string | undefined {
    if (!this.threadManager) return undefined;
    // Reverse lookup from thread manager
    // ThreadManager stores runId -> threadId, we need threadId -> runId
    // Access the internal map via the public getter
    return this.threadManager.findRunByThread(threadId);
  }

  getThreadManager(): ThreadManager | null {
    return this.threadManager;
  }
}
