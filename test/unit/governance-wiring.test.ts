import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TickDeps } from "../../src/orchestrator/scheduler.js";
import type { GovernanceOpts } from "../../src/orchestrator/dispatcher.js";
import type { OrchestratorState } from "../../src/orchestrator/state.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { RunRepository } from "../../src/storage/repositories/runs.js";

// Mock dispatcher module to capture governance argument
vi.mock("../../src/orchestrator/dispatcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestrator/dispatcher.js")>();
  return {
    ...actual,
    filterCandidates: vi.fn().mockReturnValue([]),
    sortCandidates: vi.fn().mockReturnValue([]),
    dispatchIssue: vi.fn(),
  };
});

// Mock reconciler to avoid real tracker calls
vi.mock("../../src/orchestrator/reconciler.js", () => ({
  reconcile: vi.fn().mockResolvedValue(undefined),
}));

describe("Governance wiring", () => {
  const mockRunRepo = { insert: vi.fn(), findById: vi.fn() } as unknown as RunRepository;
  const mockIssue = {
    id: "1",
    identifier: "test/repo#1",
    title: "Test",
    description: "",
    state: "open",
    priority: null,
    labels: [],
    blocked_by: [],
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("scheduler tick governance wiring", () => {
    it("passes GovernanceOpts to dispatchIssue when runRepo is in TickDeps", async () => {
      const { tick } = await import("../../src/orchestrator/scheduler.js");
      const { filterCandidates, sortCandidates, dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      // Setup mocks to produce one candidate
      vi.mocked(filterCandidates).mockReturnValue([mockIssue as any]);
      vi.mocked(sortCandidates).mockReturnValue([mockIssue as any]);

      const deps: TickDeps = {
        state: { claimed: new Set(), running: new Map(), retryTimers: new Map(), retryAttempts: new Map(), issueBranches: new Map(), recentlyCompleted: new Map() } as OrchestratorState,
        tracker: {
          fetchCandidateIssues: vi.fn().mockResolvedValue([mockIssue]),
          fetchIssuesByStates: vi.fn().mockResolvedValue([]),
          updateLabels: vi.fn().mockResolvedValue(undefined),
          updateState: vi.fn().mockResolvedValue(undefined),
          postComment: vi.fn().mockResolvedValue(undefined),
        } as any,
        workspaceManager: {} as any,
        slotManager: { availableTopLevelSlots: vi.fn().mockReturnValue(3) } as any,
        config: { tracker: { terminal_states: [] }, orchestrator: { poll_interval_ms: 1000 } } as unknown as ForgectlConfig,
        promptTemplate: "test",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        metrics: { recordDispatch: vi.fn(), recordCompletion: vi.fn() } as any,
        runRepo: mockRunRepo,
        autonomy: "semi",
        autoApprove: { max_cost: 10 },
      };

      await tick(deps);

      expect(dispatchIssue).toHaveBeenCalledOnce();
      const args = vi.mocked(dispatchIssue).mock.calls[0];
      const governance = args[8] as GovernanceOpts;
      expect(governance).toBeDefined();
      expect(governance.autonomy).toBe("semi");
      expect(governance.runRepo).toBe(mockRunRepo);
      expect(governance.autoApprove).toEqual({ max_cost: 10 });
    });

    it("does NOT pass GovernanceOpts when runRepo is absent", async () => {
      const { tick } = await import("../../src/orchestrator/scheduler.js");
      const { filterCandidates, sortCandidates, dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      vi.mocked(filterCandidates).mockReturnValue([mockIssue as any]);
      vi.mocked(sortCandidates).mockReturnValue([mockIssue as any]);

      const deps: TickDeps = {
        state: { claimed: new Set(), running: new Map(), retryTimers: new Map(), retryAttempts: new Map(), issueBranches: new Map(), recentlyCompleted: new Map() } as OrchestratorState,
        tracker: {
          fetchCandidateIssues: vi.fn().mockResolvedValue([mockIssue]),
          fetchIssuesByStates: vi.fn().mockResolvedValue([]),
          updateLabels: vi.fn().mockResolvedValue(undefined),
          updateState: vi.fn().mockResolvedValue(undefined),
          postComment: vi.fn().mockResolvedValue(undefined),
        } as any,
        workspaceManager: {} as any,
        slotManager: { availableTopLevelSlots: vi.fn().mockReturnValue(3) } as any,
        config: { tracker: { terminal_states: [] }, orchestrator: { poll_interval_ms: 1000 } } as unknown as ForgectlConfig,
        promptTemplate: "test",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        metrics: { recordDispatch: vi.fn(), recordCompletion: vi.fn() } as any,
        // No runRepo, autonomy, autoApprove
      };

      await tick(deps);

      expect(dispatchIssue).toHaveBeenCalledOnce();
      const args = vi.mocked(dispatchIssue).mock.calls[0];
      const governance = args[8];
      expect(governance).toBeUndefined();
    });
  });

  describe("Orchestrator.dispatchIssue governance wiring", () => {
    it("builds GovernanceOpts from internal config when runRepo is set", async () => {
      const { Orchestrator } = await import("../../src/orchestrator/index.js");
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      const orch = new Orchestrator({
        tracker: {
          fetchCandidateIssues: vi.fn().mockResolvedValue([]),
          fetchIssuesByStates: vi.fn().mockResolvedValue([]),
          updateLabels: vi.fn().mockResolvedValue(undefined),
          updateState: vi.fn().mockResolvedValue(undefined),
          postComment: vi.fn().mockResolvedValue(undefined),
        } as any,
        workspaceManager: {} as any,
        config: {
          orchestrator: { max_concurrent_agents: 3, poll_interval_ms: 30000, drain_timeout_ms: 5000 },
          tracker: { terminal_states: [] },
          agent: { usage_limit: { enabled: false } },
        } as unknown as ForgectlConfig,
        promptTemplate: "test",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        runRepo: mockRunRepo,
        autonomy: "interactive",
        autoApprove: { label: "safe" },
      });

      // Start orchestrator to set running = true
      await orch.start();

      orch.dispatchIssue(mockIssue as any);

      // Stop scheduler to avoid leaking timers
      await orch.stop();

      expect(dispatchIssue).toHaveBeenCalled();
      const lastCall = vi.mocked(dispatchIssue).mock.calls.at(-1)!;
      const governance = lastCall[8] as GovernanceOpts;
      expect(governance).toBeDefined();
      expect(governance.autonomy).toBe("interactive");
      expect(governance.autoApprove).toEqual({ label: "safe" });
      expect(governance.runRepo).toBe(mockRunRepo);
    });

    it("works without governance when no runRepo", async () => {
      const { Orchestrator } = await import("../../src/orchestrator/index.js");
      const { dispatchIssue } = await import("../../src/orchestrator/dispatcher.js");

      const orch = new Orchestrator({
        tracker: {
          fetchCandidateIssues: vi.fn().mockResolvedValue([]),
          fetchIssuesByStates: vi.fn().mockResolvedValue([]),
          updateLabels: vi.fn().mockResolvedValue(undefined),
          updateState: vi.fn().mockResolvedValue(undefined),
          postComment: vi.fn().mockResolvedValue(undefined),
        } as any,
        workspaceManager: {} as any,
        config: {
          orchestrator: { max_concurrent_agents: 3, poll_interval_ms: 30000, drain_timeout_ms: 5000 },
          tracker: { terminal_states: [] },
          agent: { usage_limit: { enabled: false } },
        } as unknown as ForgectlConfig,
        promptTemplate: "test",
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        // No runRepo
      });

      await orch.start();
      orch.dispatchIssue(mockIssue as any);
      await orch.stop();

      const lastCall = vi.mocked(dispatchIssue).mock.calls.at(-1)!;
      const governance = lastCall[8];
      expect(governance).toBeUndefined();
    });
  });

  describe("resolveRunPlan workflow overrides", () => {
    it("applies workflow overrides for autonomy", async () => {
      const { resolveRunPlan } = await import("../../src/workflow/resolver.js");
      const { ConfigSchema } = await import("../../src/config/schema.js");

      const config = ConfigSchema.parse({});
      const plan = resolveRunPlan(config, { task: "test task" }, { autonomy: "semi" });

      expect(plan.workflow.autonomy).toBe("semi");
    });

    it("applies workflow overrides for auto_approve", async () => {
      const { resolveRunPlan } = await import("../../src/workflow/resolver.js");
      const { ConfigSchema } = await import("../../src/config/schema.js");

      const config = ConfigSchema.parse({});
      const plan = resolveRunPlan(config, { task: "test task" }, { auto_approve: { max_cost: 5 } });

      expect(plan.workflow.auto_approve).toEqual({ max_cost: 5 });
    });

    it("returns default autonomy when no overrides", async () => {
      const { resolveRunPlan } = await import("../../src/workflow/resolver.js");
      const { ConfigSchema } = await import("../../src/config/schema.js");

      const config = ConfigSchema.parse({});
      const plan = resolveRunPlan(config, { task: "test task" });

      expect(plan.workflow.autonomy).toBe("full");
    });
  });
});
