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
import { createTrackerAdapter } from "../tracker/registry.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadWorkflowFile } from "../workflow/workflow-file.js";
import { WorkflowFileWatcher } from "../workflow/watcher.js";
import { mergeWorkflowConfig } from "../workflow/merge.js";
import { mapFrontMatterToConfig } from "../workflow/map-front-matter.js";
import { ConfigSchema } from "../config/schema.js";
import type { ValidatedWorkflowFile } from "../workflow/types.js";
import type { ForgectlConfig } from "../config/schema.js";

export async function startDaemon(port = 4856, enableOrchestrator = false): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const config = loadConfig();

  // Initialize persistent storage
  const dbPath = config.storage?.db_path?.replace(/^~/, process.env.HOME || "/tmp");
  const db = createDatabase(dbPath);
  runMigrations(db);
  const runRepo = createRunRepository(db);
  const pipelineRepo = createPipelineRepository(db);
  const snapshotRepo = createSnapshotRepository(db);
  const lockRepo = createLockRepository(db);

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
    const runConfig = loadConfig();
    const plan = resolveRunPlan(runConfig, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid });
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
  let watcher: WorkflowFileWatcher | null = null;
  const orchestratorEnabled = enableOrchestrator || config.orchestrator?.enabled;
  if (orchestratorEnabled && config.tracker) {
    try {
      const tracker = createTrackerAdapter(config.tracker);
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

      const promptTemplate = wf?.promptTemplate
        ?? "Resolve the following issue: {{issue.title}}\n\n{{issue.description}}";

      orchestrator = new Orchestrator({ tracker, workspaceManager, config: mergedConfig, promptTemplate, logger: daemonLogger });
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
  });

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
    closeDatabase(db);
    removePid();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
