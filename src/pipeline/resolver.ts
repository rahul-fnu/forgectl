import type { PipelineDefinition, PipelineNode, NodeExecution, ResolvedNodeInput } from "./types.js";

/**
 * Resolve what input a node receives based on its upstream nodes' outputs.
 */
export async function resolveNodeInput(
  node: PipelineNode,
  pipeline: PipelineDefinition,
  nodeStates: Map<string, NodeExecution>,
): Promise<ResolvedNodeInput> {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) {
    return {
      repo: node.repo ?? pipeline.defaults?.repo,
    };
  }

  const upstreamResults = deps
    .map(depId => nodeStates.get(depId))
    .filter((s): s is NodeExecution => !!s && s.status === "completed");

  // Collect upstream branches (for git-mode piping)
  const upstreamBranches: string[] = [];
  for (const s of upstreamResults) {
    const output = s.result?.output;
    if (output && output.mode === "git") {
      upstreamBranches.push(output.branch);
    }
  }

  // Collect upstream output files (for files-mode piping)
  const upstreamFiles: string[] = [];
  for (const s of upstreamResults) {
    const output = s.result?.output;
    if (output && output.mode === "files") {
      for (const f of output.files) {
        upstreamFiles.push(`${output.dir}/${f}`);
      }
    }
  }

  // Determine piping mode from upstream nodes or explicit config
  const pipeMode = node.pipe?.mode ?? inferPipeMode(deps, pipeline);

  const result: ResolvedNodeInput = {
    repo: node.repo ?? pipeline.defaults?.repo,
  };

  switch (pipeMode) {
    case "branch":
      if (upstreamBranches.length === 1) {
        result.branch = upstreamBranches[0];
      } else if (upstreamBranches.length > 1) {
        // Multiple branches need merging — handled by executor
        result.branch = upstreamBranches[0]; // Placeholder; executor will merge
      }
      break;
    case "files":
      result.files = upstreamFiles;
      break;
    case "context":
      result.contextFiles = upstreamFiles;
      break;
  }

  return result;
}

/** Infer pipe mode from upstream nodes' workflows */
function inferPipeMode(deps: string[], pipeline: PipelineDefinition): "branch" | "files" | "context" {
  const nodeMap = new Map(pipeline.nodes.map(n => [n.id, n]));
  const workflows = deps.map(d => {
    const node = nodeMap.get(d);
    return node?.workflow ?? pipeline.defaults?.workflow ?? "code";
  });

  // If all upstream are git-mode workflows, use branch piping
  const gitWorkflows = new Set(["code", "ops"]);
  if (workflows.every(w => gitWorkflows.has(w))) {
    return "branch";
  }

  // Otherwise use file piping
  return "files";
}
