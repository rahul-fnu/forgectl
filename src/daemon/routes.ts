import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { emitRunEvent } from "../logging/events.js";

interface InlineContext {
  name: string;
  content: string;
}

export function registerRoutes(app: FastifyInstance, queue: RunQueue): void {
  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Version info
  app.get("/version", async () => ({ version: "0.1.0", name: "forgectl" }));

  // Auth status for dashboard settings page
  app.get("/auth/status", async () => {
    const claude = await getClaudeAuth();
    const codex = await getCodexAuth();
    return {
      claude: claude ? { type: claude.type, configured: true } : { configured: false },
      codex: codex ? { type: codex.type, configured: true } : { configured: false },
    };
  });

  // Submit a run
  app.post<{
    Body: {
      task: string;
      workflow?: string;
      input?: string[];
      agent?: string;
      repo?: string;
      context?: InlineContext[];
    };
  }>("/runs", async (request, reply) => {
    const { task, workflow, input, agent, repo, context } = request.body;
    if (!task) {
      reply.code(400);
      return { error: "task is required" };
    }

    // Write inline context items to temp files
    let contextFiles: string[] | undefined;
    if (context && context.length > 0) {
      const tmpDir = mkdtempSync(join(tmpdir(), "forgectl-ctx-"));
      contextFiles = context.map((item) => {
        const filePath = join(tmpDir, item.name);
        writeFileSync(filePath, item.content, "utf-8");
        return filePath;
      });
    }

    const id = `forge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run = queue.submit(id, {
      task,
      workflow,
      input,
      agent,
      repo,
      context: contextFiles,
    });
    reply.code(202);
    return { id: run.id, status: run.status };
  });

  // List runs
  app.get("/runs", async () => {
    return queue.list().map((run) => ({
      id: run.id,
      status: run.status,
      workflow: run.options.workflow,
      task: run.options.task,
      submittedAt: run.submittedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
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

  // Get structured output for a completed run
  app.get<{ Params: { id: string } }>("/runs/:id/output", async (request, reply) => {
    const run = queue.get(request.params.id);
    if (!run?.result?.output) {
      reply.code(404);
      return { error: "No output available" };
    }
    return run.result.output;
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

  // SSE stream (auth via query param)
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/api/v1/runs/:id/stream",
    async (request, reply) => {
      const runId = request.params.id;
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const handler = (event: RunEvent) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Client may have disconnected
        }
      };

      runEvents.on(`run:${runId}`, handler);

      request.raw.on("close", () => {
        runEvents.off(`run:${runId}`, handler);
      });
    },
  );

  // Cancel a run
  app.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/cancel",
    async (request, reply) => {
      const { id } = request.params;
      const run = queue.get(id);
      if (!run) {
        reply.code(404);
        return { error: { code: "NOT_FOUND", message: `Run ${id} not found` } };
      }

      const cancellable = new Set(["queued", "running"]);
      if (!cancellable.has(run.status)) {
        reply.code(409);
        return { error: { code: "CONFLICT", message: `Run ${id} is ${run.status}, cannot cancel` } };
      }

      run.status = "failed" as any;
      run.error = "Cancelled via API";
      run.completedAt = new Date().toISOString();
      emitRunEvent({ runId: id, type: "failed", timestamp: new Date().toISOString(), data: { reason: "cancelled" } });
      return { status: "cancelled", runId: id };
    },
  );

  // CLAUDE.md update endpoint
  app.post<{ Body: { workspace: string } }>(
    "/api/v1/claude-md/update",
    async (request, reply) => {
      const { workspace } = request.body ?? {};
      if (!workspace) {
        reply.code(400);
        return { error: "workspace is required" };
      }

      try {
        const { generateClaudeMd, recordBaseline } = await import("../context/claude-md.js");
        const { existsSync, writeFileSync: writeFs } = await import("node:fs");
        const { join: pathJoin } = await import("node:path");
        const os = await import("node:os");

        const wsRoot = pathJoin(os.homedir(), ".forgectl", "workspaces");
        const wsPath = pathJoin(wsRoot, workspace);

        if (!existsSync(wsPath)) {
          reply.code(404);
          return { error: `Workspace "${workspace}" not found` };
        }

        const content = generateClaudeMd(wsPath, workspace);
        writeFs(pathJoin(wsPath, "CLAUDE.md"), content);
        recordBaseline(wsPath);

        return { status: "updated", workspace };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.code(500);
        return { error: msg };
      }
    },
  );
}
