import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../../src/orchestrator/index.js";

describe("Orchestrator.addRepo", () => {
  function createMinimalOrchestrator(): Orchestrator {
    return new Orchestrator({
      tracker: { kind: "mock", fetchCandidateIssues: vi.fn(), fetchIssueStatesByIds: vi.fn(), fetchIssuesByStates: vi.fn().mockResolvedValue([]), postComment: vi.fn(), updateState: vi.fn(), updateLabels: vi.fn() } as any,
      workspaceManager: { cleanupTerminalWorkspaces: vi.fn() } as any,
      config: { orchestrator: { max_concurrent_agents: 1, poll_interval_ms: 30000, stall_timeout_ms: 600000, max_retries: 5, max_retry_backoff_ms: 300000, drain_timeout_ms: 30000, continuation_delay_ms: 1000, in_progress_label: "in-progress", child_slots: 0, enabled: false, enable_triage: false, triage_max_complexity: 7 } } as any,
      promptTemplate: "",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    });
  }

  it("returns false when addRepo callback is not set", () => {
    const orch = createMinimalOrchestrator();
    expect(orch.addRepo("owner/repo")).toBe(false);
  });

  it("delegates to registered callback", () => {
    const orch = createMinimalOrchestrator();
    const addFn = vi.fn().mockReturnValue(true);
    orch.setAddRepo(addFn);
    expect(orch.addRepo("owner/repo")).toBe(true);
    expect(addFn).toHaveBeenCalledWith("owner/repo");
  });

  it("returns false when repo already exists", () => {
    const orch = createMinimalOrchestrator();
    const addFn = vi.fn().mockReturnValue(false);
    orch.setAddRepo(addFn);
    expect(orch.addRepo("owner/repo")).toBe(false);
  });
});
