import type { WorkflowDefinition, AgentType, ValidationStep } from "../config/schema.js";

export type { WorkflowDefinition, AgentType, ValidationStep };

/**
 * Validated front matter from a WORKFLOW.md file.
 * All fields are optional since they serve as overrides.
 */
export interface WorkflowFileConfig {
  extends?: string;
  tracker?: {
    kind?: "github" | "notion";
    token?: string;
    active_states?: string[];
    terminal_states?: string[];
    poll_interval_ms?: number;
    auto_close?: boolean;
    repo?: string;
    labels?: string[];
    database_id?: string;
    property_map?: Record<string, string>;
    in_progress_label?: string;
    done_label?: string;
  };
  polling?: {
    interval_ms: number;
  };
  concurrency?: {
    max_agents: number;
  };
  workspace?: {
    root?: string;
    hooks?: {
      after_create?: string;
      before_run?: string;
      after_run?: string;
      before_remove?: string;
    };
    hook_timeout?: string;
  };
  agent?: {
    type?: "claude-code" | "codex";
    model?: string;
    timeout?: string;
  };
  validation?: {
    steps: ValidationStep[];
    lint_steps?: ValidationStep[];
    on_failure: "abandon" | "output-wip" | "pause";
  };
  delegation?: {
    max_children?: number;
  };
  autonomy?: "full" | "interactive" | "semi" | "supervised";
  skills?: string[];
  auto_approve?: {
    label?: string;
    workflow_pattern?: string;
    max_cost?: number;
  };
  team?: {
    size?: number;
  };
}

/**
 * Result of loading and validating a WORKFLOW.md file.
 */
export interface ValidatedWorkflowFile {
  config: WorkflowFileConfig;
  promptTemplate: string;
}

export interface NetworkConfig {
  mode: "open" | "allowlist" | "airgapped";
  dockerNetwork: string;       // "bridge" for open, "none" for airgapped, "forgectl-<runId>" for allowlist
  allow?: string[];            // Only for allowlist mode
}

export interface ResourceConfig {
  memory: string;
  cpus: number;
}

export interface InjectConfig {
  source: string;   // Host path
  target: string;   // Container path
}

export interface ReviewConfig {
  enabled: boolean;
  system: string;
  maxRounds: number;
  agent: AgentType;
  model: string;
}

export interface CommitConfig {
  message: { prefix: string; template: string; includeTask: boolean };
  author: { name: string; email: string };
  sign: boolean;
}

export interface RunPlan {
  runId: string;
  task: string;
  workflow: WorkflowDefinition;
  agent: {
    type: AgentType;
    model: string;
    maxTurns: number;
    timeout: number;   // in ms
    flags: string[];
  };
  container: {
    image: string;
    dockerfile?: string;
    network: NetworkConfig;
    resources: ResourceConfig;
  };
  input: {
    mode: "repo" | "files" | "both";
    sources: string[];       // Paths to repo or input files
    mountPath: string;
    exclude: string[];       // For repo mode
  };
  context: {
    system: string;
    files: string[];
    inject: InjectConfig[];
  };
  validation: {
    steps: ValidationStep[];
    lintSteps: ValidationStep[];
    onFailure: "abandon" | "output-wip" | "pause";
  };
  output: {
    mode: "git" | "files";
    path: string;            // Container path
    collect: string[];       // Globs for file mode
    hostDir: string;         // Where file output lands on host
  };
  orchestration: {
    mode: "single" | "review" | "parallel";
    review: ReviewConfig;
  };
  commit: CommitConfig;
  costCeiling?: {
    maxCostUsd?: number;
    maxTokens?: number;
  };
  noSkills?: boolean;
  noTeam?: boolean;
  noContext?: boolean;
  skipCheckpoints?: boolean;
  team?: {
    size: number;
    slotWeight: number;
  };
}
