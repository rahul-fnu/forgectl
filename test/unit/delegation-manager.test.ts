import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/logger.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { WorkerResult } from "../../src/orchestrator/worker.js";
import type { DelegationRepository, DelegationRow } from "../../src/storage/repositories/delegations.js";
import type { TwoTierSlotManager } from "../../src/orchestrator/state.js";
import type { DelegationDeps } from "../../src/orchestrator/delegation.js";
import {
  createDelegationManager,
} from "../../src/orchestrator/delegation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(id = "issue-1"): TrackerIssue {
  return {
    id,
    identifier: `GH-${id}`,
    title: "Parent issue title",
    description: "Parent desc",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
  };
}

function makeWorkerResult(stdout = ""): WorkerResult {
  return {
    agentResult: {
      status: "completed",
      stdout,
      stderr: "",
      exitCode: 0,
      tokenUsage: { input: 10, output: 20, total: 30 },
    },
    comment: "Done.",
    branch: "feat/branch-1",
  };
}

function makeDelegationRow(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: 1,
    parentRunId: "parent-run-1",
    childRunId: "child-uuid-1",
    taskSpec: { id: "sub-1", task: "Do task 1" },
    status: "pending",
    result: null,
    retryCount: 0,
    lastError: null,
    createdAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeSlotManager(enabled = true): TwoTierSlotManager {
  return {
    isDelegationEnabled: vi.fn().mockReturnValue(enabled),
    hasTopLevelSlot: vi.fn().mockReturnValue(true),
    hasChildSlot: vi.fn().mockReturnValue(true),
    availableTopLevelSlots: vi.fn().mockReturnValue(3),
    availableChildSlots: vi.fn().mockReturnValue(5),
    registerTopLevel: vi.fn(),
    releaseTopLevel: vi.fn(),
    registerChild: vi.fn(),
    releaseChild: vi.fn(),
    getMax: vi.fn().mockReturnValue(8),
    getTopLevelRunning: vi.fn().mockReturnValue(new Map()),
    getChildRunning: vi.fn().mockReturnValue(new Map()),
  } as unknown as TwoTierSlotManager;
}

function makeDelegationRepo(): DelegationRepository {
  let nextId = 1;
  return {
    insert: vi.fn().mockImplementation((params) =>
      makeDelegationRow({ id: nextId++, parentRunId: params.parentRunId, childRunId: params.childRunId, taskSpec: params.taskSpec }),
    ),
    findById: vi.fn(),
    findByParentRunId: vi.fn().mockReturnValue([]),
    findByChildRunId: vi.fn(),
    updateStatus: vi.fn(),
    countByParentAndStatus: vi.fn().mockReturnValue(0),
    list: vi.fn().mockReturnValue([]),
  } as unknown as DelegationRepository;
}

function makeTracker(): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrackerAdapter;
}

function makeConfig(): ForgectlConfig {
  return {
    orchestrator: {
      enabled: true,
      max_concurrent_agents: 5,
      child_slots: 3,
      poll_interval_ms: 5000,
      stall_timeout_ms: 600000,
      max_retries: 3,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 1000,
      in_progress_label: "in-progress",
    },
  } as unknown as ForgectlConfig;
}

