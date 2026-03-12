import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { BoardEngine } from "../board/engine.js";
import { BoardStore } from "../board/store.js";
import { CreateCardSchema, TriggerCardSchema, UpdateCardSchema } from "../board/schema.js";
import { PipelineRunService, PipelineValidationError } from "./pipeline-service.js";
import type { PipelineDefinition } from "../pipeline/types.js";
import type { Orchestrator } from "../orchestrator/index.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { resumeRun } from "../durability/pause.js";
import { approveRun, rejectRun, requestRevision } from "../governance/approval.js";

interface InlineContext {
  name: string;
  content: string;
}

interface RouteServices {
  pipelineService?: PipelineRunService;
  boardStore?: BoardStore;
  boardEngine?: BoardEngine;
  orchestrator?: Orchestrator;
  runRepo?: RunRepository;
}

export function registerRoutes(app: FastifyInstance, queue: RunQueue, services: RouteServices = {}): void {
  const pipelineService = services.pipelineService ?? new PipelineRunService();
  const boardStore = services.boardStore;
  const boardEngine = services.boardEngine;
  const orchestrator = services.orchestrator;
  const runRepo = services.runRepo;

  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Hello world
  app.get("/hello", async () => ({ message: "Hello, world!" }));

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

  // Submit a pipeline
  app.post<{
    Body: {
      pipeline: Record<string, unknown>;
      repo?: string;
      fromNode?: string;
      dryRun?: boolean;
      verbose?: boolean;
    };
  }>("/pipelines", async (request, reply) => {
    const { pipeline, repo, fromNode, dryRun, verbose } = request.body;
    if (!pipeline) {
      reply.code(400);
      return { error: "pipeline is required" };
    }

    try {
      const submitted = pipelineService.submitPipeline(pipeline as unknown as PipelineDefinition, {
        repo,
        fromNode,
        dryRun,
        verbose,
      });
      reply.code(202);
      return submitted;
    } catch (err) {
      if (err instanceof PipelineValidationError) {
        reply.code(400);
        return { error: err.message, details: err.details };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // List pipeline runs
  app.get("/pipelines", async () => pipelineService.listRuns());

  // Get pipeline run status
  app.get<{ Params: { id: string } }>("/pipelines/:id", async (request, reply) => {
    const run = pipelineService.getRun(request.params.id);
    if (!run) {
      reply.code(404);
      return { error: "Pipeline run not found" };
    }
    return run;
  });

  // Pipeline SSE events
  app.get<{ Params: { id: string } }>("/pipelines/:id/events", async (request, reply) => {
    const run = pipelineService.getRun(request.params.id);
    if (!run) {
      reply.code(404);
      return { error: "Pipeline run not found" };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const handler = (event: RunEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    runEvents.on(`run:${request.params.id}`, handler);

    request.raw.on("close", () => {
      runEvents.off(`run:${request.params.id}`, handler);
    });
  });

  // Re-run pipeline from a node
  app.post<{
    Params: { id: string };
    Body: { fromNode: string; repo?: string; verbose?: boolean; checkpointRunId?: string };
  }>("/pipelines/:id/rerun", async (request, reply) => {
    const { fromNode } = request.body;
    if (!fromNode) {
      reply.code(400);
      return { error: "fromNode is required" };
    }

    try {
      const result = pipelineService.rerunPipeline(request.params.id, {
        fromNode,
        repo: request.body.repo,
        verbose: request.body.verbose,
        checkpointRunId: request.body.checkpointRunId,
      });
      reply.code(202);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      return { error: message };
    }
  });

  // --- Board API ---
  app.get("/boards", async (_request, reply) => {
    if (!boardStore) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    const boards = await boardStore.listBoards();
    return boards;
  });

  app.post<{ Body: { file: string } }>("/boards", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    if (!request.body.file) {
      reply.code(400);
      return { error: "file is required" };
    }

    try {
      const board = await boardEngine.registerBoardFile(request.body.file);
      reply.code(201);
      return board;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Params: { id: string } }>("/boards/:id", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    const board = await boardEngine.getBoard(request.params.id);
    if (!board) {
      reply.code(404);
      return { error: "Board not found" };
    }
    return board;
  });

  app.patch<{ Params: { id: string }; Body: { file?: string } }>("/boards/:id", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    const existing = await boardEngine.getBoard(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: "Board not found" };
    }

    const filePath = request.body.file ?? existing.definitionPath;
    try {
      const board = await boardEngine.registerBoardFile(filePath);
      return board;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Params: { id: string } }>("/boards/:id/cards", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    const board = await boardEngine.getBoard(request.params.id);
    if (!board) {
      reply.code(404);
      return { error: "Board not found" };
    }
    return board.cards;
  });

  app.post<{
    Params: { id: string };
    Body: {
      id?: string;
      title: string;
      type: string;
      column?: string;
      params?: Record<string, string | number | boolean>;
    };
  }>("/boards/:id/cards", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    try {
      const payload = CreateCardSchema.parse(request.body);
      const card = await boardEngine.createCard(request.params.id, payload);
      reply.code(201);
      return card;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(message.includes("not found") ? 404 : 400);
      return { error: message };
    }
  });

  app.patch<{
    Params: { id: string; cardId: string };
    Body: {
      title?: string;
      column?: string;
      params?: Record<string, string | number | boolean>;
    };
  }>("/boards/:id/cards/:cardId", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    try {
      const payload = UpdateCardSchema.parse(request.body);
      const card = await boardEngine.updateCard(request.params.id, request.params.cardId, payload);
      return card;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(message.includes("not found") ? 404 : 400);
      return { error: message };
    }
  });

  app.post<{
    Params: { id: string; cardId: string };
    Body: { mode?: "manual" | "auto" | "scheduled" };
  }>("/boards/:id/cards/:cardId/trigger", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    try {
      const mode = TriggerCardSchema.parse(request.body ?? {}).mode;
      const result = await boardEngine.triggerCardRun(request.params.id, request.params.cardId, mode);
      reply.code(202);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already has an active run") || message.includes("capacity")) {
        reply.code(409);
      } else if (message.includes("not found")) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      return { error: message };
    }
  });

  app.get<{ Params: { id: string; cardId: string } }>("/boards/:id/cards/:cardId/runs", async (request, reply) => {
    if (!boardEngine) {
      reply.code(503);
      return { error: "Board service is not configured" };
    }

    const board = await boardEngine.getBoard(request.params.id);
    if (!board) {
      reply.code(404);
      return { error: "Board not found" };
    }

    const card = board.cards.find((entry) => entry.id === request.params.cardId);
    if (!card) {
      reply.code(404);
      return { error: "Card not found" };
    }

    return card.runHistory;
  });

  // --- Orchestrator Observability API ---

  const orchError503 = { error: { code: "NOT_CONFIGURED", message: "Orchestrator not running" } };

  // GET /api/v1/state — orchestrator state snapshot
  app.get("/api/v1/state", async (_request, reply) => {
    if (!orchestrator || !orchestrator.isRunning()) {
      reply.code(503);
      return orchError503;
    }

    const state = orchestrator.getState();
    const metrics = orchestrator.getMetrics();
    const snapshot = metrics.getSnapshot();
    const slots = orchestrator.getSlotUtilization();

    const running = [...state.running.values()].map((w) => {
      const issueM = metrics.getIssueMetrics(w.issueId);
      return {
        issueId: w.issueId,
        identifier: w.identifier,
        startedAt: new Date(w.startedAt).toISOString(),
        attempt: w.attempt,
        tokens: issueM?.tokens ?? { input: 0, output: 0, total: 0 },
      };
    });

    // Retry queue: issues in retryAttempts that are NOT currently running
    const retryQueue: { issueId: string; identifier: string; attempt: number }[] = [];
    for (const [issueId, attempt] of state.retryAttempts.entries()) {
      if (!state.running.has(issueId)) {
        // Try to find identifier from metrics or claimed set
        const issueM = metrics.getIssueMetrics(issueId);
        retryQueue.push({
          issueId,
          identifier: issueM?.identifier ?? issueId,
          attempt,
        });
      }
    }

    return {
      status: "running",
      uptimeMs: snapshot.uptimeMs,
      running,
      retryQueue,
      slots,
      totals: snapshot.totals,
    };
  });

  // GET /api/v1/issues/:identifier — per-issue details
  app.get<{ Params: { identifier: string } }>("/api/v1/issues/:identifier", async (request, reply) => {
    if (!orchestrator || !orchestrator.isRunning()) {
      reply.code(503);
      return orchError503;
    }

    const identifier = request.params.identifier;
    const state = orchestrator.getState();
    const metrics = orchestrator.getMetrics();
    const snapshot = metrics.getSnapshot();

    // Search running workers
    let found = false;
    for (const worker of state.running.values()) {
      if (worker.identifier === identifier) {
        const issueM = metrics.getIssueMetrics(worker.issueId);
        return {
          identifier: worker.identifier,
          issue: {
            id: worker.issue.id,
            title: worker.issue.title,
            state: worker.issue.state,
            labels: worker.issue.labels,
          },
          orchestratorState: "running" as const,
          session: {
            startedAt: new Date(worker.startedAt).toISOString(),
            lastActivityAt: new Date(worker.lastActivityAt).toISOString(),
            attempt: worker.attempt,
          },
          metrics: {
            totalAttempts: issueM?.attempts ?? worker.attempt,
            totalRuntime: issueM?.runtimeMs ?? 0,
            tokens: issueM?.tokens ?? { input: 0, output: 0, total: 0 },
          },
        };
      }
    }

    // Search completed/active metrics
    const allMetrics = [...snapshot.active, ...snapshot.completed];
    const metricEntry = allMetrics.find((m) => m.identifier === identifier);
    if (metricEntry) {
      // Determine state from retry queue or metric status
      let orchState: string = metricEntry.status;
      if (state.retryAttempts.has(metricEntry.issueId) && !state.running.has(metricEntry.issueId)) {
        orchState = "retry_queued";
      }

      return {
        identifier: metricEntry.identifier,
        issue: { id: metricEntry.issueId },
        orchestratorState: orchState,
        session: null,
        metrics: {
          totalAttempts: metricEntry.attempts,
          totalRuntime: metricEntry.runtimeMs,
          tokens: metricEntry.tokens,
        },
      };
    }

    if (!found) {
      reply.code(404);
      return { error: { code: "NOT_FOUND", message: `Issue '${identifier}' not found` } };
    }
  });

  // POST /api/v1/refresh — trigger immediate tick
  app.post("/api/v1/refresh", async (_request, reply) => {
    if (!orchestrator || !orchestrator.isRunning()) {
      reply.code(503);
      return orchError503;
    }

    const triggered = await orchestrator.triggerTick();
    reply.code(202);
    if (triggered) {
      return { triggered: true };
    }
    return { triggered: false, reason: "tick_in_progress" };
  });

  // GET /api/v1/events — SSE stream for orchestrator events
  app.get("/api/v1/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const handler = (event: RunEvent) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Swallow sink errors (client may have disconnected)
      }
    };

    runEvents.on("run:orchestrator", handler);

    request.raw.on("close", () => {
      runEvents.off("run:orchestrator", handler);
    });
  });

  // --- Run Pause/Resume API ---

  app.post<{ Params: { id: string }; Body: { input: string } }>(
    "/api/v1/runs/:id/resume",
    async (request, reply) => {
      if (!runRepo) {
        reply.code(503);
        return { error: { code: "NOT_CONFIGURED", message: "Run repository not available" } };
      }

      const { id } = request.params;
      const body = request.body as { input?: string } | null;
      const input = body?.input;
      if (!input || typeof input !== "string") {
        reply.code(400);
        return { error: { code: "BAD_REQUEST", message: "input field is required" } };
      }

      try {
        const result = resumeRun(runRepo, id, input);
        return { status: "resumed", runId: result.runId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found")) {
          reply.code(404);
          return { error: { code: "NOT_FOUND", message } };
        }
        reply.code(409);
        return { error: { code: "CONFLICT", message } };
      }
    },
  );

  // --- Governance Approval API ---

  app.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/approve",
    async (request, reply) => {
      if (!runRepo) {
        reply.code(503);
        return { error: { code: "NOT_CONFIGURED", message: "Run repository not available" } };
      }

      const { id } = request.params;

      try {
        const { previousStatus } = approveRun(runRepo, id);
        return { status: "approved", runId: id, previousStatus };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found")) {
          reply.code(404);
          return { error: { code: "NOT_FOUND", message } };
        }
        reply.code(409);
        return { error: { code: "CONFLICT", message } };
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { reason?: string; action?: string; feedback?: string };
  }>(
    "/api/v1/runs/:id/reject",
    async (request, reply) => {
      if (!runRepo) {
        reply.code(503);
        return { error: { code: "NOT_CONFIGURED", message: "Run repository not available" } };
      }

      const { id } = request.params;
      const body = (request.body ?? {}) as { reason?: string; action?: string; feedback?: string };

      try {
        if (body.action === "revision_requested" && body.feedback) {
          requestRevision(runRepo, id, body.feedback);
          return { status: "revision_requested", runId: id };
        }

        rejectRun(runRepo, id, body.reason);
        return { status: "rejected", runId: id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found")) {
          reply.code(404);
          return { error: { code: "NOT_FOUND", message } };
        }
        reply.code(409);
        return { error: { code: "CONFLICT", message } };
      }
    },
  );
}
