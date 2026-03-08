import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeWorkflowConfig } from "../../src/workflow/merge.js";
import { mapFrontMatterToConfig } from "../../src/workflow/map-front-matter.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkflowFileConfig, ValidatedWorkflowFile } from "../../src/workflow/types.js";
import { Orchestrator } from "../../src/orchestrator/index.js";

/**
 * Integration tests for the full watcher-reload-merge-apply pipeline.
 *
 * Tests the complete flow: WorkflowFileConfig -> mapFrontMatterToConfig ->
 * mergeWorkflowConfig -> Orchestrator.applyConfig without starting Fastify
 * or Docker. Uses real merge and map functions; only tracker, workspaceManager,
 * and logger are mocked.
 */

function getDefaults(): ForgectlConfig {
  return ConfigSchema.parse({});
}

/**
 * Simulates a daemon reload: maps front matter to config, then merges
 * with defaults, yaml, and CLI flags. Mirrors the server.ts onReload callback.
 */
function simulateReload(
  defaults: ForgectlConfig,
  yamlConfig: Partial<ForgectlConfig>,
  fm: WorkflowFileConfig,
  cliFlags: Partial<ForgectlConfig> = {},
): ForgectlConfig {
  const mapped = mapFrontMatterToConfig(fm);
  return mergeWorkflowConfig(defaults, yamlConfig, mapped, cliFlags);
}

function makeYamlConfig(overrides: Partial<ForgectlConfig> = {}): Partial<ForgectlConfig> {
  return overrides;
}

