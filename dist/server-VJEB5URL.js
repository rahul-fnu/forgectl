#!/usr/bin/env node
import {
  Logger,
  executeRun,
  removePid,
  resolveRunPlan,
  runEvents,
  savePid
} from "./chunk-OJKWABHL.js";
import {
  loadConfig
} from "./chunk-DMQRMT43.js";
import "./chunk-OH6J5HYU.js";

// src/daemon/server.ts
import Fastify from "fastify";
import cors from "@fastify/cors";

// src/daemon/queue.ts
var RunQueue = class {
  queue = [];
  running = false;
  onExecute;
  constructor(onExecute) {
    this.onExecute = onExecute;
  }
  submit(id, options) {
    const run = {
      id,
      options,
      status: "queued",
      submittedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.queue.push(run);
    void this.processNext();
    return run;
  }
  get(id) {
    return this.queue.find((r) => r.id === id);
  }
  list() {
    return [...this.queue];
  }
  async processNext() {
    if (this.running) return;
    const next = this.queue.find((r) => r.status === "queued");
    if (!next) return;
    this.running = true;
    next.status = "running";
    next.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      next.result = await this.onExecute(next);
      next.status = next.result.success ? "completed" : "failed";
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : String(err);
    } finally {
      next.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.running = false;
      void this.processNext();
    }
  }
};

// src/daemon/routes.ts
function registerRoutes(app, queue) {
  app.get("/health", async () => ({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
  app.post(
    "/runs",
    async (request, reply) => {
      const { task, workflow, input, agent } = request.body;
      if (!task) {
        reply.code(400);
        return { error: "task is required" };
      }
      const id = `forge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const run = queue.submit(id, { task, workflow, input, agent });
      reply.code(202);
      return { id: run.id, status: run.status };
    }
  );
  app.get("/runs", async () => {
    return queue.list().map((r) => ({
      id: r.id,
      status: r.status,
      workflow: r.options.workflow,
      task: r.options.task,
      submittedAt: r.submittedAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt
    }));
  });
  app.get("/runs/:id", async (request, reply) => {
    const run = queue.get(request.params.id);
    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }
    return run;
  });
  app.get("/runs/:id/events", async (request, reply) => {
    const runId = request.params.id;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    const handler = (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}

`);
    };
    runEvents.on(`run:${runId}`, handler);
    request.raw.on("close", () => {
      runEvents.off(`run:${runId}`, handler);
    });
  });
}

// src/daemon/server.ts
async function startDaemon(port = 4856) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  const queue = new RunQueue(async (run) => {
    const config = loadConfig();
    const plan = resolveRunPlan(config, run.options);
    const logger = new Logger(false);
    return executeRun(plan, logger);
  });
  registerRoutes(app, queue);
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
export {
  startDaemon
};
//# sourceMappingURL=server-VJEB5URL.js.map