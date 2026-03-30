import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type {
  PipelineDefinition,
  PipelineNode,
  PipelineRun,
  NodeExecution,
  ContextManifestEntry,
  ResolvedContextContent,
  ResolvedFileArtifact,
} from "./types.js";
import { collectAncestors, collectDescendants, validateDAG, topologicalSort, buildDependentsMap } from "./dag.js";
import { evaluateCondition } from "./condition.js";
import { buildHandoffContext, type HandoffEntry } from "../context/prompt.js";
import type { NodeStatusContext } from "./condition.js";
import { getWorkflowOutputMode, resolveNodeInput } from "./resolver.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import { emitRunEvent } from "../logging/events.js";
import { loadCheckpoint, saveCheckpoint, saveLoopCheckpoint, loadLoopCheckpoint, GLOBAL_MAX_ITERATIONS } from "./checkpoint.js";
import type { LoopIterationRecord } from "./types.js";
import type { OutputResult } from "../output/types.js";
import { extractCoverage } from "./coverage.js";
import { checkExclusionViolations } from "./exclusion.js";

export interface PipelineExecutorOptions {
  maxParallel?: number;
  fromNode?: string;
  checkpointSourceRunId?: string;
  verbose?: boolean;
  dryRun?: boolean;
  repo?: string;
}

interface RerunSelection {
  executeNodes: Set<string>;
  hydratedNodes: Set<string>;
  skippedNodes: Set<string>;
}

interface FanInContext {
  repoPath: string;
  tempBranch: string;
  originalRef: string;
  originalSha: string;
}

export class PipelineExecutor {
  private static repoLocks = new Map<string, Promise<void>>();
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
    const selection = await this.prepareRerunSelection(order);

    for (const nodeId of selection.hydratedNodes) {
      await this.hydrateNodeFromCheckpoint(nodeId);
    }

    for (const nodeId of selection.skippedNodes) {
      this.nodeStates.set(nodeId, {
        nodeId,
        status: "skipped",
        skipReason: this.options.fromNode
          ? `Skipped for rerun from ${this.options.fromNode}: not required`
          : "Skipped",
      });
    }

    // Build dependents map for ready-queue logic
    const dependentsMap = buildDependentsMap(this.pipeline);
    const maxParallel = this.options.maxParallel ?? 3;

    // Use a mutable object so TypeScript doesn't narrow the type when processNode
    // sets pipeline_state.status inside an async closure
    const pipeline_state = { status: "running" as "running" | "completed" | "failed" };

    // Track in-flight promises
    const inFlight = new Map<string, Promise<void>>();

    // Helpers
    const isTerminal = (status: string) =>
      status === "completed" || status === "failed" || status === "skipped";

    const isNodeReady = (nodeId: string): boolean => {
      const state = this.nodeStates.get(nodeId);
      if (!state) return false;
      if (!selection.executeNodes.has(nodeId)) return false;
      if (isTerminal(state.status)) return false;
      if (inFlight.has(nodeId)) return false;
      const node = nodeMap.get(nodeId)!;
      return (node.depends_on ?? []).every(dep => {
        const depState = this.nodeStates.get(dep);
        return depState && isTerminal(depState.status);
      });
    };

    const buildStatusContext = (deps: string[]): NodeStatusContext => {
      const ctx: NodeStatusContext = {};
      for (const dep of deps) {
        const depState = this.nodeStates.get(dep);
        if (depState) {
          ctx[dep] = depState.status as "completed" | "failed" | "skipped";
        }
      }
      return ctx;
    };

    const propagateCascadeSkip = (skippedId: string): void => {
      const stack = [skippedId];
      while (stack.length > 0) {
        const currentId = stack.pop()!;
        for (const dependentId of dependentsMap.get(currentId) ?? []) {
          if (!selection.executeNodes.has(dependentId)) continue;
          const depState = this.nodeStates.get(dependentId);
          if (!depState || isTerminal(depState.status)) continue;
          // Check if this dependent would be activated as else_node — do not cascade-skip else_nodes
          const parentNode = nodeMap.get(currentId);
          if (parentNode?.else_node === dependentId) continue;
          this.nodeStates.set(dependentId, {
            nodeId: dependentId,
            status: "skipped",
            skipReason: `dependency ${currentId} was skipped`,
          });
          stack.push(dependentId);
        }
      }
    };

