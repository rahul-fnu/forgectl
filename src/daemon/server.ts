import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import yaml from "js-yaml";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";
import { savePid, removePid, generateAndSaveToken, removeToken } from "./lifecycle.js";
import { loadConfig } from "../config/loader.js";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createRunRepository } from "../storage/repositories/runs.js";
import { createPipelineRepository } from "../storage/repositories/pipelines.js";
import { createSnapshotRepository } from "../storage/repositories/snapshots.js";
import { createLockRepository } from "../storage/repositories/locks.js";
import { createCostRepository } from "../storage/repositories/costs.js";
import { createRetryRepository } from "../storage/repositories/retries.js";
import { createEventRepository } from "../storage/repositories/events.js";
import { createOutcomeRepository } from "../storage/repositories/outcomes.js";
import { EventRecorder } from "../logging/recorder.js";
import { resolveRunPlan } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { recoverInterruptedRuns } from "../durability/recovery.js";
import { releaseAllStaleLocks } from "../durability/locks.js";
import { Logger } from "../logging/logger.js";
import type { QueuedRun } from "./queue.js";
import { PipelineRunService } from "./pipeline-service.js";
import { Orchestrator } from "../orchestrator/index.js";
import { SubIssueCache } from "../tracker/sub-issue-cache.js";
import { createTrackerAdapter } from "../tracker/registry.js";
import { resolveToken } from "../tracker/token.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadWorkflowFile } from "../workflow/workflow-file.js";
import { WorkflowFileWatcher } from "../workflow/watcher.js";
import { mergeWorkflowConfig } from "../workflow/merge.js";
import { ConfigSchema } from "../config/schema.js";
import type { ValidatedWorkflowFile } from "../workflow/types.js";
import type { ForgectlConfig } from "../config/schema.js";
export async function startDaemon(port = 4856, enableOrchestrator = false, configPath?: string): Promise<void> {
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
    if (url.startsWith("/api/v1/") || url.startsWith("/runs") || url.startsWith("/pipelines") || url.startsWith("/outcomes") || url.startsWith("/auth")) {
      const authHeader = request.headers.authorization;
      const queryToken = (request.query as Record<string, string>)?.token;
      if (authHeader === `Bearer ${daemonToken}` || queryToken === daemonToken) {
        return;
      }
      reply.code(401);
      reply.send({ error: "Unauthorized" });
    }
  });

  let config = loadConfig(configPath);

  // Auto-derive workspace clone hook from tracker.repo when not explicitly configured
  config = deriveWorkspaceHooks(config);

  // Initialize persistent storage
  const dbPath = config.storage?.db_path?.replace(/^~/, process.env.HOME || "/tmp");
  const db = createDatabase(dbPath);
  runMigrations(db);
  const runRepo = createRunRepository(db);
  const pipelineRepo = createPipelineRepository(db);
  const snapshotRepo = createSnapshotRepository(db);
  const lockRepo = createLockRepository(db);
  const costRepo = createCostRepository(db);
  const retryRepo = createRetryRepository(db);
  const eventRepo = createEventRepository(db);
  const outcomeRepo = createOutcomeRepository(db);
  const recorder = new EventRecorder(eventRepo, snapshotRepo);

  // --- Startup recovery (before accepting requests) ---
  const daemonLogger = new Logger(false);
  const currentPid = process.pid;

  // Clean up stale locks from previous daemon instance
  const staleLockCount = releaseAllStaleLocks(lockRepo, currentPid);
  if (staleLockCount > 0) {
    daemonLogger.info("recovery", `Released ${staleLockCount} stale execution lock(s) from previous daemon`);
  }

  // Recover interrupted runs (re-queue resumable, mark rest as interrupted)
  const recoveryResults = recoverInterruptedRuns(runRepo, snapshotRepo);
  for (const r of recoveryResults) {
    daemonLogger.info("recovery", `Run ${r.runId}: ${r.action} -- ${r.reason}`);
  }
  const requeuedCount = recoveryResults.filter(r => r.action.startsWith("resumed")).length;

  const queue = new RunQueue(runRepo, async (run: QueuedRun) => {
    const runConfig = loadConfig(configPath);
    const plan = resolveRunPlan(runConfig, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid, runRepo }, { outcomeRepo });
  });

  // Kick off processing for any runs re-queued during recovery
  if (requeuedCount > 0) {
    daemonLogger.info("recovery", `Re-queued ${requeuedCount} run(s) for execution`);
    queue.drain();
  }

  const pipelineService = new PipelineRunService(pipelineRepo);

  // Orchestrator initialization (when enabled or forced via CLI)
  let orchestrator: Orchestrator | null = null;
  let subIssueCache: SubIssueCache | undefined;
  let watcher: WorkflowFileWatcher | null = null;
  const orchestratorEnabled = enableOrchestrator || config.orchestrator?.enabled;
  if (orchestratorEnabled && config.tracker) {
    try {
      subIssueCache = new SubIssueCache();
      let tracker;
      if (config.tracker.kind === "github") {
        const { createGitHubAdapter } = await import("../tracker/github.js");
        tracker = createGitHubAdapter(config.tracker, subIssueCache);
      } else if (config.tracker.kind === "linear") {
        const { createLinearAdapter } = await import("../tracker/linear.js");
        tracker = createLinearAdapter(config.tracker, subIssueCache);
      } else {
        tracker = createTrackerAdapter(config.tracker);
      }
      const wsConfig = config.workspace ?? { root: "~/.forgectl/workspaces", hooks: {}, hook_timeout: "60s" };
      const workspaceManager = new WorkspaceManager(wsConfig, daemonLogger);

      // Load WORKFLOW.md from cwd if it exists
      const workflowPath = join(process.cwd(), "WORKFLOW.md");
      let wf: ValidatedWorkflowFile | null = null;
      try {
        wf = await loadWorkflowFile(workflowPath);
      } catch {
        /* no WORKFLOW.md, use defaults */
      }

      // Two-layer config merge: defaults < yaml
      const defaults = ConfigSchema.parse({});
      const mergedConfig = mergeWorkflowConfig(defaults, config as Partial<ForgectlConfig>);

      const { DEFAULT_PROMPT_TEMPLATE } = await import("../workflow/workflow-file.js");
      const promptTemplate = wf?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;

      // Load promoted review conventions for injection into agent prompts
      const { createReviewFindingsRepository: createFindingsRepoForConventions } = await import("../storage/repositories/review-findings.js");
      const conventionsRepo = createFindingsRepoForConventions(db);
      const promotedFindings = conventionsRepo.getPromotedFindings();
      if (promotedFindings.length > 0) {
        daemonLogger.info("daemon", `Loaded ${promotedFindings.length} promoted review convention(s) for agent context`);
      }

      orchestrator = new Orchestrator({
        tracker, workspaceManager, config: mergedConfig, promptTemplate, logger: daemonLogger,
        runRepo, costRepo, retryRepo,
        autonomy: wf?.config?.autonomy,
        autoApprove: wf?.config?.auto_approve,
        subIssueCache,
        skills: wf?.config?.skills,
        validationConfig: wf?.config?.validation,
        promotedFindings,
      });
      await orchestrator.start();

      // Start file watcher for hot-reload (only if WORKFLOW.md exists)
      if (wf) {
        watcher = new WorkflowFileWatcher();
        void watcher.start(workflowPath, {
          onReload: (newWf: ValidatedWorkflowFile) => {
            const newMerged = mergeWorkflowConfig(defaults, config as Partial<ForgectlConfig>);
            orchestrator!.applyConfig(newMerged, newWf.promptTemplate);
            daemonLogger.info("daemon", "WORKFLOW.md reloaded, config updated");
          },
          onWarning: (msg: string) => {
            daemonLogger.warn("daemon", msg);
          },
        });
      }
    } catch (err) {
      daemonLogger.error("daemon", `Failed to start orchestrator: ${err}`);
    }
  }

  registerRoutes(app, queue, {
    pipelineService,
    orchestrator: orchestrator ?? undefined,
    runRepo,
    costRepo,
    outcomeRepo,
    eventRepo,
  });

  // Import resumeRun for Discord and GitHub integrations
  const { resumeRun: resumeRunFn } = await import("../durability/pause.js");

  // Discord bot initialization (optional, only when config.discord is present)
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
          db,
        });
      await discordBot.start();
      daemonLogger.info("daemon", "Discord bot initialized");
    } catch (err) {
      daemonLogger.error("daemon", `Failed to start Discord bot: ${err}`);
      discordBot = null;
    }
  }

  // GitHub App initialization (optional, only when config.github_app is present)
  let ghAppService: Awaited<ReturnType<typeof import("../github/app.js").createGitHubAppService>> | null = null;
  if (config.github_app) {
    try {
      const { createGitHubAppService } = await import("../github/app.js");
      const { registerGitHubRoutes } = await import("../github/routes.js");
      const { registerWebhookHandlers } = await import("../github/webhooks.js");

      ghAppService = createGitHubAppService({
        appId: config.github_app.app_id,
        privateKeyPath: config.github_app.private_key_path,
        webhookSecret: config.github_app.webhook_secret,
        installationId: config.github_app.installation_id,
      });

      const { handleSlashCommand } = await import("../github/command-handler.js");
      const { emitRunEvent } = await import("../logging/events.js");
      const pendingStatuses = new Set(["pending_approval", "pending_output_approval"]);
      const approveRun = (repo: typeof runRepo, id: string) => {
        const run = repo.findById(id);
        if (!run) throw new Error(`Run ${id} not found`);
        if (!pendingStatuses.has(run.status)) throw new Error(`Cannot act on run ${id}: status is ${run.status}`);
        const prev = run.status;
        if (run.status === "pending_approval") {
          repo.updateStatus(id, { status: "running", approvalAction: "approve" });
        } else {
          repo.updateStatus(id, { status: "completed", completedAt: new Date().toISOString(), approvalAction: "approve" });
        }
        emitRunEvent({ runId: id, type: "approved", timestamp: new Date().toISOString(), data: { previousStatus: prev } });
        return { previousStatus: prev };
      };
      const rejectRun = (repo: typeof runRepo, id: string, reason?: string) => {
        const run = repo.findById(id);
        if (!run) throw new Error(`Run ${id} not found`);
        if (!pendingStatuses.has(run.status)) throw new Error(`Cannot act on run ${id}: status is ${run.status}`);
        repo.updateStatus(id, { status: "rejected", error: reason, approvalAction: "reject" });
        emitRunEvent({ runId: id, type: "rejected", timestamp: new Date().toISOString(), data: { reason } });
      };

      registerWebhookHandlers(ghAppService.app, {
        triggerLabel: "forgectl",
        onDispatch: (issue, octokit, repo) => {
          if (orchestrator) {
            daemonLogger.info("github", `Dispatching issue ${issue.identifier} via webhook`);
            void orchestrator.dispatchIssue(issue, { octokit: octokit as any, repo });
          } else {
            daemonLogger.warn("github", `Webhook trigger for ${issue.identifier} but orchestrator not running`);
          }
        },
        onCommand: async (cmd, octokit, context, sender, commentId) => {
          daemonLogger.info("github", `Command /${cmd.command} from @${sender} on ${context.owner}/${context.repo}#${context.issueNumber}`);
          await handleSlashCommand(cmd, octokit as any, context, sender, commentId, {
            orchestrator,
            runRepo,
            approveRun,
            rejectRun,
          });
        },
        runRepo,
        findWaitingRunForIssue: (owner: string, repo: string, issueNumber: number) => {
          const waitingRuns = runRepo.findByStatus("waiting_for_input");
          return waitingRuns.find((r) => {
            const ctx = r.pauseContext as Record<string, unknown> | null;
            if (!ctx) return false;
            const issueCtx = ctx.issueContext as { owner?: string; repo?: string; issueNumber?: number } | undefined;
            return issueCtx?.owner === owner && issueCtx?.repo === repo && issueCtx?.issueNumber === issueNumber;
          });
        },
        resumeRun: resumeRunFn,
        subIssueCache,
      });

      registerGitHubRoutes(app, ghAppService);

      // Wire GitHub context into orchestrator for polling rollup (SUBISSUE-05, SUBISSUE-06)
      if (orchestrator && config.tracker?.repo && config.github_app.installation_id) {
        try {
          const [ghOwner, ghRepo] = config.tracker.repo.split("/");
          const installationOctokit = await ghAppService.getInstallationOctokit(config.github_app.installation_id);
          // Use merger app for PR creation if available (it has PR write permissions)
          let prOctokit: unknown;
          if (config.merger_app) {
            try {
              const { GitHubAppService } = await import("../github/app.js");
              const mergerService = new GitHubAppService({
                appId: config.merger_app.app_id,
                privateKeyPath: config.merger_app.private_key_path,
                webhookSecret: config.merger_app.webhook_secret,
                installationId: config.merger_app.installation_id,
              });
              if (!config.merger_app.installation_id) {
                throw new Error("merger_app.installation_id is required");
              }
              prOctokit = await mergerService.getInstallationOctokit(config.merger_app.installation_id);
              daemonLogger.info("daemon", "PR creation will use merger app (has pulls:write)");
            } catch (mergerErr) {
              daemonLogger.warn("daemon", `Merger app init failed, PR creation will fall back to creator app which may lack pulls:write — PRs may fail: ${mergerErr}`);
            }
          } else {
            daemonLogger.warn("daemon", "merger_app not configured — PR creation will use creator app (github_app) which typically lacks pulls:write permission. Add merger_app to config to fix PR creation.");
          }
          orchestrator.setGitHubContext({ octokit: installationOctokit, prOctokit, repo: { owner: ghOwner, repo: ghRepo } });
          daemonLogger.info("daemon", "GitHub context set on orchestrator for polling rollup");
        } catch (err) {
          daemonLogger.warn("daemon", `Failed to set GitHub context on orchestrator (rollup disabled): ${err}`);
        }
      }

      daemonLogger.info("daemon", "GitHub App initialized, webhook route registered");
    } catch (err) {
      daemonLogger.error("daemon", `Failed to initialize GitHub App: ${err}`);
    }
  }

  // Linear webhook endpoint (when tracker is Linear with webhook_secret configured)
  if (config.tracker?.kind === "linear" && config.tracker.webhook_secret && subIssueCache) {
    const webhookSecret = config.tracker.webhook_secret;
    const { handleLinearWebhook, verifyLinearWebhookSignature } = await import("../tracker/linear.js");

    void app.register(async function linearWebhookPlugin(instance) {
      instance.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        done(null, body);
      });

      instance.post("/api/v1/linear/webhook", async (request, reply) => {
      const rawBody = request.body as string;
      const signature = request.headers["linear-signature"] as string | undefined;

      if (!signature) {
        reply.code(401);
        return { error: "Missing linear-signature header" };
      }

      const valid = await verifyLinearWebhookSignature(rawBody, signature, webhookSecret);
      if (!valid) {
        reply.code(401);
        return { error: "Invalid webhook signature" };
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        reply.code(400);
        return { error: "Invalid JSON" };
      }

      const shouldTick = handleLinearWebhook(payload, subIssueCache!);

      if (shouldTick && orchestrator) {
        void orchestrator.triggerTick();
      }

      return { ok: true };
    });
    }); // end linearWebhookPlugin

    daemonLogger.info("daemon", "Linear webhook endpoint registered at /api/v1/linear/webhook");
  }

  // Start merge daemon poll loop alongside orchestrator (if merge_daemon or merger_app configured)
  let mergeDaemonRunning = false;
  const stopMergeDaemon = { fn: (): void => { mergeDaemonRunning = false; } };
  if (orchestratorEnabled && config.tracker?.repo && (config.merge_daemon || config.merger_app)) {
    try {
      const { PRProcessor } = await import("../merge-daemon/pr-processor.js");

      // Collect all repos to poll: default + all repo profiles
      const repoSet = new Set<string>();
      repoSet.add(config.tracker.repo);
      const reposDir = join(process.env.HOME || "", ".forgectl", "repos");
      if (existsSync(reposDir)) {
        for (const file of readdirSync(reposDir)) {
          if (file.endsWith(".yaml") || file.endsWith(".yml")) {
            try {
              const profileRaw = readFileSync(join(reposDir, file), "utf-8");
              const profile = yaml.load(profileRaw) as { tracker?: { repo?: string } } | null;
              if (profile?.tracker?.repo) repoSet.add(profile.tracker.repo);
            } catch { /* skip invalid profiles */ }
          }
        }
      }
      const allRepos = [...repoSet];
      daemonLogger.info("daemon", `Merge daemon will poll ${allRepos.length} repo(s): ${allRepos.join(", ")}`);

      let mdToken = "";

      // Token refresh state — GitHub App installation tokens expire after 1 hour
      let mergerService: InstanceType<typeof import("../github/app.js").GitHubAppService> | null = null;
      let tokenObtainedAt = 0;
      const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // Refresh after 50 minutes (tokens expire at 60)

      // Get merger app installation token for GitHub API auth
      if (config.merger_app?.installation_id) {
        try {
          const { GitHubAppService } = await import("../github/app.js");
          const resolvedKeyPath = config.merger_app.private_key_path.replace(/^~/, process.env.HOME || "/tmp");
          mergerService = new GitHubAppService({
            appId: config.merger_app.app_id,
            privateKeyPath: resolvedKeyPath,
            webhookSecret: config.merger_app.webhook_secret,
            installationId: config.merger_app.installation_id,
          });
          const mdOctokit = await mergerService.getInstallationOctokit(config.merger_app.installation_id);
          const mdAuth = await (mdOctokit as any).auth({ type: "installation" }) as { token: string };
          if (mdAuth?.token) {
            mdToken = mdAuth.token;
            tokenObtainedAt = Date.now();
          }
        } catch (mergerErr) {
          daemonLogger.warn("daemon", `Merge daemon: merger app token failed: ${mergerErr}`);
        }
      }
      // Fall back to tracker token if it's a GitHub token
      if (!mdToken && config.tracker.kind === "github") {
        mdToken = resolveToken(config.tracker.token);
      }

      /**
       * Refresh the installation token if it's near expiry.
       * Returns the current (possibly refreshed) token.
       */
      const refreshTokenIfNeeded = async (): Promise<string> => {
        if (!mergerService || !config.merger_app?.installation_id) return mdToken;
        if (Date.now() - tokenObtainedAt < TOKEN_REFRESH_INTERVAL_MS) return mdToken;

        try {
          const freshOctokit = await mergerService.getInstallationOctokit(config.merger_app.installation_id);
          const freshAuth = await (freshOctokit as any).auth({ type: "installation" }) as { token: string };
          if (freshAuth?.token) {
            mdToken = freshAuth.token;
            tokenObtainedAt = Date.now();
            daemonLogger.info("daemon", "Refreshed GitHub App installation token");

            // Also refresh the orchestrator's GitHub context
            if (orchestrator && config.tracker?.repo) {
              const [ghOwner, ghRepo] = config.tracker.repo.split("/");
              // Use creator app (ghAppService) for octokit (comments/issues API)
              // and merger app (freshOctokit) for prOctokit (PR creation)
              let creatorOctokitForContext: unknown = freshOctokit;
              if (ghAppService && config.github_app?.installation_id) {
                try {
                  creatorOctokitForContext = await ghAppService.getInstallationOctokit(config.github_app.installation_id);
                } catch (creatorErr) {
                  daemonLogger.warn("daemon", `Failed to refresh creator app octokit, using merger app for comments (may lack .rest.issues): ${creatorErr}`);
                }
              }
              const octokitForContext = creatorOctokitForContext as any;
              if (!octokitForContext?.rest?.issues) {
                daemonLogger.warn("daemon", "Refreshed octokit for orchestrator GitHub context is missing .rest.issues — progress comments will fail");
              }
              orchestrator.setGitHubContext({
                octokit: creatorOctokitForContext,
                prOctokit: freshOctokit,
                repo: { owner: ghOwner, repo: ghRepo },
              });
            }
          }
        } catch (err) {
          daemonLogger.warn("daemon", `Token refresh failed: ${err}`);
        }
        return mdToken;
      };

      if (mdToken) {
        const daemonConfig = config.merge_daemon;
        // rawToken is used for git clone auth — use the actual token, not a sentinel
        const rawToken = mdToken;
        const pollIntervalMs = daemonConfig?.poll_interval_ms ?? 60_000;
        mergeDaemonRunning = true;

        // Create review metrics + findings repos for tracking
        const { createReviewMetricsRepository } = await import("../storage/repositories/review-metrics.js");
        const { createReviewFindingsRepository } = await import("../storage/repositories/review-findings.js");
        const reviewMetricsRepo = createReviewMetricsRepository(db);
        const reviewFindingsRepo = createReviewFindingsRepository(db);

        // Create a processor per repo
        const processors: InstanceType<typeof PRProcessor>[] = allRepos.map(repoSlug => {
          const [o, r] = repoSlug.split("/");
          return new PRProcessor({
            owner: o, repo: r, token: mdToken,
            rawToken,
            branchPattern: daemonConfig?.branch_pattern ?? "forge/*",
            ciTimeoutMs: daemonConfig?.ci_timeout_ms ?? 2_700_000,
            enableReview: daemonConfig?.enable_review ?? true,
            enableBuildFix: daemonConfig?.enable_build_fix ?? true,
            validationCommands: daemonConfig?.validation_commands ?? [],
          }, daemonLogger, reviewMetricsRepo, reviewFindingsRepo);
        });

        const addMergeDaemonRepo = (slug: string): boolean => {
          if (repoSet.has(slug)) return false;
          repoSet.add(slug);
          const [o, r] = slug.split("/");
          processors.push(new PRProcessor({
            owner: o, repo: r, token: lastProcessorToken,
            rawToken,
            branchPattern: daemonConfig?.branch_pattern ?? "forge/*",
            ciTimeoutMs: daemonConfig?.ci_timeout_ms ?? 2_700_000,
            enableReview: daemonConfig?.enable_review ?? true,
            enableBuildFix: daemonConfig?.enable_build_fix ?? true,
            validationCommands: daemonConfig?.validation_commands ?? [],
          }, daemonLogger, reviewMetricsRepo, reviewFindingsRepo));
          daemonLogger.info("merge-daemon", `Dynamically added repo ${slug} to poll list`);
          return true;
        };

        if (orchestrator) {
          orchestrator.setAddRepo(addMergeDaemonRepo);
        }

        let lastProcessorToken = mdToken;
        const mergePollLoop = async (): Promise<void> => {
          while (mergeDaemonRunning) {
            // Refresh token before each poll cycle if near expiry
            try {
              const freshToken = await refreshTokenIfNeeded();
              if (freshToken !== lastProcessorToken) {
                for (const processor of processors) {
                  processor.updateToken(freshToken);
                }
                lastProcessorToken = freshToken;
              }
            } catch (err) {
              daemonLogger.warn("merge-daemon", `Token refresh check failed: ${err}`);
            }

            for (const processor of processors) {
              if (!mergeDaemonRunning) break;
              try {
                const prs = await processor.fetchOpenForgePRs();
                if (prs.length > 0) {
                  daemonLogger.info("merge-daemon", `Found ${prs.length} open forge PR(s)`);
                  for (const pr of prs) {
                    if (!mergeDaemonRunning) break;
                    const result = await processor.processPR(pr);
                    if (result.status === "merged") {
                      daemonLogger.info("merge-daemon", `PR #${pr.number} merged`);
                    } else if (result.status === "failed") {
                      daemonLogger.warn("merge-daemon", `PR #${pr.number}: ${result.error}`);
                    }
                  }
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                daemonLogger.error("merge-daemon", `Poll error: ${msg}`);
              }
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }
        };

        void mergePollLoop();
        daemonLogger.info("daemon", `Merge daemon integrated (poll=${pollIntervalMs}ms, ${allRepos.length} repos)`);
      } else {
        daemonLogger.warn("daemon", "Merge daemon: no GitHub token available, skipping PR auto-merge");
      }
    } catch (err) {
      daemonLogger.warn("daemon", `Failed to start integrated merge daemon: ${err}`);
    }
  }

  await app.listen({ port, host: "127.0.0.1" });
  savePid(process.pid);

  console.log(`forgectl daemon running on http://127.0.0.1:${port}`);

  // Discord bot initialization (when discord.enabled is true)
  if (config.discord?.enabled) {
    try {
      const { startDiscordBot } = await import("../discord/bot.js");
      discordBot = await startDiscordBot({
        config,
        logger: daemonLogger,
        daemonPort: port,
        daemonToken,
        db,
      });
      daemonLogger.info("daemon", "Discord bot started");
    } catch (err) {
      daemonLogger.error("daemon", `Failed to start Discord bot: ${err}`);
    }
  }

  const shutdown = async () => {
    stopMergeDaemon.fn();
    watcher?.stop();
    if (discordBot) {
      await discordBot.stop();
    }
    if (orchestrator) {
      await orchestrator.stop();
    }
    recorder.close();
    closeDatabase(db);
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
 * Clones the repo and sets git identity for forgectl commits.
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
