import { z } from "zod";
import type { TrackerIssue, TrackerAdapter } from "../tracker/types.js";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { WorkerResult } from "./worker.js";
import type { DelegationRepository } from "../storage/repositories/delegations.js";
import type { TwoTierSlotManager } from "./state.js";

// ---------------------------------------------------------------------------
// Schemas and types
// ---------------------------------------------------------------------------

/**
 * Schema for a single subtask spec emitted by an agent delegation manifest.
 */
export const SubtaskSpecSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  workflow: z.string().optional(),
  agent: z.string().optional(),
});

/**
 * Schema for a delegation manifest — an array of subtask specs, minimum 1.
 */
export const DelegationManifestSchema = z.array(SubtaskSpecSchema).min(1);

/**
 * A single subtask specification parsed from an agent's delegation manifest.
 */
export type SubtaskSpec = z.infer<typeof SubtaskSpecSchema>;

// ---------------------------------------------------------------------------
// Sentinel parsing
// ---------------------------------------------------------------------------

/**
 * Regex that matches the first ---DELEGATE--- ... ---END-DELEGATE--- block.
 * Non-greedy so that only the first block is captured when multiple exist.
 */
const SENTINEL_RE = /---DELEGATE---\s*([\s\S]*?)\s*---END-DELEGATE---/;

/**
 * Parse an agent's stdout for a delegation manifest.
 * Returns the array of SubtaskSpec on success, or null on any failure
 * (no sentinel, malformed JSON, schema mismatch, empty array).
 */
export function parseDelegationManifest(stdout: string): SubtaskSpec[] | null {
  const match = SENTINEL_RE.exec(stdout);
  if (!match) {
    return null;
  }

  const jsonStr = match[1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const result = DelegationManifestSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/**
 * Outcome of a single child subtask execution.
 */
export interface ChildOutcome {
  spec: SubtaskSpec;
  status: "completed" | "failed";
  stdout?: string;
  errorMessage?: string;
  branch?: string;
}

/**
 * Aggregated outcome of a delegation run (all children).
 */
export interface DelegationOutcome {
  outcomes: ChildOutcome[];
  allCompleted: boolean;
}

// ---------------------------------------------------------------------------
// Dependency and interface types
// ---------------------------------------------------------------------------

/**
 * Dependency bag for the DelegationManager factory (created in Plan 02).
 */
export interface DelegationDeps {
  delegationRepo: DelegationRepository;
  executeWorkerFn: (
    issue: TrackerIssue,
    config: ForgectlConfig,
    wsManager: WorkspaceManager,
    prompt: string,
    attempt: number,
    logger: Logger,
    onActivity?: () => void,
  ) => Promise<WorkerResult>;
  slotManager: TwoTierSlotManager;
  /** For posting aggregate synthesis comment to the parent issue. */
  tracker: TrackerAdapter;
  config: ForgectlConfig;
  workspaceManager: WorkspaceManager;
  logger: Logger;
}

/**
 * Interface for the DelegationManager (implementation in Plan 02).
 */
export interface DelegationManager {
  parseDelegationManifest(stdout: string, runId: string): SubtaskSpec[] | null;
  runDelegation(
    parentRunId: string,
    parentIssue: TrackerIssue,
    specs: SubtaskSpec[],
    depth: number,
    maxChildren: number,
  ): Promise<DelegationOutcome>;
  rewriteFailedSubtask(
    parentIssue: TrackerIssue,
    failedSpec: SubtaskSpec,
    failureOutput: string,
  ): Promise<SubtaskSpec | null>;
  synthesize(
    parentIssue: TrackerIssue,
    outcomes: ChildOutcome[],
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Create a synthetic TrackerIssue shim for dispatching a child subtask.
 * The child inherits metadata from the parent, with a compound ID and identifier.
 */
export function toSyntheticIssue(
  spec: SubtaskSpec,
  parentIssue: TrackerIssue,
): TrackerIssue {
  return {
    ...parentIssue,
    id: `${parentIssue.id}:${spec.id}`,
    identifier: `${parentIssue.identifier}/${spec.id}`,
    title: spec.task,
    description: spec.task,
    metadata: {
      ...parentIssue.metadata,
      delegationParentId: parentIssue.id,
      delegationSpecId: spec.id,
    },
  };
}
