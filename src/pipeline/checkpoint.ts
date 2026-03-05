import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CheckpointRef } from "./types.js";
import type { ExecutionResult } from "../orchestration/single.js";

function getCheckpointBase(): string {
  return join(homedir(), ".forgectl", "checkpoints");
}

function checkpointDir(pipelineRunId: string, nodeId: string): string {
  return join(getCheckpointBase(), pipelineRunId, nodeId);
}

/** Save a checkpoint after a successful node execution */
export async function saveCheckpoint(
  pipelineRunId: string,
  nodeId: string,
  result: ExecutionResult,
): Promise<CheckpointRef> {
  const dir = checkpointDir(pipelineRunId, nodeId);
  mkdirSync(dir, { recursive: true });

  const ref: CheckpointRef = {
    nodeId,
    pipelineRunId,
    timestamp: new Date().toISOString(),
  };

  if (result.output) {
    if (result.output.mode === "git") {
      ref.branch = result.output.branch;
      ref.commitSha = result.output.sha;
    } else {
      // Copy output files to checkpoint dir
      const outputDir = join(dir, "output");
      mkdirSync(outputDir, { recursive: true });
      if ("dir" in result.output && result.output.dir) {
        const srcDir = result.output.dir as string;
        if (existsSync(srcDir)) {
          cpSync(srcDir, outputDir, { recursive: true });
        }
      }
      ref.outputDir = outputDir;
      ref.outputFiles = [...result.output.files];
    }
  }

  writeFileSync(join(dir, "checkpoint.json"), JSON.stringify(ref, null, 2));
  return ref;
}

/** Load a checkpoint for a specific node */
export async function loadCheckpoint(
  pipelineRunId: string,
  nodeId: string,
): Promise<CheckpointRef | null> {
  const metaPath = join(checkpointDir(pipelineRunId, nodeId), "checkpoint.json");
  if (!existsSync(metaPath)) return null;
  const checkpoint = JSON.parse(readFileSync(metaPath, "utf-8")) as CheckpointRef;
  if (checkpoint.outputDir && !checkpoint.outputFiles) {
    checkpoint.outputFiles = listFilesRecursive(checkpoint.outputDir);
  }
  return checkpoint;
}

/** List all checkpoints for a pipeline run */
export async function listCheckpoints(
  pipelineRunId: string,
): Promise<CheckpointRef[]> {
  const dir = join(getCheckpointBase(), pipelineRunId);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const checkpoints: CheckpointRef[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const cp = await loadCheckpoint(pipelineRunId, entry.name);
      if (cp) checkpoints.push(cp);
    }
  }

  return checkpoints;
}

/** Revert repo/output to a checkpoint state */
export async function revertToCheckpoint(checkpoint: CheckpointRef): Promise<void> {
  if (checkpoint.branch) {
    // For git mode: user should checkout the branch manually
    // Just report what to do
    console.log(`Checkpoint branch: ${checkpoint.branch}`);
    if (checkpoint.commitSha) {
      console.log(`Checkpoint commit: ${checkpoint.commitSha}`);
    }
  } else if (checkpoint.outputDir) {
    console.log(`Checkpoint output: ${checkpoint.outputDir}`);
  }
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}
