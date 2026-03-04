import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import chalk from "chalk";
import type {
  PipelineDefinition,
  PipelineNode,
  PipelineRun,
  NodeExecution,
} from "./types.js";
import { validateDAG, topologicalSort } from "./dag.js";
import { resolveNodeInput } from "./resolver.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import { emitRunEvent } from "../logging/events.js";
import { saveCheckpoint } from "./checkpoint.js";

export interface PipelineExecutorOptions {
  maxParallel?: number;
  fromNode?: string;
  verbose?: boolean;
  dryRun?: boolean;
  repo?: string;
}

export class PipelineExecutor {
  private pipeline: PipelineDefinition;
  private options: PipelineExecutorOptions;
  private nodeStates: Map<string, NodeExecution>;
  private pipelineRunId: string;

  constructor(pipeline: PipelineDefinition, options?: PipelineExecutorOptions) {
    this.pipeline = pipeline;
    this.options = options ?? {};
    this.nodeStates = new Map();
    this.pipelineRunId = `pipe-${randomBytes(4).toString("hex")}`;

    // Initialize node states
    for (const node of pipeline.nodes) {
      this.nodeStates.set(node.id, {
        nodeId: node.id,
        status: "pending",
      });
    }
  }

  get runId(): string {
    return this.pipelineRunId;
  }

  async execute(): Promise<PipelineRun> {
    // Validate DAG
    const validation = validateDAG(this.pipeline);
    if (!validation.valid) {
      throw new Error(`Invalid pipeline DAG:\n${validation.errors.join("\n")}`);
    }

    const startedAt = new Date().toISOString();

    // Dry run: just show the execution plan
    if (this.options.dryRun) {
      return this.buildDryRunResult(startedAt);
    }

    // Get execution order
    const order = topologicalSort(this.pipeline);
    const nodeMap = new Map(this.pipeline.nodes.map(n => [n.id, n]));

    // Track in-flight promises
    const inFlight = new Map<string, Promise<void>>();
    const maxParallel = this.options.maxParallel ?? 3;

    // Determine nodes to skip when resuming from a node
    const skipNodes = new Set<string>();
    if (this.options.fromNode) {
      for (const nodeId of order) {
        if (nodeId === this.options.fromNode) break;
        skipNodes.add(nodeId);
      }
    }

    let pipelineStatus: "running" | "completed" | "failed" = "running";

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId)!;

      // Skip upstream nodes when resuming
      if (skipNodes.has(nodeId)) {
        this.nodeStates.set(nodeId, {
          nodeId,
          status: "skipped",
        });
        continue;
      }

      // Wait for dependencies to complete
      const deps = node.depends_on ?? [];
      for (const dep of deps) {
        const depPromise = inFlight.get(dep);
        if (depPromise) {
          await depPromise;
        }
      }

      // Check if any dependency failed
      if (this.anyDependencyFailed(deps)) {
        this.nodeStates.set(nodeId, {
          nodeId,
          status: "skipped",
          error: "Upstream dependency failed",
        });
        continue;
      }

      // Respect max parallel limit
      while (inFlight.size >= maxParallel) {
        await Promise.race(inFlight.values());
      }

