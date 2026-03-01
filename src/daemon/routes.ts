import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";

export function registerRoutes(app: FastifyInstance, queue: RunQueue): void {
  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Submit a run
  app.post<{ Body: { task: string; workflow?: string; input?: string[]; agent?: string } }>(
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

  // List runs
  app.get("/runs", async () => {
    return queue.list().map(r => ({
      id: r.id,
      status: r.status,
      workflow: r.options.workflow,
      task: r.options.task,
      submittedAt: r.submittedAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  });

  // Get run status
  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = queue.get(request.params.id);
    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }
    return run;
  });

  // SSE stream for a run's events
  app.get<{ Params: { id: string } }>("/runs/:id/events", async (request, reply) => {
    const runId = request.params.id;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const handler = (event: RunEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    runEvents.on(`run:${runId}`, handler);

    request.raw.on("close", () => {
      runEvents.off(`run:${runId}`, handler);
    });
  });
}
