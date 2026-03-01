import type { WorkflowDefinition, AgentType, ValidationStep } from "../config/schema.js";

export type { WorkflowDefinition, AgentType, ValidationStep };

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
}
