import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkflowDefinition, RunPlan, NetworkConfig } from "./types.js";
import type { AutonomyLevel, AutoApproveRule } from "../config/schema.js";
import { detectStack } from "./detect.js";
import { loadCustomWorkflows } from "./custom.js";
import { deepMerge } from "../config/loader.js";
import { parseDuration } from "../utils/duration.js";
import { parseMemory } from "../container/runner.js";

const CODE_SYSTEM = `You are an expert software engineer working in an isolated container.
Your workspace is at /workspace containing the project repository.
Read CLAUDE.md in the workspace root for project conventions and architecture.

Rules:
- Understand before you code — search the codebase for related code before writing.
- Follow the project's existing patterns, not your own preferences.
- Make surgical changes — only change what the task requires.
- Verify continuously — run checks after each meaningful change.
- If stuck after 3 attempts, simplify and try a different approach.
- Write tests for new functionality and bug fixes.`;

const REVIEW_SYSTEM = `You are a senior code reviewer. Critically review the changes.
Check for: security issues, error handling, resource leaks, logic errors, test coverage.
If acceptable, respond with exactly: LGTM
If issues exist, list them numbered. Only flag real problems, not style preferences.`;

const BUILTINS: Record<string, WorkflowDefinition> = {
  code: {
    name: "code",
    description: "Write, fix, or refactor code in a git repository",
    container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
    input: { mode: "repo", mountPath: "/workspace" },
    tools: ["git", "ripgrep", "fd"],
    system: CODE_SYSTEM,
    validation: {
      steps: [],
      lint_steps: [],
      on_failure: "abandon",
      max_same_failures: 2,
      on_repeated_failure: "abort",
    },
    output: { mode: "git", path: "/workspace", collect: [] },
    review: { enabled: true, system: REVIEW_SYSTEM },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
  research: {
    name: "research",
    description: "Research a topic, synthesize findings, produce a report",
    container: { image: "forgectl/research-browser", network: { mode: "open", allow: [] } },
    input: { mode: "files", mountPath: "/input" },
    tools: ["curl", "puppeteer", "jq", "pandoc", "python3"],
    system: `You are an expert researcher working in an isolated container.

You have access to the web via curl and a headless browser (Puppeteer).
Context files (if any) are in /input.
Write your output to /output.

Rules:
- Cite all sources with URLs
- Distinguish facts from analysis/opinion
- Use markdown for reports
- Include an executive summary at the top
- Save all output files to /output`,
    validation: {
      steps: [
        { name: "output-exists", command: "test -f /output/*.md || test -f /output/*.pdf", retries: 2, description: "Report file exists" },
        { name: "has-sources", command: "grep -c 'http' /output/*.md | awk -F: '{s+=$2} END {if(s<3) exit 1}'", retries: 2, description: "Report includes at least 3 source URLs" },
        { name: "min-length", command: "wc -w /output/*.md | tail -1 | awk '{if($1<500) exit 1}'", retries: 1, description: "Report is at least 500 words" },
      ],
      lint_steps: [],
      on_failure: "output-wip",
      max_same_failures: 2,
      on_repeated_failure: "abort",
    },
    output: { mode: "git", path: "/output", collect: ["**/*.md", "**/*.pdf", "**/*.json"] },
    review: {
      enabled: true,
      system: `You are a fact-checker and editor. Review this research report.
Check for: unsupported claims, missing citations, logical gaps, outdated information.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
    },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
  content: {
    name: "content",
    description: "Write blog posts, documentation, marketing copy, translations",
    container: { image: "forgectl/content", network: { mode: "open", allow: [] } },
    input: { mode: "files", mountPath: "/input" },
    tools: ["pandoc", "vale", "wkhtmltopdf", "python3"],
    system: `You are an expert writer working in an isolated container.

Context files (brand guides, source material, etc.) are in /input.
Write your output to /output.

Rules:
- Match the tone and style specified in the task or brand guide
- Use markdown unless another format is specified
- Include appropriate headings and structure
- Save all output files to /output`,
    validation: {
      steps: [
        { name: "output-exists", command: "ls /output/*.md /output/*.html /output/*.pdf 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output file exists" },
        { name: "prose-lint", command: "vale --output=line /output/*.md 2>/dev/null || true", retries: 2, description: "Prose quality check (spelling, grammar, style)" },
      ],
      lint_steps: [],
      on_failure: "output-wip",
      max_same_failures: 2,
      on_repeated_failure: "abort",
    },
    output: { mode: "git", path: "/output", collect: ["**/*.md", "**/*.html", "**/*.pdf", "**/*.docx"] },
    review: {
      enabled: true,
      system: `You are a senior editor. Review this content for clarity, accuracy, and tone.
Check for: factual errors, unclear writing, tone inconsistency, missing sections.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
    },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
  data: {
    name: "data",
    description: "ETL, analysis, cleaning, visualization, dataset transformation",
    container: { image: "forgectl/data", network: { mode: "open", allow: [] } },
    input: { mode: "files", mountPath: "/input" },
    tools: ["python3", "pandas", "numpy", "matplotlib", "duckdb", "jq", "csvkit"],
    system: `You are a data engineer/analyst working in an isolated container.

Input data files are in /input.
Write all output to /output.

Rules:
- Validate data before and after transformations
- Preserve original files in /input (read-only)
- Document any assumptions or data quality issues
- Save analysis scripts to /output/scripts/ so work is reproducible
- Save data outputs to /output/data/
- Save visualizations to /output/viz/`,
    validation: {
      steps: [
        { name: "output-exists", command: "ls /output/data/* 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output data files exist" },
        { name: "scripts-exist", command: "ls /output/scripts/*.py 2>/dev/null | head -1 | grep -q .", retries: 1, description: "Processing scripts are saved (reproducibility)" },
        {
          name: "no-pii",
          command: `python3 -c "
import re, sys, glob
patterns = [r'\\b\\d{3}-\\d{2}-\\d{4}\\b', r'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b']
for f in glob.glob('/output/data/*'):
  text = open(f).read()
  for p in patterns:
    if re.search(p, text):
      print(f'PII detected in {f}'); sys.exit(1)
"`,
          retries: 1,
          description: "Check output for PII (SSN, email patterns)",
        },
      ],
      lint_steps: [],
      on_failure: "abandon",
      max_same_failures: 2,
      on_repeated_failure: "abort",
    },
    output: { mode: "git", path: "/output", collect: ["**/*"] },
    review: { enabled: false, system: "" },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
  ops: {
    name: "ops",
    description: "Infrastructure scripts, Terraform modules, migration scripts, monitoring config",
    container: { image: "forgectl/ops", network: { mode: "open", allow: [] } },
    input: { mode: "repo", mountPath: "/workspace" },
    tools: ["terraform", "aws-cli", "kubectl", "ansible", "shellcheck", "python3"],
    system: `You are a senior infrastructure engineer working in an isolated container.

Your workspace is at /workspace. You are writing infrastructure-as-code.
You do NOT have access to any real cloud accounts or clusters.
All validation is via dry-run / plan / lint — nothing is applied.

Rules:
- All Terraform must pass \`terraform validate\` and \`terraform fmt\`
- All shell scripts must pass shellcheck
- Include README or comments explaining what the code does
- Use variables for anything environment-specific (no hardcoded values)`,
    validation: {
      steps: [
        { name: "shellcheck", command: "find /workspace -name '*.sh' -exec shellcheck {} + 2>/dev/null || true", retries: 2, description: "Shell script linting" },
        { name: "terraform-fmt", command: "find /workspace -name '*.tf' -exec terraform fmt -check {} + 2>/dev/null || true", retries: 2, description: "Terraform formatting" },
        { name: "terraform-validate", command: "cd /workspace && terraform init -backend=false 2>/dev/null && terraform validate 2>/dev/null || true", retries: 2, description: "Terraform configuration validation" },
      ],
      lint_steps: [],
      on_failure: "output-wip",
      max_same_failures: 2,
      on_repeated_failure: "abort",
    },
    output: { mode: "git", path: "/workspace", collect: [] },
    review: {
      enabled: true,
      system: `You are a senior infrastructure reviewer. Review these IaC changes.
Check for: security misconfigs, missing encryption, overly permissive IAM,
hardcoded secrets, missing tagging, resource naming conventions.
If acceptable, respond with: LGTM
If issues exist, list them numbered.`,
    },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
  general: {
    name: "general",
    description: "General-purpose workflow. Configure via project config.",
    container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
    input: { mode: "files", mountPath: "/input" },
    tools: ["git", "curl", "jq", "python3"],
    system: `You are an AI assistant working in an isolated container.
Input files (if any) are in /input. Write output to /output.
Complete the task as instructed.`,
    validation: { steps: [], lint_steps: [], on_failure: "output-wip", max_same_failures: 2, on_repeated_failure: "abort" },
    output: { mode: "git", path: "/output", collect: ["**/*"] },
    review: { enabled: false, system: "" },
    cache: { enabled: true, ttl: "7d" },
    autonomy: "full",
    skills: [],
  },
};

export function getWorkflow(name: string, projectDir?: string): WorkflowDefinition {
  if (BUILTINS[name]) return BUILTINS[name];

  const customs = loadCustomWorkflows(projectDir);
  const custom = customs[name];
  if (!custom) {
    throw new Error(
      `Unknown workflow: "${name}". Available: ${listWorkflowNames(projectDir).join(", ")}`
    );
  }

  if (custom.extends && BUILTINS[custom.extends]) {
    return deepMerge(BUILTINS[custom.extends], custom) as WorkflowDefinition;
  }

  return custom;
}

export function listWorkflowNames(projectDir?: string): string[] {
  const customNames = Object.keys(loadCustomWorkflows(projectDir));
  return [...Object.keys(BUILTINS), ...customNames];
}

export function listWorkflows(projectDir?: string): WorkflowDefinition[] {
  const customs = loadCustomWorkflows(projectDir);
  return [...Object.values(BUILTINS), ...Object.values(customs)];
}

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
  skills?: boolean;
  team?: boolean;
  teamSize?: number;
}

function scaleMemoryForTeam(baseMemory: string, teammateCount: number): string {
  const baseBytes = parseMemory(baseMemory);
  const extraBytes = teammateCount * 1024 ** 3;
  const totalGB = Math.ceil((baseBytes + extraBytes) / 1024 ** 3);
  return `${totalGB}g`;
}

function detectWorkflow(options: CLIOptions): string {
  if (options.workflow) return options.workflow;
  if (options.repo) return "code";
  if (options.input?.some(f => /\.(csv|tsv|json|parquet|xlsx)$/i.test(f))) return "data";
  if (options.input?.some(f => /\.(md|txt|docx|doc)$/i.test(f))) return "content";
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return "code";
  } catch {
    return "general";
  }
}

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

  const allow = [
    ...workflow.container.network.allow,
    ...(config.container.network.allow ?? []),
  ];

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

  const workspaceDir = resolve(options.repo || ".");
  const detected = workflowName === "code" && !config.container.image
    ? detectStack(workspaceDir)
    : undefined;

  const resolvedNoTeam = options.team === false;
  const effectiveTeamSize = resolvedNoTeam
    ? undefined
    : options.teamSize ?? workflow.team?.size;
  const hasTeam = effectiveTeamSize !== undefined && effectiveTeamSize >= 2;

  const inputSources: string[] = [];
  if (workflow.input.mode === "repo" || workflow.input.mode === "both") {
    inputSources.push(resolve(options.repo || "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map(p => resolve(p)));
  }

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
      image: config.container.image ?? detected?.image ?? workflow.container.image,
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
      steps: detected?.defaultValidation ?? workflow.validation.steps,
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
