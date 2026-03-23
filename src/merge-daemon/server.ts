/**
 * Merge daemon server — Fastify on a separate port.
 * Polls for open forge/* PRs and processes them sequentially.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { saveMergeDaemonPid, removeMergeDaemonPid } from "./lifecycle.js";
import { registerMergeDaemonRoutes, type MergeDaemonStatus } from "./routes.js";
import { PRProcessor, type PRProcessorConfig } from "./pr-processor.js";
import { loadConfig } from "../config/loader.js";
import { resolveToken } from "../tracker/token.js";
import { Logger } from "../logging/logger.js";

export async function startMergeDaemon(port = 4857, ciTimeoutMs?: number, configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const logger = new Logger(false);

  if (!config.tracker?.repo) {
    logger.error("merge-daemon", "Merge daemon requires tracker.repo configured (e.g. owner/repo)");
    process.exit(1);
  }

  const [owner, repo] = config.tracker.repo.split("/");
  // Use GitHub token if tracker is GitHub, otherwise resolve from merger app below
  let token = config.tracker.kind === "github" ? resolveToken(config.tracker.token) : "";
  const daemonConfig = config.merge_daemon;

  const processorConfig: PRProcessorConfig = {
    owner,
    repo,
    token,
    rawToken: config.tracker.token,
    branchPattern: daemonConfig?.branch_pattern ?? "forge/*",
    ciTimeoutMs: ciTimeoutMs ?? daemonConfig?.ci_timeout_ms ?? 2_700_000,
    enableReview: daemonConfig?.enable_review ?? true,
    enableBuildFix: daemonConfig?.enable_build_fix ?? true,
    validationCommands: daemonConfig?.validation_commands ?? [],
  };

  // Configure merger bot identity if merger_app is set
  if (config.merger_app) {
    processorConfig.mergerAuthorName = "forgectl-merger[bot]";
    processorConfig.mergerAuthorEmail = `${config.merger_app.app_id}+forgectl-merger[bot]@users.noreply.github.com`;

    // If installation ID is provided, get installation token
    if (config.merger_app.installation_id) {
      try {
        const { createGitHubAppService } = await import("../github/app.js");
        const resolvedKeyPath = config.merger_app.private_key_path.replace(/^~/, process.env.HOME || "/tmp");
        const ghAppService = createGitHubAppService({
          appId: config.merger_app.app_id,
          privateKeyPath: resolvedKeyPath,
          webhookSecret: config.merger_app.webhook_secret,
          installationId: config.merger_app.installation_id,
        });
        const octokit = await ghAppService.getInstallationOctokit(config.merger_app.installation_id);
        // Extract token from authenticated octokit
        const auth = await (octokit as any).auth({ type: "installation" }) as { token: string };
        if (auth?.token) {
          processorConfig.token = auth.token;
          logger.info("merge-daemon", "Using merger app installation token");
        }
      } catch (err) {
        logger.warn("merge-daemon", `Failed to get merger app token, falling back to PAT: ${err}`);
      }
    }
  }

  const processor = new PRProcessor(processorConfig, logger);
  const pollIntervalMs = daemonConfig?.poll_interval_ms ?? 60_000;
  const startTime = Date.now();

  // Server
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  let currentPR: number | null = null;
  let queueLength = 0;

  const getStatus = (): MergeDaemonStatus => ({
    status: currentPR !== null ? "running" : "idle",
    currentPR,
    queueLength,
    pollIntervalMs,
    uptimeMs: Date.now() - startTime,
  });

  registerMergeDaemonRoutes(app, getStatus, processor);

  // Poll loop
  let running = true;
  const pollLoop = async (): Promise<void> => {
    while (running) {
      try {
        const prs = await processor.fetchOpenForgePRs();
        queueLength = prs.length;

        if (prs.length > 0) {
          logger.info("merge-daemon", `Found ${prs.length} open forge PR(s) to process`);
        }

        for (const pr of prs) {
          if (!running) break;
          currentPR = pr.number;
          const result = await processor.processPR(pr);
          if (result.status === "merged") {
            logger.info("merge-daemon", `PR #${pr.number} merged`);
          } else if (result.status === "failed") {
            logger.warn("merge-daemon", `PR #${pr.number} failed: ${result.error}`);
          }
          currentPR = null;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("merge-daemon", `Poll error: ${msg}`);
      }

      // Wait before next poll
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  };

  void pollLoop();

  await app.listen({ port, host: "127.0.0.1" });
  saveMergeDaemonPid(process.pid);

  logger.info("merge-daemon", `Merge daemon running on http://127.0.0.1:${port}`);
  console.log(`forgectl merge-daemon running on http://127.0.0.1:${port}`);

  const shutdown = async (): Promise<void> => {
    running = false;
    removeMergeDaemonPid();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