    // Check if a dependency's terminal state blocks the node from executing.
    // Returns a skip reason string if blocked, or null if all deps are OK.
    const getDependencyBlockReason = (deps: string[]): string | null => {
      for (const dep of deps) {
        const state = this.nodeStates.get(dep);
        if (!state) continue;
        if (state.status === "failed") {
          return `dependency ${dep} was skipped`;
        }
        if (state.status === "skipped") {
          // Hydrated checkpoints have result.success + result.output — they are OK
          const hydratedSuccess = Boolean(state.result?.success && state.result.output);
          if (!hydratedSuccess) {
            return `dependency ${dep} was skipped`;
          }
        }
      }
      return null;
    };

    const processNode = async (nodeId: string): Promise<void> => {
      const node = nodeMap.get(nodeId)!;
      const deps = node.depends_on ?? [];

      // Check for blocking dependency issues (failed or non-hydrated skipped deps)
      const blockReason = getDependencyBlockReason(deps);
      if (blockReason !== null) {
        this.nodeStates.set(nodeId, {
          nodeId,
          status: "skipped",
          skipReason: blockReason,
        });
        propagateCascadeSkip(nodeId);
        return;
      }

      // Evaluate condition if present
      if (node.condition !== undefined) {
        const ctx = buildStatusContext(deps);
        let condResult: boolean;
        try {
          condResult = evaluateCondition(node.condition, ctx);
        } catch (err) {
          // Fatal condition error — fail the pipeline immediately
          const errMsg = err instanceof Error ? err.message : String(err);
          this.nodeStates.set(nodeId, {
            nodeId,
            status: "failed",
            error: errMsg,
          });
          pipeline_state.status = "failed";
          return;
        }

        if (!condResult) {
          // Condition is false — skip this node
          const skipReason = `condition false: ${node.condition}`;
          this.nodeStates.set(nodeId, {
            nodeId,
            status: "skipped",
            skipReason,
          });

          if (node.else_node) {
            // Activate else_node if all its deps are terminal and it's in executeNodes
            const elseNode = nodeMap.get(node.else_node);
            if (elseNode && selection.executeNodes.has(node.else_node)) {
              const elseState = this.nodeStates.get(node.else_node);
              if (elseState && !isTerminal(elseState.status) && !inFlight.has(node.else_node)) {
                const elseDeps = elseNode.depends_on ?? [];
                const elseReady = elseDeps.every(dep => {
                  const depState = this.nodeStates.get(dep);
                  return depState && isTerminal(depState.status);
                });
                if (elseReady) {
                  readyQueue.add(node.else_node);
                }
              }
            }
          } else {
            // Cascade-skip all downstream dependents
            propagateCascadeSkip(nodeId);
          }

          return;
        }
      }

      // Loop node: delegate to executeLoopNode
      if (node.loop !== undefined) {
        await this.executeLoopNode(node, buildStatusContext(deps));
        // Enqueue newly-ready dependents (same as after executeNode)
        for (const dependentId of dependentsMap.get(nodeId) ?? []) {
          if (isNodeReady(dependentId)) {
            readyQueue.add(dependentId);
          }
        }
        return;
      }

      // Execute the node
      await this.executeNode(node);

      // Enqueue newly-ready dependents
      for (const dependentId of dependentsMap.get(nodeId) ?? []) {
        if (isNodeReady(dependentId)) {
          readyQueue.add(dependentId);
        }
      }
    };

    // Seed the ready queue: all nodes in executeNodes whose deps are already terminal
    // (handles root nodes AND nodes whose ancestors were hydrated from checkpoints)
    const readyQueue = new Set<string>();
    for (const nodeId of order) {
      if (isNodeReady(nodeId)) {
        readyQueue.add(nodeId);
      }
    }

    // Drain loop
    while (readyQueue.size > 0 || inFlight.size > 0) {
      for (const nodeId of [...readyQueue]) {
        if (inFlight.size >= maxParallel) break;
        readyQueue.delete(nodeId);
        // Wrap processNode so inFlight cleanup happens AFTER the promise is stored
        const promise = processNode(nodeId).then(() => {
          inFlight.delete(nodeId);
        });
        inFlight.set(nodeId, promise);
      }
      if (inFlight.size > 0) await Promise.race(inFlight.values());
      // If pipeline failed due to fatal condition error, stop processing
      if (pipeline_state.status === "failed") break;
    }

