import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PipelineDefinition,
  PipelineNode,
  NodeExecution,
  ResolvedContextContent,
  ResolvedNodeInput,
} from "./types.js";

const gitWorkflows = new Set(["code", "ops"]);

export function getWorkflowOutputMode(workflowName: string): "git" | "files" {
  return gitWorkflows.has(workflowName) ? "git" : "files";
}

/**
 * Resolve what input a node receives based on its upstream nodes' outputs.
 */
export async function resolveNodeInput(
  node: PipelineNode,
  pipeline: PipelineDefinition,
  nodeStates: Map<string, NodeExecution>,
  options: { repo?: string } = {},
): Promise<ResolvedNodeInput> {
  const downstreamWorkflow = node.workflow ?? pipeline.defaults?.workflow ?? "code";
  const downstreamMode = getWorkflowOutputMode(downstreamWorkflow);

  const result: ResolvedNodeInput = {
    repo: node.repo ?? pipeline.defaults?.repo ?? options.repo,
    files: [...(node.input ?? [])],
    contextFiles: [...(node.context ?? [])],
    contextContent: [],
    upstreamBranches: [],
  };

  const deps = node.depends_on ?? [];
  for (const depId of deps) {
    const depState = nodeStates.get(depId);
    const output = depState?.result?.output;
    if (!depState?.result?.success || !output) {
      continue;
    }

    if (output.mode === "git") {
      if (output.branch) {
        result.upstreamBranches.push(output.branch);
      }

      if (downstreamMode === "git") {
        // git -> git branch merge is handled by executor
        continue;
      }

      const repoPath = result.repo;
      if (!repoPath || !output.branch) {
        continue;
      }

      const sha = "sha" in output ? output.sha : undefined;
      const branchContext = extractChangedFilesFromBranch(repoPath, output.branch, sha);
      result.contextContent.push(
        ...branchContext.map(item => ({
          name: `${depId}/${item.name}`,
          content: item.content,
        }))
      );
      continue;
    }

    if (downstreamMode === "files") {
      for (const file of output.files) {
        result.files.push(join(output.dir, file));
      }
      continue;
    }

    for (const file of output.files) {
      const filePath = join(output.dir, file);
      if (!existsSync(filePath)) {
        continue;
      }

      try {
        result.contextContent.push({
          name: `${depId}/${file}`,
          content: readFileSync(filePath, "utf-8"),
        });
      } catch {
        // Skip non-text files or unreadable files.
      }
    }
  }

  if (result.upstreamBranches.length > 0) {
    result.branch = result.upstreamBranches[0];
  }

  return result;
}

function extractChangedFilesFromBranch(
  repoPath: string,
  branch: string,
  sha?: string,
): ResolvedContextContent[] {
  const refs = [sha, branch].filter((r): r is string => !!r);
  if (refs.length === 0) {
    return [];
  }

  const changedFiles = new Set<string>();
  for (const ref of refs) {
    try {
      const output = execFileSync("git", ["show", "--pretty=format:", "--name-only", ref], {
        cwd: repoPath,
        encoding: "utf-8",
      });
      for (const file of output.split("\n").map(s => s.trim()).filter(Boolean)) {
        changedFiles.add(file);
      }
    } catch {
      // Ignore and continue with other refs.
    }
  }

  const context: ResolvedContextContent[] = [];
  for (const file of changedFiles) {
    let content: string | null = null;

    for (const ref of refs) {
      try {
        content = execFileSync("git", ["show", `${ref}:${file}`], {
          cwd: repoPath,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 2,
        });
        break;
      } catch {
        // Try next ref/fallback.
      }
    }

    if (content === null) {
      const hostPath = join(repoPath, file);
      if (existsSync(hostPath)) {
        try {
          content = readFileSync(hostPath, "utf-8");
        } catch {
          content = null;
        }
      }
    }

    if (content !== null && content.length > 0) {
      context.push({ name: file, content });
    }
  }

  return context;
}
