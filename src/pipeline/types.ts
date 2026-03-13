import type { ExecutionResult } from "../orchestration/single.js";

/** Pipeline definition loaded from YAML */
export interface PipelineDefinition {
  name: string;
  description?: string;
  defaults?: PipelineDefaults;
  nodes: PipelineNode[];
}

export interface PipelineDefaults {
  workflow?: string;
  agent?: string;
  repo?: string;
  review?: boolean;
  model?: string;
}

export interface PipelineNode {
  id: string;
  task: string;
  depends_on?: string[];
  workflow?: string;
  agent?: string;
  repo?: string;
  review?: boolean;
  model?: string;
  input?: string[];
  context?: string[];
  pipe?: {
    mode: "branch" | "files" | "context";
  };
  node_type?: "task" | "condition" | "loop";
  condition?: string;
  else_node?: string;
  if_failed?: string;
  if_passed?: string;
  loop?: {
    until: string;
    max_iterations?: number;
    body?: string[];
  };
}

/** Runtime state of a pipeline execution */
export interface PipelineRun {
  id: string;
  pipeline: PipelineDefinition;
  status: "running" | "completed" | "failed";
  nodes: Map<string, NodeExecution>;
  startedAt: string;
  completedAt?: string;
}

export interface NodeExecution {
  nodeId: string;
  runId?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;
  checkpoint?: CheckpointRef;
  error?: string;
  skipReason?: string;
  hydratedFromCheckpoint?: {
    pipelineRunId: string;
    nodeId: string;
  };
}

export interface CheckpointRef {
  nodeId: string;
  pipelineRunId: string;
  timestamp: string;
  branch?: string;
  commitSha?: string;
  outputDir?: string;
  outputFiles?: string[];
}

export interface ResolvedContextContent {
  name: string;
  content: string;
}

export interface ContextManifestEntry {
  sourceNodeId: string;
  path: string;
  type: "text" | "binary" | "large-text" | "deleted";
  size: number;
  changeKind: "added" | "modified" | "deleted" | "renamed";
  previousPath?: string;
}

export interface ResolvedFileArtifact {
  sourcePath: string;
  targetPath: string;
}

/** Resolved input for a node based on upstream outputs */
export interface ResolvedNodeInput {
  repo?: string;
  branch?: string;
  files: string[];
  fileArtifacts: ResolvedFileArtifact[];
  contextFiles: string[];
  contextManifestEntries: ContextManifestEntry[];
  contextContent: ResolvedContextContent[];
  upstreamBranches: string[];
}