    // Wait for any remaining in-flight nodes (if we broke early due to failure)
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight.values());
    }

    // Determine overall status
    const allStatuses = [...this.nodeStates.values()].map(s => s.status);
    if (allStatuses.some(s => s === "failed")) {
      pipeline_state.status = "failed";
    } else if (allStatuses.every(s => s === "completed" || s === "skipped")) {
      pipeline_state.status = "completed";
    }

    emitRunEvent({
      runId: this.pipelineRunId,
      type: pipeline_state.status === "completed" ? "completed" : "failed",
      timestamp: new Date().toISOString(),
      data: {
        status: pipeline_state.status,
        completed: allStatuses.filter(s => s === "completed").length,
        failed: allStatuses.filter(s => s === "failed").length,
        skipped: allStatuses.filter(s => s === "skipped").length,
      },
    });

    return {
      id: this.pipelineRunId,
      pipeline: this.pipeline,
      status: pipeline_state.status,
      nodes: new Map(this.nodeStates),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async prepareRerunSelection(order: string[]): Promise<RerunSelection> {
    const executeNodes = new Set<string>();
    const hydratedNodes = new Set<string>();
    const skippedNodes = new Set<string>();

    if (!this.options.fromNode) {
      for (const nodeId of order) executeNodes.add(nodeId);
      return { executeNodes, hydratedNodes, skippedNodes };
    }

    const fromNode = this.options.fromNode;
    if (!order.includes(fromNode)) {
      throw new Error(`Node "${fromNode}" not found in pipeline`);
    }

    const executeFrontier = new Set<string>([fromNode, ...collectDescendants(this.pipeline, fromNode)]);
    for (const nodeId of executeFrontier) {
      executeNodes.add(nodeId);
      for (const ancestor of collectAncestors(this.pipeline, nodeId)) {
        executeNodes.add(ancestor);
      }
    }

    // Checkpoint-backed rerun skips only the ancestry of fromNode.
    if (this.options.checkpointSourceRunId) {
      const ancestorsOfFrom = collectAncestors(this.pipeline, fromNode);
      for (const ancestor of ancestorsOfFrom) {
        hydratedNodes.add(ancestor);
        executeNodes.delete(ancestor);
      }
    }

    for (const nodeId of order) {
      if (!executeNodes.has(nodeId) && !hydratedNodes.has(nodeId)) {
        skippedNodes.add(nodeId);
      }
    }

    return { executeNodes, hydratedNodes, skippedNodes };
  }

  private async hydrateNodeFromCheckpoint(nodeId: string): Promise<void> {
    const sourceRunId = this.options.checkpointSourceRunId;
    if (!sourceRunId) return;

    const checkpoint = await loadCheckpoint(sourceRunId, nodeId);
    if (!checkpoint) {
      throw new Error(`Missing checkpoint for node "${nodeId}" in run ${sourceRunId}`);
    }

    let output: OutputResult;

    if (checkpoint.branch) {
      output = {
        mode: "git",
        branch: checkpoint.branch,
        sha: checkpoint.commitSha ?? "",
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
    } else {
      throw new Error(`Checkpoint for node "${nodeId}" has no restorable output`);
    }

    this.nodeStates.set(nodeId, {
      nodeId,
      status: "skipped",
      skipReason: `Hydrated from checkpoint run ${sourceRunId}`,
      checkpoint,
      hydratedFromCheckpoint: {
        pipelineRunId: sourceRunId,
        nodeId,
      },
      result: {
        success: true,
        output,
        validation: { passed: true, totalAttempts: 0, stepResults: [] },
        durationMs: 0,
      },
    });
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
      data: { phase: "node:started", nodeId: node.id, status: "running" },
    });

    console.log(chalk.blue(`  ▶ Starting node: ${node.id}`));

    let tempContextDir: string | null = null;
    let tempInputArtifactsDir: string | null = null;
    let fanInContext: FanInContext | null = null;
    let releaseRepoLock: (() => void) | null = null;
    try {
      // Resolve input from upstream outputs
      const input = await resolveNodeInput(node, this.pipeline, this.nodeStates, {
        repo: this.options.repo,
      });

      // For fan-in nodes with multiple git-mode upstream branches,
      // merge all upstream branches into the host repo so the workspace includes all changes
      const deps = node.depends_on ?? [];
      const workflowName = node.workflow ?? this.pipeline.defaults?.workflow ?? "code";
      const workflowOutputMode = getWorkflowOutputMode(workflowName);
      const repoPath = this.options.repo ?? input.repo ?? node.repo ?? this.pipeline.defaults?.repo;
      if (deps.length > 0 && workflowOutputMode === "git") {
        if (repoPath) {
          releaseRepoLock = await this.acquireRepoLock(repoPath);
          fanInContext = this.prepareFanInBranch(node, repoPath);
        }
      }

      const contextFiles = [...input.contextFiles];
      if (input.contextContent.length > 0) {
        const materialized = this.materializeContextContent(node.id, input.contextContent);
        tempContextDir = materialized.dir;
        contextFiles.push(...materialized.files);
      }
      if (input.contextManifestEntries.length > 0) {
        const manifest = this.materializeContextManifest(
          node.id,
          input.contextManifestEntries,
          tempContextDir,
        );
        tempContextDir = manifest.dir;
        contextFiles.push(manifest.file);
      }

      const inputFiles = [...input.files];
      if (input.fileArtifacts.length > 0) {
        const staged = this.stageInputArtifacts(node.id, input.fileArtifacts);
        tempInputArtifactsDir = staged.dir;
        inputFiles.push(staged.dir);
      }

      // Build handoff context from completed dependency nodes
      const handoffEntries = this.collectHandoffEntries(node);
      const handoffContext = buildHandoffContext(handoffEntries);
      const taskWithHandoff = handoffContext
        ? `${handoffContext}\n\n${node.task}`
        : node.task;

      // Build CLIOptions from node + pipeline defaults
      const cliOptions: CLIOptions = {
        task: taskWithHandoff,
        workflow: workflowName,
        agent: node.agent ?? this.pipeline.defaults?.agent ?? "codex",
        repo: repoPath,
        input: inputFiles.length > 0 ? inputFiles : undefined,
        context: contextFiles.length > 0 ? contextFiles : undefined,
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
        if (result.output && result.output.mode === "git" && result.output.branch) {
          const outputBranch = result.output.branch;
          if (repoPath) {
            if (releaseRepoLock) {
              this.mergeOutputBranchIntoHostRepo(repoPath, outputBranch, fanInContext);
            } else {
              await this.withRepoLock(repoPath, async () => {
                this.mergeOutputBranchIntoHostRepo(repoPath, outputBranch, null);
              });
            }
          }
        }
      }

      state.runId = plan.runId;
      state.status = result.success ? "completed" : "failed";
      state.result = result;
      state.completedAt = new Date().toISOString();

      emitRunEvent({
        runId: this.pipelineRunId,
        type: "phase",
        timestamp: new Date().toISOString(),
        data: {
          phase: result.success ? "node:completed" : "node:failed",
          nodeId: node.id,
          status: state.status,
          runId: plan.runId,
          durationMs: result.durationMs,
        },
      });

      if (result.validation) {
        emitRunEvent({
          runId: this.pipelineRunId,
          type: "validation",
          timestamp: new Date().toISOString(),
          data: {
            nodeId: node.id,
            validation: result.validation,
          },
        });
      }
      if (result.output) {
        emitRunEvent({
          runId: this.pipelineRunId,
          type: "output",
          timestamp: new Date().toISOString(),
          data: {
            nodeId: node.id,
            output: result.output,
          },
        });
      }

      if (result.success) {
        console.log(chalk.green(`  ✔ Node completed: ${node.id}`));
      } else {
        console.log(chalk.red(`  ✗ Node failed: ${node.id}${result.error ? ` — ${result.error}` : ""}`));
      }
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      emitRunEvent({
        runId: this.pipelineRunId,
        type: "phase",
        timestamp: new Date().toISOString(),
        data: {
          phase: "node:failed",
          nodeId: node.id,
          status: "failed",
          error: state.error,
        },
      });
      console.log(chalk.red(`  ✗ Node error: ${node.id} — ${state.error}`));
    } finally {
      if (tempContextDir) {
        rmSync(tempContextDir, { recursive: true, force: true });
      }
      if (tempInputArtifactsDir) {
        rmSync(tempInputArtifactsDir, { recursive: true, force: true });
      }
      if (fanInContext) {
        try {
          this.cleanupFanInBranch(fanInContext);
        } catch (err) {
          state.status = "failed";
          state.error = `Failed to restore repo state after fan-in: ${err instanceof Error ? err.message : String(err)}`;
          state.completedAt = new Date().toISOString();
        }
      }
      if (releaseRepoLock) {
        releaseRepoLock();
      }
    }

    this.nodeStates.set(node.id, state);
  }

  private async executeLoopNode(node: PipelineNode, upstreamCtx: Record<string, string>): Promise<void> {
    // a. Safety cap clamping
    const configuredMax = node.loop!.max_iterations ?? 10;
    const maxIterations = Math.min(configuredMax, GLOBAL_MAX_ITERATIONS);
    if (configuredMax > GLOBAL_MAX_ITERATIONS) {
      const logger = new Logger(this.options.verbose ?? false);
      logger.warn("loop", `Loop "${node.id}": max_iterations ${configuredMax} clamped to ${GLOBAL_MAX_ITERATIONS}`);
    }

    // b. Initialize loopState on nodeStates
    const state: NodeExecution = {
      nodeId: node.id,
      status: "loop-iterating",
      startedAt: new Date().toISOString(),
      loopState: {
        currentIteration: 0,
        maxIterations,
        iterations: [],
      },
    };
    this.nodeStates.set(node.id, state);

    // d. Progressive context setup (temp dir for iteration output files)
    const loopTempDir = mkdtempSync(join(tmpdir(), "forgectl-loop-ctx-"));
    const progressiveContext: string[] = [];

    try {
      // c. Crash recovery check (LOOP-05)
      let startIteration = 1;
      if (this.options.checkpointSourceRunId) {
        const lc = loadLoopCheckpoint(this.options.checkpointSourceRunId, node.id);
        if (lc) {
          startIteration = lc.lastCompletedIteration + 1;
          state.loopState!.iterations = lc.loopState.iterations;
          // Reconstruct progressive context file paths from iteration history
          for (const iterRecord of lc.loopState.iterations) {
            const iterFile = join(loopTempDir, `iteration-${String(iterRecord.iteration).padStart(2, "0")}-output.md`);
            // Write a placeholder so the file exists for context passing
            writeFileSync(iterFile, `# Iteration ${iterRecord.iteration} (recovered)\n\nStatus: ${iterRecord.status}\n`);
            progressiveContext.push(iterFile);
          }
        }
      }

      // CORR-02/CORR-05: Load exclude patterns and initialize no-progress hash tracking
      const loopConfig = loadConfig();
      const excludePatterns = loopConfig.repo?.exclude ?? [];
      let lastOutputHash = "";
      let lastIterOutput = "";

      // e. Iteration loop
      for (let i = startIteration; i <= maxIterations; i++) {
        state.loopState!.currentIteration = i;
        const iterStartedAt = new Date().toISOString();

        // Build node clone with progressive context
        const iterationNode: PipelineNode = {
          ...node,
          context: [...(node.context ?? []), ...progressiveContext],
        };

        // Run the iteration body
        await this.executeNode(iterationNode);

        // CORR-02: Test file exclusion enforcement — check before reading iterState
        const repoPath = node.repo ?? this.pipeline.defaults?.repo ?? this.options.repo;
        if (repoPath && excludePatterns.length > 0) {
          const { violations } = checkExclusionViolations(repoPath, excludePatterns);
          if (violations.length > 0) {
            // Mark node failed and exit loop immediately — exclusion violation is terminal
            state.status = "failed";
            state.error = `Fix agent modified excluded file(s): ${violations.join(", ")}`;
            state.completedAt = new Date().toISOString();
            this.nodeStates.set(node.id, state);
            return;
          }
        }

        // Read the result from nodeStates (executeNode updates it)
        const iterState = this.nodeStates.get(node.id)!;
        const iterStatus: "completed" | "failed" = iterState.status === "completed" ? "completed" : "failed";
        const iterCompletedAt = new Date().toISOString();

        // CORR-05: No-progress detection via SHA-256 hash comparison
        const currentOutput = iterState.result?.validation?.lastOutput ?? "";
        const currentHash = currentOutput !== "" ? createHash("sha256").update(currentOutput).digest("hex") : "";

        if (i > startIteration && currentHash !== "" && currentHash === lastOutputHash) {
          state.status = "failed";
          state.error = `Loop "${node.id}" aborted: no progress detected — identical test output on iterations ${i - 1} and ${i}:\n${currentOutput.slice(0, 500)}`;
          state.completedAt = new Date().toISOString();
          this.nodeStates.set(node.id, state);
          return;
        }
        lastOutputHash = currentHash;
        lastIterOutput = currentOutput;

        // IMPORTANT: Reset status back to loop-iterating for next iteration
        state.status = "loop-iterating";
        state.loopState!.currentIteration = i;

        // Record iteration history
        const iterRecord: LoopIterationRecord = {
          iteration: i,
          status: iterStatus,
          startedAt: iterStartedAt,
          completedAt: iterCompletedAt,
        };
        state.loopState!.iterations.push(iterRecord);
        this.nodeStates.set(node.id, state);

        // Write iteration output to progressive context temp dir
        const iterOutputFile = join(loopTempDir, `iteration-${String(i).padStart(2, "0")}-output.md`);
        const iterOutputContent = [
          `# Iteration ${i} Output`,
          ``,
          `**Status:** ${iterStatus}`,
          `**Started:** ${iterStartedAt}`,
          `**Completed:** ${iterCompletedAt}`,
          ``,
        ].join("\n");
        writeFileSync(iterOutputFile, iterOutputContent, "utf-8");
        progressiveContext.push(iterOutputFile);

        // Save per-iteration loop checkpoint
        saveLoopCheckpoint(this.pipelineRunId, node.id, i, state.loopState!);

        // Also save a regular checkpoint for downstream hydration if iteration succeeded
        if (iterStatus === "completed" && iterState.result) {
          const checkpoint = await saveCheckpoint(this.pipelineRunId, node.id, iterState.result);
          state.checkpoint = checkpoint;
        }

        // Evaluate `until` expression
        // CORR-04: Inject _coverage from validation output
        const coverage = extractCoverage(iterState.result?.validation?.lastOutput ?? "");
        const untilCtx = {
          ...upstreamCtx,
          _status: iterStatus,
          _iteration: i,
          _max_iterations: maxIterations,
          _first_iteration: i === 1 ? 1 : 0,
          _coverage: coverage,
        } as unknown as Parameters<typeof evaluateCondition>[1];

        let untilResult: boolean;
        try {
          untilResult = evaluateCondition(node.loop!.until, untilCtx);
        } catch (err) {
          // Fatal until expression error — consistent with COND-06
          state.status = "failed";
          state.error = err instanceof Error ? err.message : String(err);
          state.completedAt = new Date().toISOString();
          this.nodeStates.set(node.id, state);
          return;
        }

        if (untilResult) {
          // Loop completed successfully
          state.status = "completed";
          state.completedAt = new Date().toISOString();
          this.nodeStates.set(node.id, state);
          return;
        }
      }

      // f. Loop exhaustion — until never became true
      state.status = "failed";
      const finalCoverage = extractCoverage(lastIterOutput);
      if (finalCoverage >= 0) {
        state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true (final coverage: ${finalCoverage.toFixed(1)}%)`;
      } else {
        state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;
      }
      state.completedAt = new Date().toISOString();
      this.nodeStates.set(node.id, state);
    } finally {
      // g. Cleanup temp dir
      rmSync(loopTempDir, { recursive: true, force: true });
    }
  }

  private materializeContextContent(
    nodeId: string,
    contextContent: ResolvedContextContent[],
  ): { dir: string; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), `forgectl-pipe-${nodeId}-ctx-`));
    const files: string[] = [];

    for (let i = 0; i < contextContent.length; i++) {
      const item = contextContent[i];
      const safeName = (item.name || `context-${i + 1}.txt`)
        .replace(/[\\/\s]+/g, "_")
        .replace(/[^a-zA-Z0-9._-]/g, "");
      const filePath = join(dir, `${String(i + 1).padStart(2, "0")}-${safeName}`);
      writeFileSync(filePath, item.content, "utf-8");
      files.push(filePath);
    }

    return { dir, files };
  }

  private materializeContextManifest(
    nodeId: string,
    entries: ContextManifestEntry[],
    existingDir?: string | null,
  ): { dir: string; file: string } {
    const dir = existingDir ?? mkdtempSync(join(tmpdir(), `forgectl-pipe-${nodeId}-ctx-`));
    const file = join(dir, "context-manifest.json");
    writeFileSync(file, JSON.stringify({
      generatedAt: new Date().toISOString(),
      entries,
    }, null, 2), "utf-8");
    return { dir, file };
  }

  private stageInputArtifacts(
    nodeId: string,
    artifacts: ResolvedFileArtifact[],
  ): { dir: string } {
    const dir = mkdtempSync(join(tmpdir(), `forgectl-pipe-${nodeId}-input-`));
    for (const artifact of artifacts) {
      const targetPath = join(dir, artifact.targetPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(artifact.sourcePath, targetPath, { recursive: true });
    }
    return { dir };
  }

  private buildDryRunResult(startedAt: string): PipelineRun {
    const order = topologicalSort(this.pipeline);
    const nodeMap = new Map(this.pipeline.nodes.map(n => [n.id, n]));
    const dryRunErrors: string[] = [];

    // Simulate happy-path condition evaluation: all ancestors are "completed"
    // Walk in topo order, tracking which nodes would run on happy path
    const happyPathStatus = new Map<string, "completed" | "skipped">();
    for (const nodeId of order) {
      happyPathStatus.set(nodeId, "completed");
    }

    // Evaluate conditions on happy path to determine SKIP/RUN annotations
    const conditionAnnotations = new Map<string, { outcome: "RUN" | "SKIP"; detail: string }>();
    for (const nodeId of order) {
      const node = nodeMap.get(nodeId)!;
      if (node.condition === undefined) continue;

      // Build simulated context: all ancestor nodes = "completed"
      const simCtx: NodeStatusContext = {};
      for (const dep of node.depends_on ?? []) {
        simCtx[dep] = "completed";
      }

      try {
        const result = evaluateCondition(node.condition, simCtx);
        if (result) {
          conditionAnnotations.set(nodeId, {
            outcome: "RUN",
            detail: `condition: ${node.condition} -> true on happy path`,
          });
        } else {
          conditionAnnotations.set(nodeId, {
            outcome: "SKIP",
            detail: `condition: ${node.condition} -> false on happy path`,
          });
          // Mark as skipped in happy-path simulation
          happyPathStatus.set(nodeId, "skipped");
          // Update node state to reflect dry-run skip
          this.nodeStates.set(nodeId, {
            nodeId,
            status: "skipped",
            skipReason: `dry-run: condition false on happy path: ${node.condition}`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        dryRunErrors.push(`Node "${nodeId}": ${errMsg}`);
        conditionAnnotations.set(nodeId, {
          outcome: "SKIP",
          detail: `condition error: ${errMsg}`,
        });
      }
    }

    // Render output
    console.log(chalk.bold(`\nPipeline: ${this.pipeline.name} (dry run)\n`));
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
      const annotation = conditionAnnotations.get(nodeId);

      let line = chalk.gray(`    ${i + 1}. ${nodeId} [${workflow}/${agent}] depends: ${deps}`);
      if (annotation) {
        const color = annotation.outcome === "RUN" ? chalk.green : chalk.yellow;
        line += `  ${color(annotation.outcome)} (${annotation.detail})`;
      }
      if (node.loop !== undefined) {
        const loopMax = Math.min(node.loop.max_iterations ?? 10, GLOBAL_MAX_ITERATIONS);
        const loopInfo = chalk.cyan(`LOOP(max:${loopMax}, until: ${node.loop.until})`);
        line += `  ${loopInfo}`;
      }
      console.log(line);
      console.log(chalk.gray(`       Task: ${node.task.slice(0, 80)}${node.task.length > 80 ? "..." : ""}`));
    }
    console.log();

    if (dryRunErrors.length > 0) {
      console.log(chalk.red(`  DRY RUN ERRORS:`));
      for (const err of dryRunErrors) {
        console.log(chalk.red(`    - ${err}`));
      }
      console.log();
    }

    const hasFatalErrors = dryRunErrors.length > 0;

    return {
      id: this.pipelineRunId,
      pipeline: this.pipeline,
      status: hasFatalErrors ? "failed" : "completed",
      nodes: this.nodeStates,
      startedAt,
      completedAt: startedAt,
    };
  }

  private async acquireRepoLock(repoPath: string): Promise<() => void> {
    const previous = PipelineExecutor.repoLocks.get(repoPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    PipelineExecutor.repoLocks.set(repoPath, queued);
    await previous;
    return () => {
      release();
      if (PipelineExecutor.repoLocks.get(repoPath) === queued) {
        PipelineExecutor.repoLocks.delete(repoPath);
      }
    };
  }

  private async withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireRepoLock(repoPath);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private collectUpstreamGitBranches(node: PipelineNode): string[] {
    const branches = new Set<string>();
    for (const depId of node.depends_on ?? []) {
      const depState = this.nodeStates.get(depId);
      if (depState?.result?.output?.mode === "git" && depState.result.output.branch) {
        branches.add(depState.result.output.branch);
      }
    }
    return [...branches];
  }

  private prepareFanInBranch(node: PipelineNode, repoPath: string): FanInContext | null {
    const upstreamBranches = this.collectUpstreamGitBranches(node);
    if (upstreamBranches.length === 0) {
      return null;
    }

    const originalRef = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim();
    const originalSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim();
    const tempBranch = `forgectl-fanin-${this.pipelineRunId}-${node.id}-${Date.now()}`
      .replace(/[^a-zA-Z0-9._/-]/g, "-");
    const context: FanInContext = { repoPath, tempBranch, originalRef, originalSha };

    try {
      execFileSync("git", ["checkout", "-B", tempBranch, upstreamBranches[0]], { cwd: repoPath, stdio: "pipe" });
      console.log(chalk.gray(`    Prepared fan-in branch ${tempBranch} from ${upstreamBranches[0]}`));

      for (const branch of upstreamBranches.slice(1)) {
        try {
          execFileSync("git", ["-c", "user.name=forgectl", "-c", "user.email=forgectl@localhost", "merge", branch, "--no-edit"], { cwd: repoPath, stdio: "pipe" });
          console.log(chalk.gray(`    Merged ${branch} into ${tempBranch}`));
        } catch {
          const conflicts = this.getConflictFiles(repoPath);
          try { execFileSync("git", ["merge", "--abort"], { cwd: repoPath, stdio: "pipe" }); } catch { /* ignore */ }
          throw new Error(
            `Fan-in merge conflict for node ${node.id} while merging ${branch}` +
            (conflicts ? `: ${conflicts}` : "")
          );
        }
      }

      return context;
    } catch (err) {
      try {
        this.cleanupFanInBranch(context);
      } catch {
        // ignore cleanup errors here; the original error is more relevant.
      }
      throw err instanceof Error
        ? err
        : new Error(`Failed to prepare fan-in for node ${node.id}: ${String(err)}`);
    }
  }

  private mergeOutputBranchIntoHostRepo(
    repoPath: string,
    branch: string,
    fanInContext: FanInContext | null,
  ): void {
    if (fanInContext) {
      this.restoreOriginalRef(fanInContext);
    }

    try {
      execFileSync("git", ["-c", "user.name=forgectl", "-c", "user.email=forgectl@localhost", "merge", branch, "--no-edit"], { cwd: repoPath, stdio: "pipe" });
      console.log(chalk.gray(`    Merged ${branch} into host repo`));
    } catch {
      const conflicts = this.getConflictFiles(repoPath);
      try { execFileSync("git", ["merge", "--abort"], { cwd: repoPath, stdio: "pipe" }); } catch { /* ignore */ }
      throw new Error(
        `Failed to merge output branch ${branch}` +
        (conflicts ? `: ${conflicts}` : "")
      );
    }
  }

  private cleanupFanInBranch(context: FanInContext): void {
    this.restoreOriginalRef(context);
    try {
      execFileSync("git", ["branch", "-D", context.tempBranch], { cwd: context.repoPath, stdio: "pipe" });
    } catch {
      // Branch may already be gone.
    }
  }

  private restoreOriginalRef(context: FanInContext): void {
    const target = context.originalRef === "HEAD" ? context.originalSha : context.originalRef;
    execFileSync("git", ["checkout", target], { cwd: context.repoPath, stdio: "pipe" });
  }

  private getConflictFiles(repoPath: string): string {
    try {
      return execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  /**
   * Collect handoff entries from completed dependency nodes for a given node.
   * Used to build a summary of previous work that gets prepended to the task prompt.
   */
  private collectHandoffEntries(node: PipelineNode): HandoffEntry[] {
    const entries: HandoffEntry[] = [];
    for (const depId of node.depends_on ?? []) {
      const depState = this.nodeStates.get(depId);
      if (!depState) continue;

      const entry: HandoffEntry = {
        nodeId: depId,
        status: depState.status as "completed" | "failed" | "skipped",
      };

      if (depState.result?.output) {
        const output = depState.result.output;
        if (output.mode === "git") {
          entry.filesChanged = output.filesChanged;
          entry.diffStat = output.diffStat;
          entry.branch = output.branch;
        } else if (output.mode === "files") {
          entry.outputFiles = output.files;
        }
      }

      entries.push(entry);
    }
    return entries;
  }

  /** Get current node states (for status queries) */
  getNodeStates(): Map<string, NodeExecution> {
    return new Map(this.nodeStates);
  }
}
