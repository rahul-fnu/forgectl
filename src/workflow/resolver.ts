import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkflowDefinition, RunPlan, NetworkConfig } from "./types.js";
import type { AutonomyLevel, AutoApproveRule } from "../config/schema.js";
import type { ValidationStep } from "../config/schema.js";
import { getWorkflow } from "./registry.js";
import { parseDuration } from "../utils/duration.js";
import { parseMemory } from "../container/runner.js";

export interface WorkflowOverrides {
  autonomy?: AutonomyLevel;
  auto_approve?: AutoApproveRule;
}

export interface CLIOptions {
  task: string;
  workflow?: string;
  repo?: string;
  input?: string[];
  context?: string[];
  noContext?: boolean;
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
  // Commander sets skills=false when --no-skills is passed, undefined when omitted
  skills?: boolean;
  // Commander sets team=false when --no-team is passed, undefined when omitted
  team?: boolean;
  // Numeric override from --team-size
  teamSize?: number;
}

/**
 * Scale base memory string by 1GB per teammate (teammates = teamSize - 1).
 * Returns a string like "6g" using ceiling division to nearest GB.
 */
function scaleMemoryForTeam(baseMemory: string, teammateCount: number): string {
  const baseBytes = parseMemory(baseMemory);
  const extraBytes = teammateCount * 1024 ** 3;
  const totalGB = Math.ceil((baseBytes + extraBytes) / 1024 ** 3);
  return `${totalGB}g`;
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
    // Auto-detect language-specific code workflow
    const cwd = resolve(options.repo || ".");
    const lang = detectLanguage(cwd);
    if (lang === "python") return "code-python";
    if (lang === "go") return "code-go";
    if (lang === "rust") return "code-rust";
    return "code";
  } catch {
    return "general";
  }
}

interface LanguageDefaults {
  image: string;
  validation: ValidationStep[];
}

const LANGUAGE_DEFAULTS: Record<string, LanguageDefaults> = {
  python: {
    image: "forgectl/code-python312",
    validation: [
      { name: "test", command: "pytest", retries: 3, description: "" },
      { name: "lint", command: "ruff check .", retries: 3, description: "" },
      { name: "typecheck", command: "mypy .", retries: 2, description: "" },
    ],
  },
  go: {
    image: "forgectl/code-go122",
    validation: [
      { name: "test", command: "go test ./...", retries: 3, description: "" },
      { name: "lint", command: "golangci-lint run", retries: 3, description: "" },
    ],
  },
  rust: {
    image: "forgectl/code-rust",
    validation: [
      { name: "test", command: "cargo test", retries: 3, description: "" },
      { name: "lint", command: "cargo clippy -- -D warnings", retries: 3, description: "" },
    ],
  },
};

/**
 * Detect the project language from marker files in the workspace directory.
 * Returns language key or undefined if no marker is found (defaults to Node).
 */
function detectLanguage(workspaceDir: string): string | undefined {
  if (existsSync(resolve(workspaceDir, "pyproject.toml")) || existsSync(resolve(workspaceDir, "requirements.txt"))) {
    return "python";
  }
  if (existsSync(resolve(workspaceDir, "go.mod"))) {
    return "go";
  }
  if (existsSync(resolve(workspaceDir, "Cargo.toml"))) {
    return "rust";
  }
  return undefined;
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
  options: CLIOptions,
  workflowOverrides?: WorkflowOverrides,
): RunPlan {
  const workflowName = detectWorkflow(options);
  const baseWorkflow = getWorkflow(workflowName);
  const workflow: WorkflowDefinition = workflowOverrides
    ? {
        ...baseWorkflow,
        ...(workflowOverrides.autonomy !== undefined && { autonomy: workflowOverrides.autonomy }),
        ...(workflowOverrides.auto_approve !== undefined && { auto_approve: workflowOverrides.auto_approve }),
      }
    : baseWorkflow;
  const runId = `forge-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
  const agentType = (options.agent ?? config.agent.type) as "claude-code" | "codex";

  // Language auto-detection for code workflow (only when no explicit config image)
  const workspaceDir = resolve(options.repo || ".");
  const detectedLang = workflowName === "code" && !config.container.image
    ? detectLanguage(workspaceDir)
    : undefined;
  const langDefaults = detectedLang ? LANGUAGE_DEFAULTS[detectedLang] : undefined;

  // Team config: CLI --team-size overrides workflow, --no-team disables entirely
  const resolvedNoTeam = options.team === false;
  const effectiveTeamSize = resolvedNoTeam
    ? undefined
    : options.teamSize ?? workflow.team?.size;
  const hasTeam = effectiveTeamSize !== undefined && effectiveTeamSize >= 2;

  // Determine input sources
  const inputSources: string[] = [];
  if (workflow.input.mode === "repo" || workflow.input.mode === "both") {
    inputSources.push(resolve(options.repo || "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map(p => resolve(p)));
  }

  // Determine review config
  // Commander: --review sets review=true, --no-review sets review=false, neither sets review=undefined
  const reviewEnabled = options.review === true
    ? true
    : options.review === false
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
      image: config.container.image ?? langDefaults?.image ?? workflow.container.image,
      dockerfile: config.container.dockerfile,
      network: resolveNetwork(workflow, config, agentType, runId),
      resources: {
        memory: hasTeam
          ? scaleMemoryForTeam(config.container.resources.memory, effectiveTeamSize! - 1)
          : config.container.resources.memory,
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
      files: Array.isArray(options.context) ? options.context : [],
      inject: [],
    },
    validation: {
      steps: langDefaults?.validation ?? workflow.validation.steps,
      lintSteps: workflow.validation.lint_steps ?? [],
      onFailure: workflow.validation.on_failure,
      maxSameFailures: workflow.validation.max_same_failures ?? 2,
      onRepeatedFailure: workflow.validation.on_repeated_failure ?? "abort",
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
    costCeiling: (config.agent.max_cost_usd !== undefined || config.agent.max_tokens !== undefined)
      ? { maxCostUsd: config.agent.max_cost_usd, maxTokens: config.agent.max_tokens }
      : undefined,
    noSkills: options.skills === false,
    noContext: options.noContext || undefined,
    noTeam: resolvedNoTeam || undefined,
    skipCheckpoints: hasTeam || undefined,
    team: hasTeam ? { size: effectiveTeamSize!, slotWeight: effectiveTeamSize! } : undefined,
  };
}
