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

      // Only 2 children dispatched + 1 synthesis = 3 total
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(3);
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

      // 3 child dispatches + 1 synthesis call = 4 total
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(4);
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

      // executeWorkerFn called 4 times: original + rewrite + retry + synthesis
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(4);
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
    it("invokes executeWorkerFn with a synthesis prompt containing all child outcomes", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("Synthesis result text"));
      const manager = createDelegationManager(deps);
      const issue = makeIssue();
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const, stdout: "done" },
        { spec: { id: "sub-2", task: "Task 2" }, status: "failed" as const, errorMessage: "err" },
      ];

      await manager.synthesize(issue, outcomes);

      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(deps.executeWorkerFn).mock.calls[0];
      // The prompt (4th argument) should contain the parent issue title and child outcomes
      const prompt = callArgs[3];
      expect(prompt).toContain(issue.title);
      expect(prompt).toContain("sub-1");
      expect(prompt).toContain("sub-2");
      expect(prompt).toContain("COMPLETED");
      expect(prompt).toContain("FAILED");
    });

    it("returns the agent stdout as the synthesis comment text", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("## Summary\nAll done!"));
      const manager = createDelegationManager(deps);
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const },
      ];

      const result = await manager.synthesize(makeIssue(), outcomes);

      expect(result).toBe("## Summary\nAll done!");
    });

    it("runs synthesis even when some children permanently failed (partial results included)", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("Partial synthesis"));
      const manager = createDelegationManager(deps);
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const, stdout: "ok" },
        { spec: { id: "sub-2", task: "Task 2" }, status: "failed" as const, errorMessage: "boom" },
        { spec: { id: "sub-3", task: "Task 3" }, status: "failed" as const, errorMessage: "boom2" },
      ];

      const result = await manager.synthesize(makeIssue(), outcomes);

      // Should still call the agent and return something
      expect(deps.executeWorkerFn).toHaveBeenCalledTimes(1);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("returns fallback summary when agent invocation throws", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockRejectedValue(new Error("agent crashed"));
      const manager = createDelegationManager(deps);
      const issue = makeIssue();
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const },
        { spec: { id: "sub-2", task: "Task 2" }, status: "failed" as const },
      ];

      const result = await manager.synthesize(issue, outcomes);

      // Fallback must mention issue title and success/failure counts
      expect(result).toContain(issue.title);
      expect(result).toContain("1");  // 1 succeeded
      expect(result.length).toBeGreaterThan(0);
    });

    it("single postComment call after synthesis (not per-child)", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn)
        // 2 children dispatch
        .mockResolvedValueOnce(makeWorkerResult("child 1 done"))
        .mockResolvedValueOnce(makeWorkerResult("child 2 done"))
        // synthesis agent invocation
        .mockResolvedValueOnce(makeWorkerResult("Synthesis comment text"));

      const manager = createDelegationManager(deps);
      const issue = makeIssue();
      const specs = [
        { id: "sub-1", task: "Task 1" },
        { id: "sub-2", task: "Task 2" },
      ];

      await manager.runDelegation("parent-run-1", issue, specs, 0, 5);

      // postComment should be called exactly once (for synthesis)
      expect(deps.tracker.postComment).toHaveBeenCalledTimes(1);
      expect(deps.tracker.postComment).toHaveBeenCalledWith(
        issue.id,
        expect.any(String),
      );
    });
  });

  describe("buildSynthesisPrompt (via synthesize behavior)", () => {
    it("includes parent issue title in prompt", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("ok"));
      const manager = createDelegationManager(deps);
      const issue = makeIssue("iss-99");
      const outcomes = [
        { spec: { id: "s1", task: "Do something" }, status: "completed" as const, stdout: "done" },
      ];

      await manager.synthesize(issue, outcomes);

      const prompt = vi.mocked(deps.executeWorkerFn).mock.calls[0][3];
      expect(prompt).toContain(issue.title);
    });

    it("includes per-child sections with status badge in prompt", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("ok"));
      const manager = createDelegationManager(deps);
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const, stdout: "output 1" },
        { spec: { id: "sub-2", task: "Task 2" }, status: "failed" as const, errorMessage: "error output" },
      ];

      await manager.synthesize(makeIssue(), outcomes);

      const prompt = vi.mocked(deps.executeWorkerFn).mock.calls[0][3];
      expect(prompt).toContain("sub-1");
      expect(prompt).toContain("COMPLETED");
      expect(prompt).toContain("output 1");
      expect(prompt).toContain("sub-2");
      expect(prompt).toContain("FAILED");
      expect(prompt).toContain("error output");
    });

    it("uses (no output) placeholder when child has no stdout or errorMessage", async () => {
      const deps = makeDeps();
      vi.mocked(deps.executeWorkerFn).mockResolvedValue(makeWorkerResult("ok"));
      const manager = createDelegationManager(deps);
      const outcomes = [
        { spec: { id: "sub-1", task: "Task 1" }, status: "completed" as const },
      ];

      await manager.synthesize(makeIssue(), outcomes);

      const prompt = vi.mocked(deps.executeWorkerFn).mock.calls[0][3];
      expect(prompt).toContain("(no output)");
    });
  });
});