function makeMocks() {
  const logger = {
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
  return { logger, tracker, workspaceManager };
}

describe("Full reload pipeline integration", () => {
  const defaults = getDefaults();

  describe("Claude Code agent config scenarios", () => {
    it("front matter polling override merges with claude-code yaml config", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "claude-code" },
        orchestrator: {
          ...defaults.orchestrator,
          poll_interval_ms: 30000,
        },
      });
      const fm: WorkflowFileConfig = {
        polling: { interval_ms: 15000 },
      };

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.orchestrator.poll_interval_ms).toBe(15000);
      expect(merged.agent.type).toBe("claude-code");
    });

    it("front matter agent model override applies with claude-code type", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "claude-code", model: "opus" },
      });
      const fm: WorkflowFileConfig = {
        agent: { model: "sonnet" },
      };

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.agent.model).toBe("sonnet");
      expect(merged.agent.type).toBe("claude-code");
    });
  });

  describe("Codex agent config scenarios", () => {
    it("front matter concurrency and model override with codex yaml config", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "codex" },
        orchestrator: {
          ...defaults.orchestrator,
          max_concurrent_agents: 3,
        },
      });
      const fm: WorkflowFileConfig = {
        concurrency: { max_agents: 5 },
        agent: { model: "codex-mini" },
      };

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.orchestrator.max_concurrent_agents).toBe(5);
      expect(merged.agent.model).toBe("codex-mini");
      expect(merged.agent.type).toBe("codex");
    });

    it("changing agent type from claude-code to codex in front matter", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "claude-code" },
      });
      const fm: WorkflowFileConfig = {
        agent: { type: "codex" },
      };

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.agent.type).toBe("codex");
    });
  });

  describe("prompt template passthrough", () => {
    it("prompt template comes from ValidatedWorkflowFile body, not config", () => {
      const workflowFile: ValidatedWorkflowFile = {
        config: { polling: { interval_ms: 10000 } },
        promptTemplate: "Fix issue {{issue.title}} with priority {{issue.priority}}",
      };

      // Simulate what server.ts does: map config + use promptTemplate separately
      const merged = simulateReload(defaults, {}, workflowFile.config);
      const promptTemplate = workflowFile.promptTemplate;

      expect(promptTemplate).toBe("Fix issue {{issue.title}} with priority {{issue.priority}}");
      expect(merged.orchestrator.poll_interval_ms).toBe(10000);
      // promptTemplate is NOT part of ForgectlConfig — it's a separate value
      expect((merged as any).promptTemplate).toBeUndefined();
    });
  });

  describe("multiple sequential reloads", () => {
    it("each reload produces correct independent merged config", () => {
      const yaml = makeYamlConfig({
        orchestrator: {
          ...defaults.orchestrator,
          poll_interval_ms: 30000,
        },
      });

      // Reload 1: set polling to 10000
      const fm1: WorkflowFileConfig = { polling: { interval_ms: 10000 } };
      const merged1 = simulateReload(defaults, yaml, fm1);
      expect(merged1.orchestrator.poll_interval_ms).toBe(10000);

      // Reload 2: change polling to 20000
      const fm2: WorkflowFileConfig = { polling: { interval_ms: 20000 } };
      const merged2 = simulateReload(defaults, yaml, fm2);
      expect(merged2.orchestrator.poll_interval_ms).toBe(20000);

      // Reload 1 result should be unaffected (no stale state mutation)
      expect(merged1.orchestrator.poll_interval_ms).toBe(10000);
    });

    it("sequential reloads with different agent types produce correct configs", () => {
      // Reload 1: claude-code
      const fm1: WorkflowFileConfig = { agent: { type: "claude-code", model: "opus" } };
      const merged1 = simulateReload(defaults, {}, fm1);
      expect(merged1.agent.type).toBe("claude-code");
      expect(merged1.agent.model).toBe("opus");

      // Reload 2: codex
      const fm2: WorkflowFileConfig = { agent: { type: "codex", model: "gpt-4" } };
      const merged2 = simulateReload(defaults, {}, fm2);
      expect(merged2.agent.type).toBe("codex");
      expect(merged2.agent.model).toBe("gpt-4");

      // Reload 1 is still correct
      expect(merged1.agent.type).toBe("claude-code");
    });
  });

  describe("partial front matter overrides", () => {
    it("tracker-only front matter does not affect orchestrator or agent config", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "claude-code", model: "opus" },
        orchestrator: {
          ...defaults.orchestrator,
          max_concurrent_agents: 4,
          poll_interval_ms: 25000,
        },
      });
      const fm: WorkflowFileConfig = {
        tracker: { labels: ["ai-task"] },
      };

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.orchestrator.max_concurrent_agents).toBe(4);
      expect(merged.orchestrator.poll_interval_ms).toBe(25000);
      expect(merged.agent.type).toBe("claude-code");
      expect(merged.agent.model).toBe("opus");
    });

    it("empty front matter reload keeps yaml + defaults as merged config", () => {
      const yaml = makeYamlConfig({
        agent: { ...defaults.agent, type: "codex", model: "gpt-4" },
        orchestrator: {
          ...defaults.orchestrator,
          max_concurrent_agents: 7,
        },
      });
      const fm: WorkflowFileConfig = {};

      const merged = simulateReload(defaults, yaml, fm);

      expect(merged.agent.type).toBe("codex");
      expect(merged.agent.model).toBe("gpt-4");
      expect(merged.orchestrator.max_concurrent_agents).toBe(7);
    });
  });

  describe("validation config from front matter", () => {
    it("validation steps from front matter merge into config", () => {
      const fm: WorkflowFileConfig = {
        validation: {
          steps: [{ name: "lint", command: "npm run lint", retries: 3, description: "" }],
          on_failure: "abandon",
        },
      };

      const merged = simulateReload(defaults, {}, fm);

      expect((merged as any).validation).toEqual({
        steps: [{ name: "lint", command: "npm run lint", retries: 3, description: "" }],
        on_failure: "abandon",
      });
    });

    it("validation config from front matter overrides yaml validation", () => {
      const yaml = makeYamlConfig({});
      // Set validation at yaml level via deepMerge
      (yaml as any).validation = {
        steps: [{ name: "test", command: "npm test", retries: 2, description: "" }],
        on_failure: "output-wip",
      };

      const fm: WorkflowFileConfig = {
        validation: {
          steps: [{ name: "lint", command: "npm run lint", retries: 3, description: "" }],
          on_failure: "abandon",
        },
      };

      const merged = simulateReload(defaults, yaml, fm);

      // Front matter validation replaces yaml validation (arrays replaced, not merged)
      expect((merged as any).validation.on_failure).toBe("abandon");
      expect((merged as any).validation.steps).toHaveLength(1);
      expect((merged as any).validation.steps[0].name).toBe("lint");
    });
  });
});

