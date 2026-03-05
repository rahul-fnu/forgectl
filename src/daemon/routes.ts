import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { RunQueue } from "./queue.js";
import { runEvents } from "../logging/events.js";
import type { RunEvent } from "../logging/events.js";
import { getClaudeAuth } from "../auth/claude.js";
import { getCodexAuth } from "../auth/codex.js";
import { validateDAG } from "../pipeline/dag.js";
import { PipelineExecutor } from "../pipeline/executor.js";
import type { PipelineDefinition, PipelineRun, NodeExecution } from "../pipeline/types.js";

interface InlineContext {
  name: string;
  content: string;
}

interface PipelineRunEntry {
  pipeline: PipelineDefinition;
  executor: PipelineExecutor;
  result?: PipelineRun;
  promise?: Promise<PipelineRun>;
  createdAt: string;
}

export function registerRoutes(app: FastifyInstance, queue: RunQueue): void {
  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

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

  // --- Pipeline API ---
  const pipelineRuns = new Map<string, PipelineRunEntry>();

  // Submit a pipeline
  app.post<{
    Body: {
      pipeline: PipelineDefinition;
      repo?: string;
      fromNode?: string;
      dryRun?: boolean;
      verbose?: boolean;
    };
  }>("/pipelines", async (request, reply) => {
    const {
      pipeline: pipelineDef,
      repo,
      fromNode,
      dryRun,
      verbose,
    } = request.body;
    if (!pipelineDef) {
      reply.code(400);
      return { error: "pipeline is required" };
    }

    // Validate
    const validation = validateDAG(pipelineDef);
    if (!validation.valid) {
      reply.code(400);
      return { error: "Invalid pipeline", details: validation.errors };
    }

    const executor = new PipelineExecutor(pipelineDef, { repo, fromNode, dryRun, verbose });
    const entry: PipelineRunEntry = {
      pipeline: pipelineDef,
      executor,
      result: undefined,
      promise: undefined,
      createdAt: new Date().toISOString(),
    };

    entry.promise = executor.execute().then(result => {
      entry.result = result;
      return result;
    }).catch(() => {
      const failedResult: PipelineRun = {
        id: executor.runId,
        pipeline: pipelineDef,
        status: "failed",
        nodes: executor.getNodeStates(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      entry.result = failedResult;
      return failedResult;
    });

    pipelineRuns.set(executor.runId, entry);

    reply.code(202);
    return {
      id: executor.runId,
      status: "running",
      nodes: serializeNodeStates(executor.getNodeStates(), false),
    };
  });

  // List pipeline runs
  app.get("/pipelines", async () => {
    return [...pipelineRuns.entries()].map(([id, entry]) => ({
      id,
      status: entry.result?.status ?? "running",
      pipeline: {
        name: entry.pipeline.name,
        description: entry.pipeline.description,
        nodes: entry.pipeline.nodes.map(node => ({
          id: node.id,
          depends_on: node.depends_on ?? [],
          workflow: node.workflow ?? entry.pipeline.defaults?.workflow ?? "code",
        })),
      },
      startedAt: entry.result?.startedAt ?? entry.createdAt,
      completedAt: entry.result?.completedAt,
    }));
  });

  // Get pipeline run status
  app.get<{ Params: { id: string } }>("/pipelines/:id", async (request, reply) => {
    const entry = pipelineRuns.get(request.params.id);
    if (!entry) {
      reply.code(404);
      return { error: "Pipeline run not found" };
    }

    return {
      id: request.params.id,
      status: entry.result?.status ?? "running",
      pipeline: entry.result?.pipeline ?? entry.pipeline,
      nodes: serializeNodeStates(entry.executor.getNodeStates(), true),
      startedAt: entry.result?.startedAt ?? entry.createdAt,
      completedAt: entry.result?.completedAt,
    };
  });

  // Pipeline SSE events
  app.get<{ Params: { id: string } }>("/pipelines/:id/events", async (request, reply) => {
    const entry = pipelineRuns.get(request.params.id);
    if (!entry) {
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
    const entry = pipelineRuns.get(request.params.id);
    if (!entry) {
      reply.code(404);
      return { error: "Pipeline run not found" };
    }

    const { fromNode } = request.body;
    if (!fromNode) {
      reply.code(400);
      return { error: "fromNode is required" };
    }

    const pipeline = entry.pipeline;
    const nodeIds = new Set(pipeline.nodes.map(n => n.id));
    if (!nodeIds.has(fromNode)) {
      reply.code(400);
      return { error: `Invalid fromNode: ${fromNode}` };
    }

    const checkpointSourceRunId = request.body.checkpointRunId ?? request.params.id;
    const newExecutor = new PipelineExecutor(pipeline, {
      fromNode,
      repo: request.body.repo,
      verbose: request.body.verbose,
      checkpointSourceRunId,
    });
    const newEntry: PipelineRunEntry = {
      pipeline,
      executor: newExecutor,
      result: undefined,
      promise: undefined,
      createdAt: new Date().toISOString(),
    };

    newEntry.promise = newExecutor.execute().then(result => {
      newEntry.result = result;
      return result;
    });

    pipelineRuns.set(newExecutor.runId, newEntry);

    reply.code(202);
    return { id: newExecutor.runId, status: "running" };
  });
}

function serializeNodeStates(
  states: Map<string, NodeExecution>,
  includeResults: boolean,
): Record<string, NodeExecution> {
  const obj: Record<string, NodeExecution> = {};
  for (const [key, value] of states) {
    obj[key] = includeResults ? { ...value } : { ...value, result: undefined };
  }
  return obj;
}
