import crypto from "node:crypto";
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

// ---------------------------------------------------------------------------
// DelegationManager factory
// ---------------------------------------------------------------------------

/**
 * Create a DelegationManager that handles the full child dispatch lifecycle:
 * depth cap, maxChildren budgeting, concurrent dispatch, failure retry, and
 * delegation row persistence.
 */
export function createDelegationManager(deps: DelegationDeps): DelegationManager {
  const { delegationRepo, executeWorkerFn, slotManager, config, workspaceManager, logger } = deps;

  /**
   * Dispatch a single child worker and return its ChildOutcome.
   * Inserts a delegation row with childRunId BEFORE dispatching.
   */
  async function dispatchChild(
    parentRunId: string,
    spec: SubtaskSpec,
    parentIssue: TrackerIssue,
  ): Promise<ChildOutcome> {
    const childRunId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Insert delegation row BEFORE dispatch (crash-safe)
    const row = delegationRepo.insert({
      parentRunId,
      childRunId,
      taskSpec: spec,
      status: "pending",
      createdAt,
    });

    const syntheticIssue = toSyntheticIssue(spec, parentIssue);
    const prompt = spec.task;

    let result: WorkerResult;
    try {
      result = await executeWorkerFn(
        syntheticIssue,
        config,
        workspaceManager,
        prompt,
        1,
        logger,
        undefined,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      delegationRepo.updateStatus(row.id, "failed", { errorMessage });
      return { spec, status: "failed", errorMessage };
    }

    const isSuccess = result.agentResult.status === "completed";

    if (isSuccess) {
      delegationRepo.updateStatus(row.id, "completed", {
        stdout: result.agentResult.stdout,
        branch: result.branch,
      });
      return {
        spec,
        status: "completed",
        stdout: result.agentResult.stdout,
        branch: result.branch,
      };
    }

    // Child failed — return failure info (retry handled in runDelegation)
    const errorMessage = result.agentResult.stderr || result.agentResult.stdout || "child worker failed";
    delegationRepo.updateStatus(row.id, "failed", { errorMessage });
    return { spec, status: "failed", stdout: result.agentResult.stdout, errorMessage };
  }

  return {
    parseDelegationManifest(stdout: string, _runId: string): SubtaskSpec[] | null {
      return parseDelegationManifest(stdout);
    },

    async runDelegation(
      parentRunId: string,
      parentIssue: TrackerIssue,
      specs: SubtaskSpec[],
      depth: number,
      maxChildren: number,
    ): Promise<DelegationOutcome> {
      // Depth cap: depth >= 1 means we are already inside a child worker
      if (depth >= 1) {
        logger.warn("delegation", `Delegation manifest ignored — depth cap reached (depth=${depth})`);
        return { outcomes: [], allCompleted: true };
      }

      // Delegation disabled check
      if (!slotManager.isDelegationEnabled()) {
        logger.warn("delegation", "Delegation disabled — child_slots=0");
        return { outcomes: [], allCompleted: true };
      }

      // Clamp to maxChildren
      let truncated = specs;
      if (specs.length > maxChildren) {
        logger.warn(
          "delegation",
          `Delegation manifest has ${specs.length} subtasks but maxChildren=${maxChildren}, truncating`,
        );
        truncated = specs.slice(0, maxChildren);
      }

      // Dispatch all children concurrently
      const settledResults = await Promise.allSettled(
        truncated.map((spec) => dispatchChild(parentRunId, spec, parentIssue)),
      );

      // Collect first-pass outcomes and retry failed ones
      const finalOutcomes: ChildOutcome[] = [];

      for (const settled of settledResults) {
        if (settled.status === "rejected") {
          // Unexpected rejection from dispatchChild — treat as permanent failure
          const errorMessage = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          // We can't identify the spec here; log and skip
          logger.error("delegation", `Child dispatch unexpectedly rejected: ${errorMessage}`);
          continue;
        }

        const childOutcome = settled.value;

        if (childOutcome.status === "completed") {
          finalOutcomes.push(childOutcome);
          continue;
        }

        // Child failed — attempt a rewrite and retry once
        const failureOutput = childOutcome.stdout ?? childOutcome.errorMessage ?? "";
        const rewrittenSpec = await this.rewriteFailedSubtask(
          parentIssue,
          childOutcome.spec,
          failureOutput,
        );

        if (rewrittenSpec === null) {
          // No rewrite possible — permanently failed
          finalOutcomes.push({ ...childOutcome, status: "failed" });
          continue;
        }

        // Retry with rewritten spec
        const retryOutcome = await dispatchChild(parentRunId, rewrittenSpec, parentIssue);
        finalOutcomes.push(retryOutcome);
      }

      const allCompleted = finalOutcomes.length > 0
        ? finalOutcomes.every((o) => o.status === "completed")
        : true;

      return { outcomes: finalOutcomes, allCompleted };
    },

    async rewriteFailedSubtask(
      parentIssue: TrackerIssue,
      failedSpec: SubtaskSpec,
      failureOutput: string,
    ): Promise<SubtaskSpec | null> {
      const rewritePrompt =
        `You previously decomposed issue '${parentIssue.title}' into subtasks. ` +
        `Subtask '${failedSpec.id}' failed with output: ${failureOutput}. ` +
        `Rewrite this subtask only. Output a single-item delegation manifest with the same id.`;

      let result: WorkerResult;
      try {
        result = await executeWorkerFn(
          parentIssue,
          config,
          workspaceManager,
          rewritePrompt,
          1,
          logger,
          undefined,
        );
      } catch {
        return null;
      }

      const specs = parseDelegationManifest(result.agentResult.stdout);
      if (!specs || specs.length === 0) {
        return null;
      }

      // Return the first spec (should be the rewritten one with same id)
      return specs[0];
    },

    async synthesize(
      _parentIssue: TrackerIssue,
      outcomes: ChildOutcome[],
    ): Promise<string> {
      // Stub — full implementation in Plan 03
      return `Delegation complete. ${outcomes.length} children finished.`;
    },
  };
}
