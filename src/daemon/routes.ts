import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { PipelineRunService, PipelineValidationError } from "./pipeline-service.js";
import type { PipelineDefinition } from "../pipeline/types.js";
import type { Orchestrator } from "../orchestrator/index.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { resumeRun } from "../durability/pause.js";
import { emitRunEvent } from "../logging/events.js";
import type { CostRepository } from "../storage/repositories/costs.js";
import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { AnalyticsRepository } from "../storage/repositories/analytics.js";
import { getBudgetStatus } from "../agent/budget.js";
import type { BudgetConfig } from "../agent/budget.js";
import type { TrackerIssue } from "../tracker/types.js";
import type { EventRepository } from "../storage/repositories/events.js";
import { analyzeToolUsage, analyzeFailurePatterns, analyzeTokenWaste } from "../analysis/outcome-analyzer.js";
import { shouldDecompose, decomposeDispatch } from "../planner/decompose-to-issues.js";

interface InlineContext {
  name: string;
  content: string;
}

interface RouteServices {
  pipelineService?: PipelineRunService;
  orchestrator?: Orchestrator;
  runRepo?: RunRepository;
  costRepo?: CostRepository;
  outcomeRepo?: OutcomeRepository;
  analyticsRepo?: AnalyticsRepository;
  budgetConfig?: BudgetConfig;
  eventRepo?: EventRepository;
  authToken?: string;
}

const PENDING_STATUSES = new Set(["pending_approval", "pending_output_approval"]);

function approveRun(runRepo: RunRepository, runId: string): { previousStatus: string } {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!PENDING_STATUSES.has(run.status)) {
    throw new Error(`Cannot act on run ${run.id}: status is ${run.status}, expected pending_approval or pending_output_approval`);
  }
  const previousStatus = run.status;
  if (run.status === "pending_approval") {
    runRepo.updateStatus(runId, { status: "running", approvalAction: "approve" });
    emitRunEvent({ runId, type: "approved", timestamp: new Date().toISOString(), data: { previousStatus } });
  } else {
    runRepo.updateStatus(runId, { status: "completed", completedAt: new Date().toISOString(), approvalAction: "approve" });
    emitRunEvent({ runId, type: "output_approved", timestamp: new Date().toISOString(), data: { previousStatus } });
  }
  return { previousStatus };
}

function rejectRun(runRepo: RunRepository, runId: string, reason?: string): void {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!PENDING_STATUSES.has(run.status)) {
    throw new Error(`Cannot act on run ${run.id}: status is ${run.status}, expected pending_approval or pending_output_approval`);
  }
  const eventType = run.status === "pending_approval" ? "rejected" : "output_rejected";
  runRepo.updateStatus(runId, { status: "rejected", error: reason, approvalAction: "reject" });
  emitRunEvent({ runId, type: eventType, timestamp: new Date().toISOString(), data: { reason } });
}

function requestRevision(runRepo: RunRepository, runId: string, feedback: string): void {
  const run = runRepo.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!PENDING_STATUSES.has(run.status)) {
    throw new Error(`Cannot act on run ${run.id}: status is ${run.status}, expected pending_approval or pending_output_approval`);
  }
  const context = { action: "revision_requested" as const, feedback, requestedAt: new Date().toISOString() };
  runRepo.updateStatus(runId, { status: "running", approvalContext: context, approvalAction: "revision_requested" });
  emitRunEvent({ runId, type: "revision_requested", timestamp: new Date().toISOString(), data: { feedback } });
}

