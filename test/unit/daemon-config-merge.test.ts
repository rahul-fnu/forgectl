import { describe, it, expect } from "vitest";
import { mergeWorkflowConfig } from "../../src/workflow/merge.js";
import { mapFrontMatterToConfig } from "../../src/workflow/map-front-matter.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkflowFileConfig } from "../../src/workflow/types.js";

function getDefaults(): ForgectlConfig {
  return ConfigSchema.parse({});
}

describe("daemon config merge — four-layer priority", () => {
  it("defaults produce valid config with orchestrator defaults", () => {
    const defaults = getDefaults();
    const merged = mergeWorkflowConfig(defaults, {}, {}, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(3);
    expect(merged.orchestrator.poll_interval_ms).toBe(3600000);
  });

  it("yaml overrides defaults", () => {
    const defaults = getDefaults();
    const yaml: Partial<ForgectlConfig> = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 5,
      },
    };
    const merged = mergeWorkflowConfig(defaults, yaml, {}, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(5);
  });

  it("front matter overrides yaml", () => {
    const defaults = getDefaults();
    const yaml: Partial<ForgectlConfig> = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 5,
        poll_interval_ms: 20000,
      },
    };
    const fm: WorkflowFileConfig = {
      concurrency: { max_agents: 8 },
    };
    const fmConfig = mapFrontMatterToConfig(fm);
    const merged = mergeWorkflowConfig(defaults, yaml, fmConfig, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(8);
    // poll_interval_ms from yaml should persist since fm didn't set it
    expect(merged.orchestrator.poll_interval_ms).toBe(20000);
  });

  it("empty front matter leaves yaml values intact", () => {
    const defaults = getDefaults();
    const yaml: Partial<ForgectlConfig> = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 7,
      },
    };
    const fmConfig = mapFrontMatterToConfig({});
    const merged = mergeWorkflowConfig(defaults, yaml, fmConfig, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(7);
  });

  it("polling.interval_ms from front matter maps to orchestrator.poll_interval_ms", () => {
    const defaults = getDefaults();
    const fm: WorkflowFileConfig = {
      polling: { interval_ms: 5000 },
    };
    const fmConfig = mapFrontMatterToConfig(fm);
    const merged = mergeWorkflowConfig(defaults, {}, fmConfig, {});
    expect(merged.orchestrator.poll_interval_ms).toBe(5000);
  });

  it("concurrency.max_agents from front matter maps to orchestrator.max_concurrent_agents", () => {
    const defaults = getDefaults();
    const fm: WorkflowFileConfig = {
      concurrency: { max_agents: 12 },
    };
    const fmConfig = mapFrontMatterToConfig(fm);
    const merged = mergeWorkflowConfig(defaults, {}, fmConfig, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(12);
  });

  it("CLI flags override everything (placeholder with empty object)", () => {
    const defaults = getDefaults();
    const yaml: Partial<ForgectlConfig> = {
      orchestrator: {
        ...defaults.orchestrator,
        max_concurrent_agents: 5,
      },
    };
    const fm: WorkflowFileConfig = {
      concurrency: { max_agents: 8 },
    };
    const fmConfig = mapFrontMatterToConfig(fm);
    // CLI flags would override here, but currently empty
    const merged = mergeWorkflowConfig(defaults, yaml, fmConfig, {});
    expect(merged.orchestrator.max_concurrent_agents).toBe(8);
  });
});