      // Execute the node
      const promise = this.executeNode(node).then(() => {
        inFlight.delete(nodeId);
      });
      inFlight.set(nodeId, promise);
    }

    // Wait for all remaining in-flight nodes
    await Promise.all(inFlight.values());

    // Determine overall status
    const allStatuses = [...this.nodeStates.values()].map(s => s.status);
    if (allStatuses.some(s => s === "failed")) {
      pipelineStatus = "failed";
    } else if (allStatuses.every(s => s === "completed" || s === "skipped")) {
      pipelineStatus = "completed";
    }

    return {
      id: this.pipelineRunId,
      pipeline: this.pipeline,
      status: pipelineStatus,
      nodes: new Map(this.nodeStates),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async executeNode(node: PipelineNode): Promise<void> {
    const state: NodeExecution = {
      nodeId: node.id,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.nodeStates.set(node.id, state);

    emitRunEvent({
      runId: this.pipelineRunId,
      type: "phase",
      timestamp: new Date().toISOString(),
      data: { phase: `node:${node.id}:started` },
    });

    console.log(chalk.blue(`  ▶ Starting node: ${node.id}`));

    try {
      // Resolve input from upstream outputs
      const input = await resolveNodeInput(node, this.pipeline, this.nodeStates);

      // Build CLIOptions from node + pipeline defaults
      const cliOptions: CLIOptions = {
        task: node.task,
        workflow: node.workflow ?? this.pipeline.defaults?.workflow ?? "code",
        agent: node.agent ?? this.pipeline.defaults?.agent ?? "codex",
        repo: this.options.repo ?? input.repo ?? node.repo ?? this.pipeline.defaults?.repo,
        input: input.files ?? node.input,
        context: input.contextFiles ?? node.context,
        review: node.review ?? this.pipeline.defaults?.review ?? false,
        model: node.model ?? this.pipeline.defaults?.model,
        verbose: this.options.verbose,
      };

      // Use the existing forgectl execution engine
      const config = loadConfig();
      const plan = resolveRunPlan(config, cliOptions);
      const logger = new Logger(this.options.verbose ?? false);
      const result = await executeRun(plan, logger);

      // Save checkpoint on success
      if (result.success) {
        const checkpoint = await saveCheckpoint(this.pipelineRunId, node.id, result);
        state.checkpoint = checkpoint;

        // For git-mode output, merge the branch back into the host repo's current branch
        // so downstream nodes see the changes when their workspace is created
        if (result.output?.mode === "git" && result.output.branch) {
          const repoPath = this.options.repo ?? node.repo ?? this.pipeline.defaults?.repo;
          if (repoPath) {
            try {
              execSync(`git merge ${result.output.branch} --no-edit`, { cwd: repoPath, stdio: "pipe" });
              console.log(chalk.gray(`    Merged ${result.output.branch} into working branch`));
            } catch (mergeErr) {
              console.log(chalk.yellow(`    Warning: Could not auto-merge ${result.output.branch}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`));
            }
          }
        }
      }

      state.runId = plan.runId;
      state.status = result.success ? "completed" : "failed";
      state.result = result;
      state.completedAt = new Date().toISOString();

      if (result.success) {
        console.log(chalk.green(`  ✔ Node completed: ${node.id}`));
      } else {
        console.log(chalk.red(`  ✗ Node failed: ${node.id}${result.error ? ` — ${result.error}` : ""}`));
      }
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      console.log(chalk.red(`  ✗ Node error: ${node.id} — ${state.error}`));
    }

    this.nodeStates.set(node.id, state);
  }

  private anyDependencyFailed(deps: string[]): boolean {
    return deps.some(dep => {
      const state = this.nodeStates.get(dep);
      return state?.status === "failed";
    });
  }

  private buildDryRunResult(startedAt: string): PipelineRun {
    const order = topologicalSort(this.pipeline);
    const nodeMap = new Map(this.pipeline.nodes.map(n => [n.id, n]));

    console.log(chalk.bold(`\n📋 Pipeline: ${this.pipeline.name} (dry run)\n`));
    if (this.pipeline.description) {
      console.log(chalk.gray(`  ${this.pipeline.description}\n`));
    }

    console.log(chalk.gray(`  Execution order:`));
    for (let i = 0; i < order.length; i++) {
      const nodeId = order[i];
      const node = nodeMap.get(nodeId)!;
      const workflow = node.workflow ?? this.pipeline.defaults?.workflow ?? "code";
      const agent = node.agent ?? this.pipeline.defaults?.agent ?? "codex";
      const deps = node.depends_on?.join(", ") ?? "(root)";
      console.log(chalk.gray(`    ${i + 1}. ${nodeId} [${workflow}/${agent}] depends: ${deps}`));
      console.log(chalk.gray(`       Task: ${node.task.slice(0, 80)}${node.task.length > 80 ? "..." : ""}`));
    }
    console.log();

    return {
      id: this.pipelineRunId,
      pipeline: this.pipeline,
      status: "completed",
      nodes: this.nodeStates,
      startedAt,
      completedAt: startedAt,
    };
  }

  /** Get current node states (for status queries) */
  getNodeStates(): Map<string, NodeExecution> {
    return new Map(this.nodeStates);
  }
}
