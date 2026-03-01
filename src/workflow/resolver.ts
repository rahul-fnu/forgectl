import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkflowDefinition, RunPlan, NetworkConfig } from "./types.js";
import { getWorkflow } from "./registry.js";
import { parseDuration } from "../utils/duration.js";

export interface CLIOptions {
  task: string;
  workflow?: string;
  repo?: string;
  input?: string[];
  context?: string[];
  agent?: string;
  model?: string;
  review?: boolean;
  noReview?: boolean;
  outputDir?: string;
  timeout?: string;
  verbose?: boolean;
  noCleanup?: boolean;
  dryRun?: boolean;
  config?: string;
}

/**
 * Auto-detect workflow from CLI inputs if not explicitly specified.
 */
function detectWorkflow(options: CLIOptions): string {
  if (options.workflow) return options.workflow;
  if (options.repo) return "code";
  if (options.input?.some(f => /\.(csv|tsv|json|parquet|xlsx)$/i.test(f))) return "data";
  if (options.input?.some(f => /\.(md|txt|docx|doc)$/i.test(f))) return "content";
  // Check if cwd is a git repo
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return "code";
  } catch {
    return "general";
  }
}

/**
 * Resolve network configuration from workflow + config overrides.
 */
function resolveNetwork(
  workflow: WorkflowDefinition,
  config: ForgectlConfig,
  agentType: string,
  runId: string
): NetworkConfig {
  const mode = config.container.network.mode ?? workflow.container.network.mode;

  if (mode === "open") {
    return { mode: "open", dockerNetwork: "bridge" };
  }

  if (mode === "airgapped") {
    return { mode: "airgapped", dockerNetwork: "none" };
  }

  // Allowlist mode
  const allow = [
    ...workflow.container.network.allow,
    ...(config.container.network.allow ?? []),
  ];

  // Auto-add LLM API domain
  if (agentType === "claude-code" && !allow.includes("api.anthropic.com")) {
    allow.push("api.anthropic.com");
  }
  if (agentType === "codex" && !allow.includes("api.openai.com")) {
    allow.push("api.openai.com");
  }

  return {
    mode: "allowlist",
    dockerNetwork: `forgectl-${runId}`,
    allow,
  };
}

/**
 * Build a complete RunPlan from workflow definition + config + CLI options.
 */
export function resolveRunPlan(
  config: ForgectlConfig,
  options: CLIOptions
): RunPlan {
  const workflowName = detectWorkflow(options);
  const workflow = getWorkflow(workflowName);
  const runId = `forge-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
  const agentType = (options.agent ?? config.agent.type) as "claude-code" | "codex";

  // Determine input sources
  const inputSources: string[] = [];
  if (workflow.input.mode === "repo" || workflow.input.mode === "both") {
    inputSources.push(resolve(options.repo || "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map(p => resolve(p)));
  }

  // Determine review config
  const reviewEnabled = options.review === true
    ? true
    : options.noReview === true
    ? false
    : workflow.review.enabled;

  return {
    runId,
    task: options.task,
    workflow,
    agent: {
      type: agentType,
      model: options.model ?? config.agent.model,
      maxTurns: config.agent.max_turns,
      timeout: parseDuration(options.timeout ?? config.agent.timeout),
      flags: config.agent.flags,
    },
    container: {
      image: config.container.image ?? workflow.container.image,
      dockerfile: config.container.dockerfile,
      network: resolveNetwork(workflow, config, agentType, runId),
      resources: {
        memory: config.container.resources.memory,
        cpus: config.container.resources.cpus,
      },
    },
    input: {
      mode: workflow.input.mode,
      sources: inputSources.length > 0 ? inputSources : [resolve(".")],
      mountPath: workflow.input.mountPath,
      exclude: config.repo.exclude,
    },
    context: {
      system: workflow.system,
      files: options.context ?? [],
      inject: [],
    },
    validation: {
      steps: workflow.validation.steps,
      onFailure: workflow.validation.on_failure,
    },
    output: {
      mode: workflow.output.mode,
      path: workflow.output.path,
      collect: workflow.output.collect,
      hostDir: resolve(options.outputDir ?? config.output.dir, runId),
    },
    orchestration: {
      mode: reviewEnabled && config.orchestration.mode === "single" ? "review" : config.orchestration.mode,
      review: {
        enabled: reviewEnabled,
        system: workflow.review.system,
        maxRounds: config.orchestration.review.max_rounds,
        agent: agentType,
        model: options.model ?? config.agent.model,
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
