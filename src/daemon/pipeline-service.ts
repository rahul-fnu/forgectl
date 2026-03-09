import { EventEmitter } from "node:events";
import { validateDAG } from "../pipeline/dag.js";
import { PipelineExecutor } from "../pipeline/executor.js";
import type { NodeExecution, PipelineDefinition, PipelineRun } from "../pipeline/types.js";
import type { PipelineRepository } from "../storage/repositories/pipelines.js";

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
  private activeRuns = new Map<string, PipelineRunEntry>();
  private repo: PipelineRepository | null;

  constructor(repo?: PipelineRepository) {
    super();
    this.repo = repo ?? null;
  }

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

    const createdAt = new Date().toISOString();

    // Persist to database if repository is available
    if (this.repo) {
      this.repo.insert({
        id: executor.runId,
        pipelineDefinition: pipelineDef,
        status: "running",
        nodeStates: Object.fromEntries(executor.getNodeStates()),
        startedAt: createdAt,
      });
    }

    const entry: PipelineRunEntry = {
      pipeline: pipelineDef,
      executor,
      result: undefined,
      createdAt,
      promise: Promise.resolve().then(async () => {
        try {
          const result = await executor.execute();
          entry.result = result;
          // Persist completion
          if (this.repo) {
            this.repo.updateStatus(executor.runId, {
              status: result.status,
              completedAt: result.completedAt,
            });
            this.repo.updateNodeStates(
              executor.runId,
              Object.fromEntries(
                [...executor.getNodeStates()].map(([k, v]) => [k, { ...v }])
              ),
            );
          }
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
          // Persist failure
          if (this.repo) {
            this.repo.updateStatus(executor.runId, {
              status: "failed",
              completedAt: failed.completedAt,
            });
            this.repo.updateNodeStates(
              executor.runId,
              Object.fromEntries(
                [...executor.getNodeStates()].map(([k, v]) => [k, { ...v }])
              ),
            );
          }
          this.emit("run-completed", {
            runId: executor.runId,
            result: failed,
            pipeline: pipelineDef,
            error: err instanceof Error ? err.message : String(err),
          });
          return failed;
        } finally {
          // Keep entry in activeRuns for in-process lookups (e.g., rerun).
          // Persisted data in repo survives daemon restarts.
        }
      }),
    };

    this.activeRuns.set(executor.runId, entry);

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
    // Check active runs first, then fall back to repository
    const entry = this.activeRuns.get(baseRunId);
    let pipeline: PipelineDefinition | undefined;

    if (entry) {
      pipeline = entry.pipeline;
    } else if (this.repo) {
      const persisted = this.repo.findById(baseRunId);
      if (persisted) {
        pipeline = persisted.pipelineDefinition as PipelineDefinition;
      }
    }

    if (!pipeline) {
      throw new Error("Pipeline run not found");
    }

    const nodeIds = new Set(pipeline.nodes.map((node) => node.id));
    if (!nodeIds.has(options.fromNode)) {
      throw new Error(`Invalid fromNode: ${options.fromNode}`);
    }

    const submitted = this.submitPipeline(pipeline, {
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
    // Start with active in-memory runs
    const result = new Map<string, ReturnType<typeof this.listRuns>[number]>();

    for (const [id, entry] of this.activeRuns.entries()) {
      result.set(id, {
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
      });
    }

    // Merge with persisted runs from repository
    if (this.repo) {
      for (const row of this.repo.list()) {
        if (!result.has(row.id)) {
          const def = row.pipelineDefinition as PipelineDefinition;
          result.set(row.id, {
            id: row.id,
            status: row.status as PipelineRun["status"],
            pipeline: {
              name: def.name,
              description: def.description,
              nodes: def.nodes.map((node) => ({
                id: node.id,
                depends_on: node.depends_on ?? [],
                workflow: node.workflow ?? def.defaults?.workflow ?? "code",
              })),
            },
            startedAt: row.startedAt,
            completedAt: row.completedAt ?? undefined,
          });
        }
      }
    }

    return [...result.values()];
  }

  getRun(id: string): {
    id: string;
    status: PipelineRun["status"] | "running";
    pipeline: PipelineDefinition;
    nodes: Record<string, NodeExecution>;
    startedAt: string;
    completedAt?: string;
  } | null {
    // Check active runs first for live executor data
    const entry = this.activeRuns.get(id);
    if (entry) {
      return {
        id,
        status: entry.result?.status ?? "running",
        pipeline: entry.result?.pipeline ?? entry.pipeline,
        nodes: serializeNodeStates(entry.executor.getNodeStates(), true),
        startedAt: entry.result?.startedAt ?? entry.createdAt,
        completedAt: entry.result?.completedAt,
      };
    }

    // Fall back to persisted data
    if (this.repo) {
      const row = this.repo.findById(id);
      if (row) {
        return {
          id: row.id,
          status: row.status as PipelineRun["status"],
          pipeline: row.pipelineDefinition as PipelineDefinition,
          nodes: (row.nodeStates as Record<string, NodeExecution>) ?? {},
          startedAt: row.startedAt,
          completedAt: row.completedAt ?? undefined,
        };
      }
    }

    return null;
  }

  async waitFor(runId: string): Promise<PipelineRun> {
    const entry = this.activeRuns.get(runId);
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
