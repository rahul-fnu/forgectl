import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";
import { savePid, removePid } from "./lifecycle.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import type { QueuedRun } from "./queue.js";
import { BoardEngine } from "../board/engine.js";
import { BoardStore, resolveBoardStateDir } from "../board/store.js";
import { PipelineRunService } from "./pipeline-service.js";

export async function startDaemon(port = 4856): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const queue = new RunQueue(async (run: QueuedRun) => {
    const config = loadConfig();
    const plan = resolveRunPlan(config, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger);
  });

  const config = loadConfig();
  const pipelineService = new PipelineRunService();
  const boardStore = new BoardStore(resolveBoardStateDir(config.board.state_dir));
  const boardEngine = new BoardEngine(boardStore, pipelineService, {
    maxConcurrentCardRuns: config.board.max_concurrent_card_runs,
  });

  registerRoutes(app, queue, {
    pipelineService,
    boardStore,
    boardEngine,
  });

  const schedulerInterval = setInterval(() => {
    void boardEngine.schedulerTick();
  }, config.board.scheduler_tick_seconds * 1000);

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
    removePid();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