describe("Orchestrator.applyConfig integration with reload pipeline", () => {
  let orchestrator: Orchestrator;
  let mocks: ReturnType<typeof makeMocks>;
  const defaults = getDefaults();

  beforeEach(async () => {
    mocks = makeMocks();
    const config = ConfigSchema.parse({
      orchestrator: {
        enabled: true,
        max_concurrent_agents: 3,
        poll_interval_ms: 30000,
      },
      tracker: {
        kind: "github",
        token: "fake",
        repo: "owner/repo",
      },
    });

    orchestrator = new Orchestrator({
      tracker: mocks.tracker,
      workspaceManager: mocks.workspaceManager,
      config,
      promptTemplate: "original {{issue.title}}",
      logger: mocks.logger as any,
    });

    await orchestrator.start();
  });

  afterEach(async () => {
    await orchestrator.stop();
  });

  it("applyConfig updates slot manager max from reload pipeline", () => {
    const fm: WorkflowFileConfig = { concurrency: { max_agents: 8 } };
    const merged = simulateReload(defaults, {
      orchestrator: { ...defaults.orchestrator, max_concurrent_agents: 3 },
      tracker: { kind: "github" as const, token: "fake", repo: "owner/repo", active_states: ["open"], terminal_states: ["closed"], poll_interval_ms: 60000, auto_close: false },
    }, fm);

    orchestrator.applyConfig(merged, "new template");

    expect(orchestrator.getSlotUtilization().max).toBe(8);
  });

  it("applyConfig with unchanged concurrency does not re-set max", () => {
    const fm: WorkflowFileConfig = { polling: { interval_ms: 10000 } };
    const merged = simulateReload(defaults, {
      orchestrator: { ...defaults.orchestrator, max_concurrent_agents: 3 },
      tracker: { kind: "github" as const, token: "fake", repo: "owner/repo", active_states: ["open"], terminal_states: ["closed"], poll_interval_ms: 60000, auto_close: false },
    }, fm);

    orchestrator.applyConfig(merged, "template");

    // Max stays at 3 (unchanged)
    expect(orchestrator.getSlotUtilization().max).toBe(3);
  });

  it("sequential applyConfig calls update correctly", () => {
    const yaml = {
      orchestrator: { ...defaults.orchestrator, max_concurrent_agents: 3 },
      tracker: { kind: "github" as const, token: "fake", repo: "owner/repo", active_states: ["open"], terminal_states: ["closed"], poll_interval_ms: 60000, auto_close: false },
    };

    // Reload 1: max_agents to 5
    const merged1 = simulateReload(defaults, yaml, { concurrency: { max_agents: 5 } });
    orchestrator.applyConfig(merged1, "template v1");
    expect(orchestrator.getSlotUtilization().max).toBe(5);

    // Reload 2: max_agents to 10
    const merged2 = simulateReload(defaults, yaml, { concurrency: { max_agents: 10 } });
    orchestrator.applyConfig(merged2, "template v2");
    expect(orchestrator.getSlotUtilization().max).toBe(10);
  });

  it("applyConfig logs reload message with correct values", () => {
    const fm: WorkflowFileConfig = {
      concurrency: { max_agents: 6 },
      polling: { interval_ms: 15000 },
    };
    const merged = simulateReload(defaults, {
      orchestrator: { ...defaults.orchestrator },
      tracker: { kind: "github" as const, token: "fake", repo: "owner/repo", active_states: ["open"], terminal_states: ["closed"], poll_interval_ms: 60000, auto_close: false },
    }, fm);

    orchestrator.applyConfig(merged, "template");

    expect(mocks.logger.info).toHaveBeenCalledWith(
      "orchestrator",
      expect.stringContaining("max=6"),
    );
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "orchestrator",
      expect.stringContaining("poll=15000ms"),
    );
  });
});