function makeDeps(overrides: Partial<DelegationDeps> = {}): DelegationDeps {
  return {
    delegationRepo: makeDelegationRepo(),
    executeWorkerFn: vi.fn().mockResolvedValue(makeWorkerResult()),
    slotManager: makeSlotManager(),
    tracker: makeTracker(),
    config: makeConfig(),
    workspaceManager: {} as unknown as WorkspaceManager,
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDelegationManager", () => {
  it("returns an object with the DelegationManager interface", () => {
    const manager = createDelegationManager(makeDeps());
    expect(typeof manager.parseDelegationManifest).toBe("function");
    expect(typeof manager.runDelegation).toBe("function");
    expect(typeof manager.rewriteFailedSubtask).toBe("function");
    expect(typeof manager.synthesize).toBe("function");
  });

  describe("parseDelegationManifest", () => {
    it("returns null for stdout with no sentinel", () => {
      const manager = createDelegationManager(makeDeps());
      expect(manager.parseDelegationManifest("no sentinel here", "run-1")).toBeNull();
    });

    it("parses a valid delegation manifest from stdout", () => {
      const manager = createDelegationManager(makeDeps());
      const manifest = JSON.stringify([{ id: "sub-1", task: "Do task 1" }]);
      const stdout = `Some output\n---DELEGATE---\n${manifest}\n---END-DELEGATE---\nMore output`;
      const result = manager.parseDelegationManifest(stdout, "run-1");
      expect(result).toEqual([{ id: "sub-1", task: "Do task 1" }]);
    });
  });

  describe("runDelegation - depth cap", () => {
    it("returns empty outcome when depth >= 1 (depth cap enforcement)", async () => {
      const deps = makeDeps();
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 1, 5);

      expect(outcome.outcomes).toEqual([]);
      expect(outcome.allCompleted).toBe(true);
      expect(deps.executeWorkerFn).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "delegation",
        expect.stringContaining("depth cap"),
      );
    });

    it("also returns empty when depth is 2", async () => {
      const deps = makeDeps();
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 2, 5);

      expect(outcome.outcomes).toEqual([]);
      expect(deps.executeWorkerFn).not.toHaveBeenCalled();
    });
  });

  describe("runDelegation - delegation disabled", () => {
    it("returns empty outcome when delegation is disabled (child_slots=0)", async () => {
      const deps = makeDeps({ slotManager: makeSlotManager(false) });
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(outcome.outcomes).toEqual([]);
      expect(outcome.allCompleted).toBe(true);
      expect(deps.executeWorkerFn).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "delegation",
        expect.stringContaining("disabled"),
      );
    });
  });

  describe("runDelegation - maxChildren cap", () => {
    it("truncates specs when specs.length > maxChildren", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult());
      const manager = createDelegationManager(deps);
      const specs = [
        { id: "sub-1", task: "Task 1" },
        { id: "sub-2", task: "Task 2" },
        { id: "sub-3", task: "Task 3" },
        { id: "sub-4", task: "Task 4" },
      ];

      await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 2);

      // Only 2 children dispatched
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(2);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "delegation",
        expect.stringContaining("truncating"),
      );
    });
  });

  describe("runDelegation - concurrent dispatch", () => {
    it("dispatches N children concurrently (executeWorkerFn called N times)", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult());
      const manager = createDelegationManager(deps);
      const specs = [
        { id: "sub-1", task: "Task 1" },
        { id: "sub-2", task: "Task 2" },
        { id: "sub-3", task: "Task 3" },
      ];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(3);
      expect(outcome.outcomes).toHaveLength(3);
    });

    it("sets allCompleted=true when all children succeed", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult());
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }, { id: "sub-2", task: "Task 2" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(outcome.allCompleted).toBe(true);
      expect(outcome.outcomes.every((o) => o.status === "completed")).toBe(true);
    });
  });

  describe("runDelegation - delegation row persistence", () => {
    it("inserts delegation rows with childRunId BEFORE dispatching children", async () => {
      const callOrder: string[] = [];
      const deps = makeDeps();
      vi.mocked(deps.delegationRepo.insert).mockImplementation((params) => {
        callOrder.push("insert");
        return makeDelegationRow({ parentRunId: params.parentRunId, childRunId: params.childRunId });
      });
      vi.mocked(deps.executeWorkerFn).mockImplementation(async () => {
        callOrder.push("execute");
        return makeWorkerResult();
      });
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(callOrder[0]).toBe("insert");
      expect(callOrder[1]).toBe("execute");
    });

    it("inserts delegation row with a childRunId string", async () => {
      const deps = makeDeps();
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(deps.delegationRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          parentRunId: "parent-run-1",
          childRunId: expect.any(String),
          taskSpec: expect.objectContaining({ id: "sub-1" }),
          status: "pending",
        }),
      );
    });

    it("updates delegation row to completed on child success", async () => {
      const deps = makeDeps();
      vi.mocked(deps.delegationRepo.insert).mockReturnValue(makeDelegationRow({ id: 42 }));
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("output text"));
      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(deps.delegationRepo.updateStatus).toHaveBeenCalledWith(
        42,
        "completed",
        expect.objectContaining({ stdout: "output text" }),
      );
    });
  });

  describe("runDelegation - child failure and retry", () => {
    it("calls rewriteFailedSubtask when a child fails (first attempt)", async () => {
      const deps = makeDeps();
      // First call fails
      vi.mocked(deps.executeWorkerFn)
        .mockResolvedValueOnce({
          ...makeWorkerResult(),
          agentResult: { status: "failed", stdout: "failed output", stderr: "", exitCode: 1, tokenUsage: { input: 0, output: 0, total: 0 } },
          comment: "Failed.",
        })
        // Rewrite invocation
        .mockResolvedValueOnce(makeWorkerResult(
          '---DELEGATE---\n[{"id":"sub-1","task":"Rewritten task 1"}]\n---END-DELEGATE---',
        ))
        // Retry invocation succeeds
        .mockResolvedValueOnce(makeWorkerResult("retry success"));

      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      // executeWorkerFn called 3 times: original + rewrite + retry
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(3);
      expect(outcome.outcomes[0].status).toBe("completed");
    });

    it("marks child as permanently failed when retry also fails", async () => {
      const deps = makeDeps();
      // Original fails
      const failedResult = {
        ...makeWorkerResult(),
        agentResult: { status: "failed", stdout: "failed", stderr: "", exitCode: 1, tokenUsage: { input: 0, output: 0, total: 0 } },
        comment: "Failed.",
      };
      // Rewrite invocation — returns a manifest
      const rewriteResult = makeWorkerResult(
        '---DELEGATE---\n[{"id":"sub-1","task":"Retry task"}]\n---END-DELEGATE---',
      );
      // Retry also fails
      const retryFailResult = {
        ...makeWorkerResult(),
        agentResult: { status: "failed", stdout: "retry failed", stderr: "", exitCode: 1, tokenUsage: { input: 0, output: 0, total: 0 } },
        comment: "Retry failed.",
      };

      vi.mocked(deps.executeWorkerFn)
        .mockResolvedValueOnce(failedResult)
        .mockResolvedValueOnce(rewriteResult)
        .mockResolvedValueOnce(retryFailResult);

      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(outcome.outcomes[0].status).toBe("failed");
      expect(outcome.allCompleted).toBe(false);
    });

    it("marks child as permanently failed when rewriteFailedSubtask returns null", async () => {
      const deps = makeDeps();
      // Original fails
      vi.mocked(deps.executeWorkerFn)
        .mockResolvedValueOnce({
          ...makeWorkerResult(),
          agentResult: { status: "failed", stdout: "err", stderr: "", exitCode: 1, tokenUsage: { input: 0, output: 0, total: 0 } },
          comment: "Failed.",
        })
        // Rewrite agent returns no manifest
        .mockResolvedValueOnce(makeWorkerResult("no manifest here"));

      const manager = createDelegationManager(deps);
      const specs = [{ id: "sub-1", task: "Task 1" }];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(outcome.outcomes[0].status).toBe("failed");
      expect(outcome.allCompleted).toBe(false);
    });

    it("collects all outcomes even when some children fail", async () => {
      const deps = makeDeps();
      const failResult = {
        ...makeWorkerResult(),
        agentResult: { status: "failed", stdout: "", stderr: "", exitCode: 1, tokenUsage: { input: 0, output: 0, total: 0 } },
        comment: "Failed.",
      };

      // sub-1 succeeds, sub-2 fails (no rewrite manifest), sub-3 succeeds
      vi.mocked(deps.executeWorkerFn)
        .mockResolvedValueOnce(makeWorkerResult("success-1")) // sub-1 succeeds
        .mockResolvedValueOnce(failResult)                    // sub-2 fails
        .mockResolvedValueOnce(makeWorkerResult("no manifest")) // sub-2 rewrite returns null
        .mockResolvedValueOnce(makeWorkerResult("success-3")); // sub-3 succeeds

      const manager = createDelegationManager(deps);
      const specs = [
        { id: "sub-1", task: "Task 1" },
        { id: "sub-2", task: "Task 2" },
        { id: "sub-3", task: "Task 3" },
      ];

      const outcome = await manager.runDelegation("parent-run-1", makeIssue(), specs, 0, 5);

      expect(outcome.outcomes).toHaveLength(3);
      expect(outcome.outcomes.find((o) => o.spec.id === "sub-1")?.status).toBe("completed");
      expect(outcome.outcomes.find((o) => o.spec.id === "sub-2")?.status).toBe("failed");
      expect(outcome.outcomes.find((o) => o.spec.id === "sub-3")?.status).toBe("completed");
      expect(outcome.allCompleted).toBe(false);
    });
  });

  describe("rewriteFailedSubtask", () => {
    it("returns null when agent invocation fails", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockRejectedValue(new Error("agent error"));
      const manager = createDelegationManager(deps);

      const result = await manager.rewriteFailedSubtask(
        makeIssue(),
        { id: "sub-1", task: "Task 1" },
        "failure output",
      );

      expect(result).toBeNull();
    });

    it("returns null when agent returns no manifest", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("no manifest here"));
      const manager = createDelegationManager(deps);

      const result = await manager.rewriteFailedSubtask(
        makeIssue(),
        { id: "sub-1", task: "Task 1" },
        "failure output",
      );

      expect(result).toBeNull();
    });

    it("returns the SubtaskSpec when agent outputs a valid manifest", async () => {
      const deps = makeDeps();
      const rewrittenManifest = JSON.stringify([{ id: "sub-1", task: "Rewritten task 1" }]);
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(
        makeWorkerResult(`---DELEGATE---\n${rewrittenManifest}\n---END-DELEGATE---`),
      );
      const manager = createDelegationManager(deps);

      const result = await manager.rewriteFailedSubtask(
        makeIssue(),
        { id: "sub-1", task: "Task 1" },
        "failure output",
      );

      expect(result).toEqual({ id: "sub-1", task: "Rewritten task 1" });
    });
  });

  describe("synthesize", () => {
    it("returns a placeholder string with child count", async () => {
      const manager = createDelegationManager(makeDeps());
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const },
        { spec: { id: "sub-2", task: "Task 2" }, status: "failed" as const },
      ];

      const summary = await manager.synthesize(makeIssue(), outcomes);

      expect(summary).toContain("2");
      expect(typeof summary).toBe("string");
    });
  });
});
