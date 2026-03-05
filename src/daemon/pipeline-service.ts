import { EventEmitter } from "node:events";
import { validateDAG } from "../pipeline/dag.js";
import { PipelineExecutor } from "../pipeline/executor.js";
import type { NodeExecution, PipelineDefinition, PipelineRun } from "../pipeline/types.js";

interface PipelineRunEntry {
  pipeline: PipelineDefinition;
  executor: PipelineExecutor;
  result?: PipelineRun;
  promise: Promise<PipelineRun>;
  createdAt: string;
}

export interface SubmitPipelineOptions {
  repo?: string;
  fromNode?: string;
  dryRun?: boolean;
  verbose?: boolean;
  checkpointSourceRunId?: string;
}

export class PipelineValidationError extends Error {
  details: string[];

  constructor(message: string, details: string[]) {
    super(message);
    this.name = "PipelineValidationError";
    this.details = details;
  }
}

export class PipelineRunService extends EventEmitter {
  private runs = new Map<string, PipelineRunEntry>();

  submitPipeline(pipelineDef: PipelineDefinition, options: SubmitPipelineOptions = {}): {
    id: string;
    status: "running";
    nodes: Record<string, NodeExecution>;
  } {
    const validation = validateDAG(pipelineDef);
    if (!validation.valid) {
      throw new PipelineValidationError("Invalid pipeline", validation.errors);
    }

    const executor = new PipelineExecutor(pipelineDef, {
      repo: options.repo,
      fromNode: options.fromNode,
      dryRun: options.dryRun,
      verbose: options.verbose,
      checkpointSourceRunId: options.checkpointSourceRunId,
    });

    const entry: PipelineRunEntry = {
      pipeline: pipelineDef,
      executor,
      result: undefined,
      createdAt: new Date().toISOString(),
      promise: Promise.resolve().then(async () => {
        try {
          const result = await executor.execute();
          entry.result = result;
          this.emit("run-completed", { runId: executor.runId, result, pipeline: pipelineDef });
          return result;
        } catch (err) {
          const failed: PipelineRun = {
            id: executor.runId,
            pipeline: pipelineDef,
            status: "failed",
            nodes: executor.getNodeStates(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
          entry.result = failed;
          this.emit("run-completed", {
            runId: executor.runId,
            result: failed,
            pipeline: pipelineDef,
            error: err instanceof Error ? err.message : String(err),
          });
          return failed;
        }
      }),
    };

    this.runs.set(executor.runId, entry);

    return {
      id: executor.runId,
      status: "running",
      nodes: serializeNodeStates(executor.getNodeStates(), false),
    };
  }

  rerunPipeline(baseRunId: string, options: {
    fromNode: string;
    repo?: string;
    verbose?: boolean;
    checkpointRunId?: string;
  }): { id: string; status: "running" } {
    const entry = this.runs.get(baseRunId);
    if (!entry) {
      throw new Error("Pipeline run not found");
    }

    const nodeIds = new Set(entry.pipeline.nodes.map((node) => node.id));
    if (!nodeIds.has(options.fromNode)) {
      throw new Error(`Invalid fromNode: ${options.fromNode}`);
    }

    const submitted = this.submitPipeline(entry.pipeline, {
      fromNode: options.fromNode,
      repo: options.repo,
      verbose: options.verbose,
      checkpointSourceRunId: options.checkpointRunId ?? baseRunId,
    });

    return { id: submitted.id, status: "running" };
  }

  listRuns(): Array<{
    id: string;
    status: PipelineRun["status"] | "running";
    pipeline: {
      name: string;
      description?: string;
      nodes: Array<{ id: string; depends_on: string[]; workflow: string }>;
    };
    startedAt: string;
    completedAt?: string;
  }> {
    return [...this.runs.entries()].map(([id, entry]) => ({
      id,
      status: entry.result?.status ?? "running",
      pipeline: {
        name: entry.pipeline.name,
        description: entry.pipeline.description,
        nodes: entry.pipeline.nodes.map((node) => ({
          id: node.id,
          depends_on: node.depends_on ?? [],
          workflow: node.workflow ?? entry.pipeline.defaults?.workflow ?? "code",
        })),
      },
      startedAt: entry.result?.startedAt ?? entry.createdAt,
      completedAt: entry.result?.completedAt,
    }));
  }

  getRun(id: string): {
    id: string;
    status: PipelineRun["status"] | "running";
    pipeline: PipelineDefinition;
    nodes: Record<string, NodeExecution>;
    startedAt: string;
    completedAt?: string;
  } | null {
    const entry = this.runs.get(id);
    if (!entry) return null;

    return {
      id,
      status: entry.result?.status ?? "running",
      pipeline: entry.result?.pipeline ?? entry.pipeline,
      nodes: serializeNodeStates(entry.executor.getNodeStates(), true),
      startedAt: entry.result?.startedAt ?? entry.createdAt,
      completedAt: entry.result?.completedAt,
    };
  }

  async waitFor(runId: string): Promise<PipelineRun> {
    const entry = this.runs.get(runId);
    if (!entry) {
      throw new Error(`Pipeline run not found: ${runId}`);
    }
    return entry.promise;
  }
}

function serializeNodeStates(
  states: Map<string, NodeExecution>,
  includeResults: boolean,
): Record<string, NodeExecution> {
  const obj: Record<string, NodeExecution> = {};
  for (const [key, value] of states.entries()) {
    obj[key] = includeResults ? { ...value } : { ...value, result: undefined };
  }
  return obj;
}
