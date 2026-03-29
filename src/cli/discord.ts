import { DiscordBot } from "../discord/bot.js";
import type { DiscordBotConfig } from "../discord/types.js";
import { loadConfig } from "../config/loader.js";
import { readDaemonToken } from "../daemon/lifecycle.js";

export async function discordCommand(opts: {
  config?: string;
  token?: string;
  daemonUrl?: string;
}): Promise<void> {
  const config = loadConfig(opts.config);

  const discordToken = opts.token
    ?? config.discord?.token
    ?? process.env.DISCORD_BOT_TOKEN;

  if (!discordToken) {
    console.error("Error: Discord bot token is required.");
    console.error("Provide via --token, config discord.token, or DISCORD_BOT_TOKEN env var.");
    process.exit(1);
  }

  const daemonUrl = opts.daemonUrl
    ?? config.discord?.daemon_url
    ?? "http://127.0.0.1:4856";

  const daemonToken = config.discord?.daemon_token ?? readDaemonToken() ?? undefined;

  const botConfig: DiscordBotConfig = {
    token: discordToken,
    daemon_url: daemonUrl,
    daemon_token: daemonToken,
    allowed_channel_ids: config.discord?.allowed_channel_ids,
    notification_channel_id: config.discord?.notification_channel_id,
  };

  const bot = new DiscordBot(botConfig);

  const shutdown = async () => {
    console.log("\nShutting down Discord bot...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await bot.start();
  console.log("Discord bot is running. Press Ctrl+C to stop.");
}
