import { DiscordBot } from "../discord/bot.js";
import { loadConfig } from "../config/loader.js";
import { readDaemonToken } from "../daemon/lifecycle.js";
import { Logger } from "../logging/logger.js";

export async function discordCommand(opts: {
  config?: string;
  token?: string;
  daemonUrl?: string;
}): Promise<void> {
  const config = loadConfig(opts.config);

  const discordToken = opts.token
    ?? config.discord?.token
    ?? config.discord?.bot_token
    ?? process.env.DISCORD_BOT_TOKEN;

  if (!discordToken) {
    console.error("Error: Discord bot token is required.");
    console.error("Provide via --token, config discord.token, or DISCORD_BOT_TOKEN env var.");
    process.exit(1);
  }

  const daemonUrl = opts.daemonUrl
    ?? config.discord?.daemon_url
    ?? "http://127.0.0.1:4856";

  const daemonToken = config.discord?.daemon_token ?? readDaemonToken() ?? "";

  // Extract port from daemon URL
  let daemonPort = 4856;
  try {
    daemonPort = parseInt(new URL(daemonUrl).port, 10) || 4856;
  } catch { /* use default */ }

  // Override bot_token in config so DiscordBot can use it
  const configWithToken = {
    ...config,
    discord: { ...config.discord, bot_token: discordToken },
  };

  const bot = new DiscordBot({
    config: configWithToken,
    logger: new Logger(false),
    daemonPort,
    daemonToken,
  });

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
