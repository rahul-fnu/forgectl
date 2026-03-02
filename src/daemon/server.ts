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

export async function startDaemon(port = 4856): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const queue = new RunQueue(async (run: QueuedRun) => {
    const config = loadConfig();
    const plan = resolveRunPlan(config, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger);
  });

  registerRoutes(app, queue);

  // Serve dashboard UI — find the index.html from src/ui or bundled location
  const selfDir = typeof import.meta.dirname === "string" ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));
  const uiCandidates = [
    join(selfDir, "ui", "index.html"),         // bundled alongside dist/
    join(selfDir, "..", "src", "ui", "index.html"), // running from dist/ in dev
    join(selfDir, "..", "ui", "index.html"),    // alt layout
  ];
  const uiPath = uiCandidates.find(p => existsSync(p));
  if (uiPath) {
    const html = readFileSync(uiPath, "utf-8");
    app.get("/ui", async (_req, reply) => { reply.type("text/html").send(html); });
    // Serve at root only if no other route matched (register after API routes)
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/ui"))) {
        reply.type("text/html").send(html);
      } else {
        reply.code(404).send({ error: "Not found" });
      }
    });
  }

  await app.listen({ port, host: "127.0.0.1" });
  savePid(process.pid);

  console.log(`forgectl daemon running on http://127.0.0.1:${port}`);

  const shutdown = async () => {
    removePid();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
