import crypto from "node:crypto";
import type { RunPlan } from "../workflow/types.js";
import type { TrackerIssue } from "../tracker/types.js";
import type { ForgectlConfig, ValidationStep } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { AgentResult } from "../agent/session.js";
import type { ExecutionResult } from "../orchestration/single.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CleanupContext } from "../container/cleanup.js";
import { prepareExecution } from "../orchestration/single.js";
import { createAgentSession } from "../agent/session.js";
import { cleanupRun } from "../container/cleanup.js";
import { buildResultComment } from "./comment.js";
import { renderPromptTemplate, buildTemplateVars } from "../workflow/template.js";
import { parseDuration } from "../utils/duration.js";

export interface WorkerResult {
  agentResult: AgentResult;
  comment: string;
  executionResult?: ExecutionResult;
}

/**
 * Build a RunPlan adapted for orchestrated runs.
 * Uses WorkspaceManager paths instead of temp dirs.
 */
export function buildOrchestratedRunPlan(
  issue: TrackerIssue,
  config: ForgectlConfig,
  workspacePath: string,
  promptTemplate: string,
  attempt: number,
  validationConfig?: { steps: ValidationStep[]; on_failure: string },
): RunPlan {
  const runId = crypto.randomUUID();

  // Render the prompt template with issue data
  const vars = buildTemplateVars(issue, attempt);
  const task = renderPromptTemplate(promptTemplate, vars);

  // Agent settings from config
  const agentConfig = config.agent;
  const timeoutMs = parseDuration(agentConfig.timeout);

  // Container image from config
  const containerConfig = config.container;
  const image = containerConfig.image ?? "node:20";

  return {
    runId,
    task,
    workflow: {
      name: "orchestrated",
      description: `Orchestrated run for ${issue.identifier}`,
      container: { image, network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: [],
      system: "",
      validation: {
        steps: validationConfig?.steps ?? [],
        on_failure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
      },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
    },
    agent: {
      type: agentConfig.type,
      model: agentConfig.model,
      maxTurns: agentConfig.max_turns,
      timeout: timeoutMs,
      flags: agentConfig.flags,
    },
    container: {
      image,
      network: {
        mode: containerConfig.network.mode ?? "open",
        dockerNetwork: containerConfig.network.mode === "airgapped" ? "none" : "bridge",
      },
      resources: {
        memory: containerConfig.resources.memory,
        cpus: containerConfig.resources.cpus,
      },
    },
    input: {
      mode: "repo",
      sources: [workspacePath],
      mountPath: "/workspace",
      exclude: config.repo.exclude,
    },
    context: {
      system: "",
      files: [],
      inject: [],
    },
    validation: {
      steps: validationConfig?.steps ?? [],
      onFailure: (validationConfig?.on_failure as "abandon" | "output-wip" | "pause") ?? "abandon",
    },
    output: {
      mode: "git",
      path: "/workspace",
      collect: [],
      hostDir: workspacePath,
    },
    orchestration: {
      mode: "single",
      review: {
        enabled: false,
        system: "",
        maxRounds: 0,
        agent: "claude-code",
        model: "",
      },
    },
    commit: {
      message: {
        prefix: config.commit.message.prefix,
        template: config.commit.message.template,
        includeTask: config.commit.message.include_task,
      },
      author: config.commit.author,
      sign: config.commit.sign,
    },
  };
}

/**
 * Execute a single worker lifecycle for an issue.
 * Adapts the existing prepareExecution flow to use WorkspaceManager paths.
 */
export async function executeWorker(
  issue: TrackerIssue,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  attempt: number,
  logger: Logger,
  onActivity?: () => void,
): Promise<WorkerResult> {
  // 1. Ensure workspace exists
  const wsInfo = await workspaceManager.ensureWorkspace(issue.identifier);
  const workspacePath = wsInfo.path;

  // 2. Run before hook
  try {
    await workspaceManager.runBeforeHook(issue.identifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("worker", `Before hook failed for ${issue.identifier}: ${message}`);
    const failResult: AgentResult = {
      stdout: "",
      stderr: message,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
    return {
      agentResult: failResult,
      comment: buildResultComment({
        status: "failed",
        durationMs: 0,
        agentType: config.agent.type,
        attempt,
        tokenUsage: failResult.tokenUsage,
      }),
    };
  }

  // 3. Build RunPlan
  const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, attempt);

  // 4. Create CleanupContext with empty tempDirs (workspace persists)
  const cleanup: CleanupContext = { tempDirs: [], secretCleanups: [] };

  let agentResult: AgentResult;

  try {
    // 5. Prepare execution (container, credentials, network)
    const { container, agentOptions, agentEnv } = await prepareExecution(plan, logger, cleanup);

    // 6. Create agent session with onActivity callback for stall detection
    const session = createAgentSession(plan.agent.type, container, agentOptions, agentEnv, {
      onActivity,
    });

    // 7. Invoke agent
    logger.info("worker", `Running agent for ${issue.identifier} (attempt ${attempt})`);
    agentResult = await session.invoke(plan.task);
    await session.close();

    logger.info("worker", `Agent finished: status=${agentResult.status}, duration=${agentResult.durationMs}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("worker", `Agent execution failed for ${issue.identifier}: ${message}`);
    agentResult = {
      stdout: "",
      stderr: message,
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 0,
      turnCount: 0,
    };
  }

  // 8. Build structured comment
  const comment = buildResultComment({
    status: agentResult.status,
    durationMs: agentResult.durationMs,
    agentType: config.agent.type,
    attempt,
    tokenUsage: agentResult.tokenUsage,
  });

  // 9. Run after hook (catch and log errors)
  try {
    await workspaceManager.runAfterHook(issue.identifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `After hook failed for ${issue.identifier} (ignored): ${message}`);
  }

  // 10. Cleanup container (but not workspace — tempDirs is empty)
  try {
    await cleanupRun(cleanup);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `Cleanup failed for ${issue.identifier} (ignored): ${message}`);
  }

  return { agentResult, comment };
}
