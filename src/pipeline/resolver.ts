import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContextManifestEntry,
  PipelineDefinition,
  PipelineNode,
  NodeExecution,
  ResolvedNodeInput,
} from "./types.js";

const gitWorkflows = new Set(["code", "ops"]);
const MAX_INLINE_CONTEXT_BYTES = 64 * 1024;

interface GitChangeEntry {
  changeKind: "added" | "modified" | "deleted" | "renamed";
  path: string;
  previousPath?: string;
}

interface ClassifiedContext {
  type: "text" | "binary" | "large-text";
  size: number;
  inlineContent?: string;
}

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
    fileArtifacts: [],
    contextFiles: [...(node.context ?? [])],
    contextManifestEntries: [],
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

      const ref = ("sha" in output && output.sha) ? output.sha : output.branch;
      let changes = getGitChanges(repoPath, ref);
      if (changes.length === 0) {
        changes = listChangedFiles(repoPath, ref).map((path) => ({
          changeKind: "modified" as const,
          path,
        }));
      }

      for (const change of changes) {
        if (change.changeKind === "deleted") {
          result.contextManifestEntries.push({
            sourceNodeId: depId,
            path: change.path,
            previousPath: change.previousPath,
            type: "deleted",
            size: 0,
            changeKind: "deleted",
          });
          continue;
        }

        const filePath = join(repoPath, change.path);
        const classifiedFromPath = classifyContextPath(filePath);
        const classified = classifiedFromPath ?? classifyBlobFromRef(repoPath, ref, change.path);
        if (!classified) {
          result.contextManifestEntries.push({
            sourceNodeId: depId,
            path: change.path,
            previousPath: change.previousPath,
            type: "binary",
            size: 0,
            changeKind: change.changeKind,
          });
          continue;
        }

        result.contextManifestEntries.push({
          sourceNodeId: depId,
          path: change.path,
          previousPath: change.previousPath,
          type: classified.type,
          size: classified.size,
          changeKind: change.changeKind,
        });

        if (classified.type === "text" && classified.inlineContent !== undefined) {
          result.contextContent.push({
            name: `${depId}/${change.path}`,
            content: classified.inlineContent,
          });
        } else if (existsSync(filePath)) {
          result.contextFiles.push(filePath);
        }
      }

      continue;
    }

    if (downstreamMode === "files") {
      for (const file of output.files) {
        result.fileArtifacts.push({
          sourcePath: join(output.dir, file),
          targetPath: join("upstream", depId, file),
        });
      }
      continue;
    }

    for (const file of output.files) {
      const filePath = join(output.dir, file);
      const classified = classifyContextPath(filePath);
      if (!classified) {
        continue;
      }

      result.contextManifestEntries.push({
        sourceNodeId: depId,
        path: file,
        type: classified.type,
        size: classified.size,
        changeKind: "added",
      });

      if (classified.type === "text" && classified.inlineContent !== undefined) {
        result.contextContent.push({
          name: `${depId}/${file}`,
          content: classified.inlineContent,
        });
      } else {
        result.contextFiles.push(filePath);
      }
    }
  }

  if (result.upstreamBranches.length > 0) {
    result.branch = result.upstreamBranches[0];
  }

  result.contextFiles = [...new Set(result.contextFiles)];

  return result;
}

function classifyContextPath(filePath: string): ClassifiedContext | null {
  if (!existsSync(filePath)) return null;

  let data: Buffer;
  try {
    data = readFileSync(filePath);
  } catch {
    return null;
  }

  return classifyContextBuffer(data);
}

function classifyBlobFromRef(
  repoPath: string,
  ref: string,
  filePath: string,
): ClassifiedContext | null {
  try {
    const data = execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd: repoPath,
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 5,
    });
    return classifyContextBuffer(data);
  } catch {
    return null;
  }
}

function classifyContextBuffer(data: Buffer): ClassifiedContext {
  const size = data.byteLength;
  const textLike = isTextLike(data);

  if (!textLike) {
    return { type: "binary", size };
  }

  if (size > MAX_INLINE_CONTEXT_BYTES) {
    return { type: "large-text", size };
  }

  return {
    type: "text",
    size,
    inlineContent: data.toString("utf-8"),
  };
}

function isTextLike(data: Buffer): boolean {
  if (data.byteLength === 0) return true;

  const sampleSize = Math.min(data.byteLength, 4096);
  let suspicious = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = data[i];
    if (byte === 0) return false;

    const isTabOrNewline = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    if (!isTabOrNewline && !isPrintableAscii) {
      suspicious += 1;
    }
  }

  return suspicious / sampleSize < 0.15;
}

function getGitChanges(repoPath: string, ref: string): GitChangeEntry[] {
  try {
    const output = execFileSync("git", ["diff-tree", "--name-status", "-M", "-r", ref], {
      cwd: repoPath,
      encoding: "utf-8",
    });
    return parseGitNameStatus(output);
  } catch {
    return [];
  }
}

function parseGitNameStatus(output: string): GitChangeEntry[] {
  const changes: GitChangeEntry[] = [];
  for (const line of output.split("\n").map(s => s.trim()).filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const rawStatus = parts[0];
    const status = rawStatus[0];

    if (status === "R" && parts.length >= 3) {
      changes.push({
        changeKind: "renamed",
        previousPath: parts[1],
        path: parts[2],
      });
      continue;
    }

    if (status === "D") {
      changes.push({
        changeKind: "deleted",
        path: parts[1],
      });
      continue;
    }

    const changeKind: ContextManifestEntry["changeKind"] = status === "A" ? "added" : "modified";
    changes.push({
      changeKind,
      path: parts[1],
    });
  }

  return changes;
}

function listChangedFiles(repoPath: string, ref: string): string[] {
  try {
    const output = execFileSync("git", ["show", "--pretty=format:", "--name-only", ref], {
      cwd: repoPath,
      encoding: "utf-8",
    });
    return output.split("\n").map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
