import Fastify from "fastify";
import cors from "@fastify/cors";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";
import { savePid, removePid, generateAndSaveToken, removeToken } from "./lifecycle.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import type { QueuedRun } from "./queue.js";
import type { ForgectlConfig } from "../config/schema.js";

export async function startDaemon(port = 4856, _enableOrchestrator = false, configPath?: string): Promise<void> {
  const app = Fastify({ logger: false });
  const corsOrigins: string[] = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  await app.register(cors, { origin: (origin, cb) => {
    if (!origin || corsOrigins.some(o => origin === o)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  } });

  const daemonToken = generateAndSaveToken();

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url.startsWith("/api/v1/") || url.startsWith("/runs") || url.startsWith("/auth")) {
      const authHeader = request.headers.authorization;
      const queryToken = (request.query as Record<string, string>)?.token;
      if (authHeader === `Bearer ${daemonToken}` || queryToken === daemonToken) {
        return;
      }
      reply.code(401);
      reply.send({ error: "Unauthorized" });
    }
  });

  const config = loadConfig(configPath);

  const queue = new RunQueue(async (run: QueuedRun) => {
    const runConfig = loadConfig(configPath);
    const plan = resolveRunPlan(runConfig, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger, false);
  });

  registerRoutes(app, queue);

  // Discord bot initialization (optional, only when config.discord is present)
  const daemonLogger = new Logger(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let discordBot: any = null;
  if (config.discord) {
    try {
      const { DiscordBot } = await import("../discord/bot.js");
      discordBot = new DiscordBot({
        config,
        logger: daemonLogger,
        daemonPort: port,
        daemonToken: daemonToken ?? "",
      });
      await discordBot.start();
      daemonLogger.info("daemon", "Discord bot initialized");
    } catch (err) {
      daemonLogger.error("daemon", `Failed to start Discord bot: ${err}`);
      discordBot = null;
    }
  }

  // GitHub App initialization (optional)
  if (config.github_app) {
    try {
      const { createGitHubAppService } = await import("../github/app.js");
      const { registerGitHubRoutes } = await import("../github/routes.js");

      const ghAppService = createGitHubAppService({
        appId: config.github_app.app_id,
        privateKeyPath: config.github_app.private_key_path,
        webhookSecret: config.github_app.webhook_secret,
        installationId: config.github_app.installation_id,
      });

      registerGitHubRoutes(app, ghAppService);
      daemonLogger.info("daemon", "GitHub App initialized, webhook route registered");
    } catch (err) {
      daemonLogger.error("daemon", `Failed to initialize GitHub App: ${err}`);
    }
  }

  // Merge daemon (optional)
  if (config.tracker?.repo && (config.merge_daemon || config.merger_app)) {
    try {
      const { startMergeDaemon: startMerge } = await import("../merge-daemon/server.js");
      const mdPort = 4857;
      void startMerge(mdPort, config.merge_daemon?.ci_timeout_ms ?? 2_700_000, configPath);
      daemonLogger.info("daemon", "Merge daemon started as sub-service");
    } catch (err) {
      daemonLogger.warn("daemon", `Failed to start merge daemon: ${err}`);
    }
  }

  await app.listen({ port, host: "127.0.0.1" });
  savePid(process.pid);

  console.log(`forgectl daemon running on http://127.0.0.1:${port}`);

  const shutdown = async () => {
    if (discordBot) {
      await discordBot.stop();
    }
    removePid();
    removeToken();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Auto-derive workspace after_create hook from tracker.repo when not explicitly configured.
 */
export function deriveWorkspaceHooks(config: ForgectlConfig): ForgectlConfig {
  if (
    config.tracker?.kind === "github" &&
    config.tracker.repo &&
    !config.workspace?.hooks?.after_create
  ) {
    const repoUrl = `https://github.com/${config.tracker.repo}.git`;
    return {
      ...config,
      workspace: {
        ...(config.workspace ?? { root: "~/.forgectl/workspaces", hooks: {}, hook_timeout: "60s" }),
        hooks: {
          ...(config.workspace?.hooks ?? {}),
          after_create: `git clone ${repoUrl} . && git config user.name forgectl && git config user.email forge@localhost`,
        },
      },
    };
  }
  return config;
}
