import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
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
import { collectAncestors, collectDescendants, validateDAG, topologicalSort } from "./dag.js";
import { getWorkflowOutputMode, resolveNodeInput } from "./resolver.js";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";
import { executeRun } from "../orchestration/modes.js";
import { Logger } from "../logging/logger.js";
import { emitRunEvent } from "../logging/events.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import type { OutputResult } from "../output/types.js";

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

    // Track in-flight promises
    const inFlight = new Map<string, Promise<void>>();
    const maxParallel = this.options.maxParallel ?? 3;

    let pipelineStatus: "running" | "completed" | "failed" = "running";

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId)!;

      if (!selection.executeNodes.has(nodeId)) {
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

      const dependencyIssues = this.getDependencyIssues(deps);
      if (dependencyIssues.length > 0) {
        const reason = dependencyIssues.join("; ");
        this.nodeStates.set(nodeId, {
          nodeId,
          status: "skipped",
          error: reason,
          skipReason: reason,
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

    emitRunEvent({
      runId: this.pipelineRunId,
      type: pipelineStatus === "completed" ? "completed" : "failed",
      timestamp: new Date().toISOString(),
      data: {
        status: pipelineStatus,
        completed: allStatuses.filter(s => s === "completed").length,
        failed: allStatuses.filter(s => s === "failed").length,
        skipped: allStatuses.filter(s => s === "skipped").length,
      },
    });

    return {
      id: this.pipelineRunId,
      pipeline: this.pipeline,
      status: pipelineStatus,
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
    } else if (checkpoint.outputDir) {
      output = {
        mode: "files",
        dir: checkpoint.outputDir,
        files: [...(checkpoint.outputFiles ?? [])],
        totalSize: 0,
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

      // Build CLIOptions from node + pipeline defaults
      const cliOptions: CLIOptions = {
        task: node.task,
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

  private getDependencyIssues(deps: string[]): string[] {
    const issues: string[] = [];
    for (const dep of deps) {
      const state = this.nodeStates.get(dep);
      if (!state) {
        issues.push(`Dependency ${dep} has no state`);
        continue;
      }

      if (state.status === "failed") {
        issues.push(`Dependency ${dep} failed`);
        continue;
      }

      if (state.status === "completed") {
        if (!state.result?.success) {
          issues.push(`Dependency ${dep} completed unsuccessfully`);
        }
        continue;
      }

      if (state.status === "skipped") {
        const hydratedSuccess = Boolean(state.result?.success && state.result.output);
        if (!hydratedSuccess) {
          issues.push(`Dependency ${dep} was skipped without hydrated output`);
        }
        continue;
      }

      if (state.status === "pending" || state.status === "running") {
        issues.push(`Dependency ${dep} is not finished (${state.status})`);
      }
    }

    return issues;
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

    const originalRef = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    const originalSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    const tempBranch = `forgectl-fanin-${this.pipelineRunId}-${node.id}-${Date.now()}`
      .replace(/[^a-zA-Z0-9._/-]/g, "-");
    const context: FanInContext = { repoPath, tempBranch, originalRef, originalSha };

    try {
      execSync(`git checkout -B ${tempBranch} ${upstreamBranches[0]}`, { cwd: repoPath, stdio: "pipe" });
      console.log(chalk.gray(`    Prepared fan-in branch ${tempBranch} from ${upstreamBranches[0]}`));

      for (const branch of upstreamBranches.slice(1)) {
        try {
          execSync(`git merge ${branch} --no-edit`, { cwd: repoPath, stdio: "pipe" });
          console.log(chalk.gray(`    Merged ${branch} into ${tempBranch}`));
        } catch {
          const conflicts = this.getConflictFiles(repoPath);
          try { execSync("git merge --abort", { cwd: repoPath, stdio: "pipe" }); } catch { /* ignore */ }
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
      execSync(`git merge ${branch} --no-edit`, { cwd: repoPath, stdio: "pipe" });
      console.log(chalk.gray(`    Merged ${branch} into host repo`));
    } catch {
      const conflicts = this.getConflictFiles(repoPath);
      try { execSync("git merge --abort", { cwd: repoPath, stdio: "pipe" }); } catch { /* ignore */ }
      throw new Error(
        `Failed to merge output branch ${branch}` +
        (conflicts ? `: ${conflicts}` : "")
      );
    }
  }

  private cleanupFanInBranch(context: FanInContext): void {
    this.restoreOriginalRef(context);
    try {
      execSync(`git branch -D ${context.tempBranch}`, { cwd: context.repoPath, stdio: "pipe" });
    } catch {
      // Branch may already be gone.
    }
  }

  private restoreOriginalRef(context: FanInContext): void {
    const target = context.originalRef === "HEAD" ? context.originalSha : context.originalRef;
    execSync(`git checkout ${target}`, { cwd: context.repoPath, stdio: "pipe" });
  }

  private getConflictFiles(repoPath: string): string {
    try {
      return execSync("git diff --name-only --diff-filter=U", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  /** Get current node states (for status queries) */
  getNodeStates(): Map<string, NodeExecution> {
    return new Map(this.nodeStates);
  }
}
