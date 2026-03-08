import { describe, it, expect } from "vitest";
import { mergeWorkflowConfig } from "../../src/workflow/merge.js";
import { ConfigSchema, type ForgectlConfig } from "../../src/config/schema.js";

describe("mergeWorkflowConfig", () => {
  const defaults = ConfigSchema.parse({});

  it("returns defaults unchanged when all overrides are empty", () => {
    const result = mergeWorkflowConfig(defaults, {}, {}, {});
    expect(result).toEqual(defaults);
  });

  it("applies forgectl.yaml overrides", () => {
    const result = mergeWorkflowConfig(
      defaults,
      { agent: { model: "gpt-4" } } as Partial<ForgectlConfig>,
      {},
      {},
    );
    expect(result.agent.model).toBe("gpt-4");
    // Other defaults preserved
    expect(result.agent.type).toBe("claude-code");
  });

  it("WORKFLOW.md overrides forgectl.yaml", () => {
    const result = mergeWorkflowConfig(
      defaults,
      { agent: { model: "gpt-4" } } as Partial<ForgectlConfig>,
      { agent: { model: "claude-3" } } as Partial<ForgectlConfig>,
      {},
    );
    expect(result.agent.model).toBe("claude-3");
  });

  it("CLI overrides WORKFLOW.md", () => {
    const result = mergeWorkflowConfig(
      defaults,
      {},
      { agent: { model: "claude-3" } } as Partial<ForgectlConfig>,
      { agent: { model: "opus" } } as Partial<ForgectlConfig>,
    );
    expect(result.agent.model).toBe("opus");
  });

  it("CLI wins over all layers", () => {
    const result = mergeWorkflowConfig(
      defaults,
      { agent: { model: "gpt-4" } } as Partial<ForgectlConfig>,
      { agent: { model: "claude-3" } } as Partial<ForgectlConfig>,
      { agent: { model: "opus" } } as Partial<ForgectlConfig>,
    );
    expect(result.agent.model).toBe("opus");
  });

  it("merges tracker overrides from WORKFLOW.md into base tracker config", () => {
    const withTracker = ConfigSchema.parse({
      tracker: { kind: "github", repo: "owner/repo", token: "$GH_TOKEN" },
    });
    const result = mergeWorkflowConfig(
      withTracker,
      {},
      { tracker: { auto_close: true } } as Partial<ForgectlConfig>,
      {},
    );
    expect(result.tracker?.auto_close).toBe(true);
    expect(result.tracker?.kind).toBe("github");
    expect(result.tracker?.repo).toBe("owner/repo");
  });

  it("applies polling.interval_ms from WORKFLOW.md to output config", () => {
    const result = mergeWorkflowConfig(
      defaults,
      {},
      { output: { dir: "/custom/output" } } as Partial<ForgectlConfig>,
      {},
    );
    expect(result.output.dir).toBe("/custom/output");
  });

  it("replaces arrays (not merges) per deepMerge semantics", () => {
    const result = mergeWorkflowConfig(
      defaults,
      { repo: { exclude: ["custom/"] } } as Partial<ForgectlConfig>,
      {},
      {},
    );
    expect(result.repo.exclude).toEqual(["custom/"]);
    // Should not contain any default excludes
    expect(result.repo.exclude).not.toContain("node_modules/");
  });
});
