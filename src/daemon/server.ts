import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";
import { savePid, removePid } from "./lifecycle.js";
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
import { BoardEngine } from "../board/engine.js";
import { BoardStore, resolveBoardStateDir } from "../board/store.js";
import { PipelineRunService } from "./pipeline-service.js";
import { Orchestrator } from "../orchestrator/index.js";
import { SubIssueCache } from "../tracker/sub-issue-cache.js";
import { createTrackerAdapter } from "../tracker/registry.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadWorkflowFile } from "../workflow/workflow-file.js";
import { WorkflowFileWatcher } from "../workflow/watcher.js";
import { mergeWorkflowConfig } from "../workflow/merge.js";
import { mapFrontMatterToConfig } from "../workflow/map-front-matter.js";
import { ConfigSchema } from "../config/schema.js";
import type { ValidatedWorkflowFile } from "../workflow/types.js";
import type { ForgectlConfig } from "../config/schema.js";

export async function startDaemon(port = 4856, enableOrchestrator = false, configPath?: string): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

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

  // Mark interrupted runs
  const recoveryResults = recoverInterruptedRuns(runRepo, snapshotRepo);
  for (const r of recoveryResults) {
    daemonLogger.info("recovery", `Run ${r.runId}: ${r.action} -- ${r.reason}`);
  }

  const queue = new RunQueue(runRepo, async (run: QueuedRun) => {
    const runConfig = loadConfig(configPath);
    const plan = resolveRunPlan(runConfig, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid, runRepo }, { outcomeRepo });
  });

  const pipelineService = new PipelineRunService(pipelineRepo);
  const boardStore = new BoardStore(resolveBoardStateDir(config.board.state_dir));
  const boardEngine = new BoardEngine(boardStore, pipelineService, {
    maxConcurrentCardRuns: config.board.max_concurrent_card_runs,
  });

  const schedulerInterval = setInterval(() => {
    void boardEngine.schedulerTick();
  }, config.board.scheduler_tick_seconds * 1000);

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

      // Four-layer config merge: defaults < yaml < front matter < CLI (CLI empty for now)
      const defaults = ConfigSchema.parse({});
      const frontMatterAsConfig = wf ? mapFrontMatterToConfig(wf.config) : {};
      const mergedConfig = mergeWorkflowConfig(defaults, config as Partial<ForgectlConfig>, frontMatterAsConfig, {});

      const { DEFAULT_PROMPT_TEMPLATE } = await import("../workflow/workflow-file.js");
      const promptTemplate = wf?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;

      orchestrator = new Orchestrator({
        tracker, workspaceManager, config: mergedConfig, promptTemplate, logger: daemonLogger,
        runRepo, costRepo, retryRepo,
        autonomy: wf?.config?.autonomy,
        autoApprove: wf?.config?.auto_approve,
        subIssueCache,
        skills: wf?.config?.skills,
        validationConfig: wf?.config?.validation,
      });
      await orchestrator.start();

      // Start file watcher for hot-reload (only if WORKFLOW.md exists)
      if (wf) {
        watcher = new WorkflowFileWatcher();
        void watcher.start(workflowPath, {
          onReload: (newWf: ValidatedWorkflowFile) => {
            const newFmConfig = mapFrontMatterToConfig(newWf.config);
            const newMerged = mergeWorkflowConfig(defaults, config as Partial<ForgectlConfig>, newFmConfig, {});
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
    boardStore,
    boardEngine,
    orchestrator: orchestrator ?? undefined,
    runRepo,
    outcomeRepo,
  });

  // GitHub App initialization (optional, only when config.github_app is present)
  if (config.github_app) {
    try {
      const { createGitHubAppService } = await import("../github/app.js");
      const { registerGitHubRoutes } = await import("../github/routes.js");
      const { registerWebhookHandlers } = await import("../github/webhooks.js");
      const { resumeRun } = await import("../durability/pause.js");

      const ghAppService = createGitHubAppService({
        appId: config.github_app.app_id,
        privateKeyPath: config.github_app.private_key_path,
        webhookSecret: config.github_app.webhook_secret,
        installationId: config.github_app.installation_id,
      });

      const { handleSlashCommand } = await import("../github/command-handler.js");
      const { approveRun, rejectRun } = await import("../governance/approval.js");

      registerWebhookHandlers(ghAppService.app, {
        triggerLabel: "forgectl",
        onDispatch: (issue, octokit, repo) => {
          if (orchestrator) {
            daemonLogger.info("github", `Dispatching issue ${issue.identifier} via webhook`);
            orchestrator.dispatchIssue(issue, { octokit: octokit as any, repo });
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
        resumeRun,
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
              daemonLogger.info("daemon", "Merger app octokit initialized for PR creation");
            } catch (mergerErr) {
              daemonLogger.warn("daemon", `Merger app init failed, PR creation will use creator app: ${mergerErr}`);
            }
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

    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    app.post("/api/v1/linear/webhook", async (request, reply) => {
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

    daemonLogger.info("daemon", "Linear webhook endpoint registered at /api/v1/linear/webhook");
  }

  // Serve dashboard UI — find the index.html from src/ui or bundled location
  const selfDir = typeof import.meta.dirname === "string" ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));
  const uiCandidates = [
    join(selfDir, "ui", "index.html"),         // bundled alongside dist/
    join(selfDir, "..", "src", "ui", "index.html"), // running from dist/ in dev
    join(selfDir, "..", "ui", "index.html"),    // alt layout
  ];
  const uiPath = uiCandidates.find((candidate) => existsSync(candidate));
  app.get("/", async (_req, reply) => {
    if (!uiPath) {
      reply.type("text/html").send("<h1>forgectl dashboard</h1><p>UI file not found</p>");
      return;
    }
    reply.type("text/html").send(readFileSync(uiPath, "utf-8"));
  });
  app.get("/ui", async (_req, reply) => {
    if (!uiPath) {
      reply.type("text/html").send("<h1>forgectl dashboard</h1><p>UI file not found</p>");
      return;
    }
    reply.type("text/html").send(readFileSync(uiPath, "utf-8"));
  });

  await app.listen({ port, host: "127.0.0.1" });
  savePid(process.pid);

  console.log(`forgectl daemon running on http://127.0.0.1:${port}`);

  const shutdown = async () => {
    clearInterval(schedulerInterval);
    watcher?.stop();
    if (orchestrator) {
      await orchestrator.stop();
    }
    recorder.close();
    closeDatabase(db);
    removePid();
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
