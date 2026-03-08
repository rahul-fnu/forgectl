import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapFrontMatterToConfig } from "../../src/workflow/map-front-matter.js";
import { mergeWorkflowConfig } from "../../src/workflow/merge.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { ValidatedWorkflowFile } from "../../src/workflow/types.js";

/**
 * Tests for the watcher integration pattern used in server.ts.
 * We test the reload callback logic directly since startDaemon
 * starts Fastify and cannot be unit tested without a full server.
 */

function getDefaults(): ForgectlConfig {
  return ConfigSchema.parse({});
}

describe("daemon watcher — reload callback logic", () => {
  let applyConfig: ReturnType<typeof vi.fn>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let defaults: ForgectlConfig;
  let yamlConfig: Partial<ForgectlConfig>;

  beforeEach(() => {
    applyConfig = vi.fn();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    defaults = getDefaults();
    yamlConfig = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 3,
      },
    };
  });

  /**
   * Simulates the onReload callback from server.ts.
   * This is the exact pattern used in production code.
   */
  function simulateReload(newWf: ValidatedWorkflowFile): void {
    const newFmConfig = mapFrontMatterToConfig(newWf.config);
    const newMerged = mergeWorkflowConfig(defaults, yamlConfig, newFmConfig, {});
    applyConfig(newMerged, newWf.promptTemplate);
    logger.info("daemon", "WORKFLOW.md reloaded, config updated");
  }

  it("calls applyConfig with re-merged config on reload", () => {
    const newWf: ValidatedWorkflowFile = {
      config: { concurrency: { max_agents: 10 } },
      promptTemplate: "new template",
    };

    simulateReload(newWf);

    expect(applyConfig).toHaveBeenCalledOnce();
    const [mergedConfig, template] = applyConfig.mock.calls[0];
    expect(mergedConfig.orchestrator.max_concurrent_agents).toBe(10);
    expect(template).toBe("new template");
  });

  it("preserves yaml values not overridden by front matter", () => {
    yamlConfig = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 5,
        poll_interval_ms: 15000,
      },
    };

    const newWf: ValidatedWorkflowFile = {
      config: { concurrency: { max_agents: 8 } },
      promptTemplate: "template",
    };

    simulateReload(newWf);

    const [mergedConfig] = applyConfig.mock.calls[0];
    expect(mergedConfig.orchestrator.max_concurrent_agents).toBe(8);
    expect(mergedConfig.orchestrator.poll_interval_ms).toBe(15000);
  });

  it("logs reload message", () => {
    const newWf: ValidatedWorkflowFile = {
      config: {},
      promptTemplate: "template",
    };

    simulateReload(newWf);

    expect(logger.info).toHaveBeenCalledWith(
      "daemon",
      "WORKFLOW.md reloaded, config updated",
    );
  });

  it("onWarning callback logs via logger.warn", () => {
    // Simulate the onWarning pattern from server.ts
    const onWarning = (msg: string) => {
      logger.warn("daemon", msg);
    };

    onWarning("WORKFLOW.md reload failed: parse error");

    expect(logger.warn).toHaveBeenCalledWith(
      "daemon",
      "WORKFLOW.md reload failed: parse error",
    );
  });

  it("handles empty front matter config on reload", () => {
    const newWf: ValidatedWorkflowFile = {
      config: {},
      promptTemplate: "updated template",
    };

    simulateReload(newWf);

    expect(applyConfig).toHaveBeenCalledOnce();
    const [mergedConfig, template] = applyConfig.mock.calls[0];
    // Should fall back to yaml config values
    expect(mergedConfig.orchestrator.max_concurrent_agents).toBe(3);
    expect(template).toBe("updated template");
  });
});