export function registerRoutes(app: FastifyInstance, queue: RunQueue, services: RouteServices = {}): void {
  const pipelineService = services.pipelineService ?? new PipelineRunService();
  const orchestrator = services.orchestrator;
  const runRepo = services.runRepo;
  const costRepo = services.costRepo;
  const outcomeRepo = services.outcomeRepo;
  const analyticsRepo = services.analyticsRepo;
  const budgetConfig = services.budgetConfig;
  const eventRepo = services.eventRepo;
  const authToken = services.authToken;

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
    if (runRepo) {
      return runRepo.list().map((row) => ({
        id: row.id,
        status: row.status,
        workflow: row.workflow,
        task: row.task,
        submittedAt: row.submittedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        summary: row.summary,
      }));
    }
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
    const extras: Record<string, unknown> = {};
    if (costRepo) {
      extras.budget = getBudgetStatus(costRepo, request.params.id, budgetConfig);
    }
    if (runRepo) {
      const summary = runRepo.getSummary(request.params.id);
      if (summary) extras.summary = summary;
    }
    return Object.keys(extras).length > 0 ? { ...run, ...extras } : run;
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

  // --- SSE stream for a run's real-time events (auth via query param) ---
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/api/v1/runs/:id/stream",
    async (request, reply) => {
      if (authToken && request.query.token !== authToken) {
        reply.code(401);
        return { error: { code: "UNAUTHORIZED", message: "Invalid or missing token" } };
      }

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

  // --- Historical events for a run ---
  app.get<{ Params: { id: string }; Querystring: { token?: string; type?: string } }>(
    "/api/v1/runs/:id/events",
    async (request, reply) => {
      if (authToken && request.query.token !== authToken) {
        reply.code(401);
        return { error: { code: "UNAUTHORIZED", message: "Invalid or missing token" } };
      }

      if (!eventRepo) {
        reply.code(503);
        return { error: { code: "NOT_CONFIGURED", message: "Event repository not available" } };
      }

      const runId = request.params.id;
      const type = request.query.type;
      const events = type
        ? eventRepo.findByRunIdAndType(runId, type)
        : eventRepo.findByRunId(runId);
      return events;
    },
  );

  // --- Run Summary API ---
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/summary", async (request, reply) => {
    if (!runRepo) {
      reply.code(503);
      return { error: { code: "NOT_CONFIGURED", message: "Run repository not available" } };
    }

    const summary = runRepo.getSummary(request.params.id);
    if (!summary) {
      reply.code(404);
      return { error: { code: "NOT_FOUND", message: "Summary not found" } };
    }
    return summary;
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

  // --- Generic Dispatch API ---

  app.post<{
    Body: {
      title: string;
      description?: string;
      repo?: string;
      priority?: string;
      labels?: string[];
    };
  }>("/api/v1/dispatch", async (request, reply) => {
    if (!orchestrator || !orchestrator.isRunning()) {
      reply.code(503);
      return orchError503;
    }

    const body = request.body ?? {};
    const { title, description, repo, priority, labels } = body as {
      title?: string;
      description?: string;
      repo?: string;
      priority?: string;
      labels?: string[];
    };

    if (!title || typeof title !== "string") {
      reply.code(400);
      return { error: { code: "BAD_REQUEST", message: "title is required" } };
    }

    const desc = description ?? "";

    if (shouldDecompose(title, desc)) {
      const { parentIssue, childIssues } = decomposeDispatch(title, desc, {
        repo,
        priority: priority ?? null,
        labels,
      });

      for (const child of childIssues) {
        void orchestrator.dispatchIssue(child);
      }

      reply.code(202);
      return {
        status: "decomposed",
        parentIssue: parentIssue.identifier,
        childIssues: childIssues.map((c) => c.identifier),
      };
    }

    const now = new Date().toISOString();
    const syntheticId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const issue: TrackerIssue = {
      id: syntheticId,
      identifier: syntheticId,
      title,
      description: desc,
      state: "open",
      priority: priority ?? null,
      labels: labels ?? [],
      assignees: [],
      url: "",
      created_at: now,
      updated_at: now,
      blocked_by: [],
      metadata: { source: "dispatch", ...(repo ? { repo } : {}) },
    };

    void orchestrator.dispatchIssue(issue);

    reply.code(202);
    return { id: syntheticId, status: "dispatched" };
  });

  // --- Analytics API ---

  app.get("/api/v1/analytics/tool-usage", async (_request, reply) => {
    if (!outcomeRepo) {
      reply.code(503);
      return { error: { code: "NOT_CONFIGURED", message: "Outcome repository not available" } };
    }
    return analyzeToolUsage(outcomeRepo.findAll());
  });

  app.get("/api/v1/analytics/failure-patterns", async (_request, reply) => {
    if (!outcomeRepo) {
      reply.code(503);
      return { error: { code: "NOT_CONFIGURED", message: "Outcome repository not available" } };
    }
    return analyzeFailurePatterns(outcomeRepo.findAll());
  });

  app.get("/api/v1/analytics/token-waste", async (_request, reply) => {
    if (!outcomeRepo || !costRepo) {
      reply.code(503);
      return { error: { code: "NOT_CONFIGURED", message: "Outcome or cost repository not available" } };
    }
    const outcomes = outcomeRepo.findAll();
    const costsByRunId = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>();
    for (const row of outcomes) {
      const summary = costRepo.sumByRunId(row.id);
      if (summary.recordCount > 0) {
        costsByRunId.set(row.id, {
          inputTokens: summary.totalInputTokens,
          outputTokens: summary.totalOutputTokens,
          costUsd: summary.totalCostUsd,
        });
      }
    }
    return analyzeTokenWaste(outcomes, costsByRunId);
  });

  // --- Human review result ---
  const VALID_HUMAN_REVIEW_RESULTS = new Set(["rubber_stamp", "minor_changes", "major_rework", "rejected"]);

  app.patch<{ Params: { id: string }; Body: { human_review_result: string; human_review_comments?: number } }>(
    "/outcomes/:id/review",
    async (request, reply) => {
      if (!outcomeRepo) {
        reply.code(503);
        return { error: { code: "SERVICE_UNAVAILABLE", message: "Outcome repository not available" } };
      }

      const { id } = request.params;
      const { human_review_result, human_review_comments } = request.body;

      if (!human_review_result || !VALID_HUMAN_REVIEW_RESULTS.has(human_review_result)) {
        reply.code(400);
        return {
          error: {
            code: "INVALID_INPUT",
            message: `human_review_result must be one of: ${[...VALID_HUMAN_REVIEW_RESULTS].join(", ")}`,
          },
        };
      }

      const existing = outcomeRepo.findById(id);
      if (!existing) {
        reply.code(404);
        return { error: { code: "NOT_FOUND", message: `Outcome ${id} not found` } };
      }

      outcomeRepo.update(id, {
        humanReviewResult: human_review_result,
        ...(human_review_comments !== undefined ? { humanReviewComments: human_review_comments } : {}),
      });

      return { status: "updated", id, human_review_result };
    },
  );

  // --- Analytics API ---

  const analyticsError503 = { error: { code: "NOT_CONFIGURED", message: "Analytics repository not available" } };

  function resolveAnalyticsSince(since?: string): string {
    if (since) return since;
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  app.get<{ Querystring: { since?: string } }>(
    "/api/v1/analytics/summary",
    async (request, reply) => {
      if (!analyticsRepo) {
        reply.code(503);
        return analyticsError503;
      }

      const since = resolveAnalyticsSince(request.query.since);
      return analyticsRepo.getSummary(since);
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/api/v1/analytics/cost-trend",
    async (request, reply) => {
      if (!analyticsRepo) {
        reply.code(503);
        return analyticsError503;
      }

      const since = resolveAnalyticsSince(request.query.since);
      return analyticsRepo.getCostTrend(since);
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/api/v1/analytics/failure-hotspots",
    async (request, reply) => {
      if (!analyticsRepo) {
        reply.code(503);
        return analyticsError503;
      }

      const since = resolveAnalyticsSince(request.query.since);
      return analyticsRepo.getFailureHotspots(since);
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/api/v1/metrics",
    async (request, reply) => {
      if (!analyticsRepo) {
        reply.code(503);
        return analyticsError503;
      }

      const since = resolveAnalyticsSince(request.query.since);
      return analyticsRepo.getFullMetrics(since);
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
        const { existsSync, writeFileSync } = await import("node:fs");
        const { join: pathJoin } = await import("node:path");
        const os = await import("node:os");

        const wsRoot = pathJoin(os.homedir(), ".forgectl", "workspaces");
        const wsPath = pathJoin(wsRoot, workspace);

        if (!existsSync(wsPath)) {
          reply.code(404);
          return { error: `Workspace "${workspace}" not found` };
        }

        const content = generateClaudeMd(wsPath, workspace);
        writeFileSync(pathJoin(wsPath, "CLAUDE.md"), content);
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
