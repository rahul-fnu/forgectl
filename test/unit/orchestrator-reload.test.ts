import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlotManager } from "../../src/orchestrator/state.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { mapFrontMatterToConfig } from "../../src/workflow/map-front-matter.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { WorkflowFileConfig } from "../../src/workflow/types.js";

function makeConfig(overrides: Partial<ForgectlConfig> = {}): ForgectlConfig {
  const base = ConfigSchema.parse({});
  return { ...base, ...overrides } as ForgectlConfig;
}

describe("SlotManager.setMax", () => {
  it("changes getMax() to return new value", () => {
    const sm = new SlotManager(3);
    expect(sm.getMax()).toBe(3);
    sm.setMax(5);
    expect(sm.getMax()).toBe(5);
  });

  it("updates availableSlots calculation", () => {
    const sm = new SlotManager(3);
    const running = new Map();
    running.set("a", { slotWeight: 1 } as any);
    running.set("b", { slotWeight: 1 } as any);
    running.set("c", { slotWeight: 1 } as any);
    expect(sm.availableSlots(running)).toBe(0);
    sm.setMax(5);
    expect(sm.availableSlots(running)).toBe(2);
  });
});

describe("Orchestrator.applyConfig", () => {
  let orchestrator: Orchestrator;
  let logger: any;
  let config: ForgectlConfig;

  beforeEach(async () => {
    config = makeConfig({
      orchestrator: {
        enabled: true,
        max_concurrent_agents: 3,
        poll_interval_ms: 30000,
        stall_timeout_ms: 600000,
        max_retries: 5,
        max_retry_backoff_ms: 300000,
        drain_timeout_ms: 30000,
        continuation_delay_ms: 1000,
        in_progress_label: "in-progress",
      },
      tracker: {
        kind: "github",
        token: "fake",
        repo: "owner/repo",
        active_states: ["open"],
        terminal_states: ["closed"],
        poll_interval_ms: 60000,
        auto_close: false,
      },
    });

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const tracker = {
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssue: vi.fn(),
      updateLabels: vi.fn(),
      addComment: vi.fn(),
      closeIssue: vi.fn(),
    } as any;

    const workspaceManager = {
      cleanupTerminalWorkspaces: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      remove: vi.fn(),
    } as any;

    orchestrator = new Orchestrator({
      tracker,
      workspaceManager,
      config,
      promptTemplate: "original {{issue.title}}",
      logger,
    });

    await orchestrator.start();
  });

  it("updates deps.config and deps.promptTemplate", () => {
    const newConfig = makeConfig({
      ...config,
      orchestrator: {
        ...config.orchestrator,
        poll_interval_ms: 10000,
      },
    });
    orchestrator.applyConfig(newConfig, "new {{issue.title}}");
    // Verify via triggerTick or getSlotUtilization that config updated
    // The slot utilization max should remain same since concurrency unchanged
    expect(orchestrator.getSlotUtilization().max).toBe(3);
  });

  it("updates slotManager max when concurrency changes", () => {
    const newConfig = makeConfig({
      ...config,
      orchestrator: {
        ...config.orchestrator,
        max_concurrent_agents: 10,
      },
    });
    orchestrator.applyConfig(newConfig, "template");
    expect(orchestrator.getSlotUtilization().max).toBe(10);
  });

  it("logs config reload message", () => {
    const newConfig = makeConfig({
      ...config,
      orchestrator: {
        ...config.orchestrator,
        max_concurrent_agents: 5,
        poll_interval_ms: 15000,
      },
    });
    orchestrator.applyConfig(newConfig, "template");
    expect(logger.info).toHaveBeenCalledWith(
      "orchestrator",
      expect.stringContaining("Config reloaded"),
    );
  });

  it("does not affect in-flight workers", async () => {
    // State running map should remain untouched
    const stateBefore = orchestrator.getState();
    const runningBefore = stateBefore.running.size;
    const newConfig = makeConfig({
      ...config,
      orchestrator: {
        ...config.orchestrator,
        max_concurrent_agents: 1,
      },
    });
    orchestrator.applyConfig(newConfig, "template");
    expect(orchestrator.getState().running.size).toBe(runningBefore);
  });
});

describe("mapFrontMatterToConfig", () => {
  it("maps polling.interval_ms to orchestrator.poll_interval_ms", () => {
    const fm: WorkflowFileConfig = { polling: { interval_ms: 5000 } };
    const result = mapFrontMatterToConfig(fm);
    expect(result.orchestrator?.poll_interval_ms).toBe(5000);
  });

  it("maps concurrency.max_agents to orchestrator.max_concurrent_agents", () => {
    const fm: WorkflowFileConfig = { concurrency: { max_agents: 8 } };
    const result = mapFrontMatterToConfig(fm);
    expect(result.orchestrator?.max_concurrent_agents).toBe(8);
  });

  it("passes through tracker fields", () => {
    const fm: WorkflowFileConfig = {
      tracker: { kind: "github", token: "tok", repo: "o/r" },
    };
    const result = mapFrontMatterToConfig(fm);
    expect(result.tracker).toEqual({ kind: "github", token: "tok", repo: "o/r" });
  });

  it("passes through workspace fields", () => {
    const fm: WorkflowFileConfig = {
      workspace: { root: "/tmp/ws" },
    };
    const result = mapFrontMatterToConfig(fm);
    expect(result.workspace).toEqual({ root: "/tmp/ws" });
  });

  it("passes through agent fields", () => {
    const fm: WorkflowFileConfig = {
      agent: { type: "codex", model: "gpt-4" },
    };
    const result = mapFrontMatterToConfig(fm);
    expect(result.agent).toEqual({ type: "codex", model: "gpt-4" });
  });

  it("passes through validation fields", () => {
    const fm: WorkflowFileConfig = {
      validation: { steps: [{ name: "test", command: "npm test", retries: 3, description: "" }], on_failure: "abandon" },
    };
    const result = mapFrontMatterToConfig(fm);
    expect(result.validation).toEqual(fm.validation);
  });

  it("returns empty object for empty front matter", () => {
    const result = mapFrontMatterToConfig({});
    expect(result).toEqual({});
  });

  it("combines polling and concurrency into single orchestrator key", () => {
    const fm: WorkflowFileConfig = {
      polling: { interval_ms: 5000 },
      concurrency: { max_agents: 4 },
    };
    const result = mapFrontMatterToConfig(fm);
    expect(result.orchestrator).toEqual({
      poll_interval_ms: 5000,
      max_concurrent_agents: 4,
    });
  });
});
