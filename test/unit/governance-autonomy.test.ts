import { describe, it, expect } from "vitest";
import { WorkflowSchema } from "../../src/config/schema.js";
import { needsPreApproval, needsPostApproval } from "../../src/governance/autonomy.js";
import type { WorkflowFileConfig } from "../../src/workflow/types.js";
import { mapFrontMatterToConfig } from "../../src/workflow/map-front-matter.js";

describe("WorkflowSchema autonomy field", () => {
  const base = { name: "test", container: { image: "x" } };

  it("defaults autonomy to 'full' when not specified", () => {
    const result = WorkflowSchema.parse(base);
    expect(result.autonomy).toBe("full");
  });

  it("accepts 'full' autonomy", () => {
    const result = WorkflowSchema.parse({ ...base, autonomy: "full" });
    expect(result.autonomy).toBe("full");
  });

  it("accepts 'interactive' autonomy", () => {
    const result = WorkflowSchema.parse({ ...base, autonomy: "interactive" });
    expect(result.autonomy).toBe("interactive");
  });

  it("accepts 'semi' autonomy", () => {
    const result = WorkflowSchema.parse({ ...base, autonomy: "semi" });
    expect(result.autonomy).toBe("semi");
  });

  it("accepts 'supervised' autonomy", () => {
    const result = WorkflowSchema.parse({ ...base, autonomy: "supervised" });
    expect(result.autonomy).toBe("supervised");
  });

  it("rejects invalid autonomy value", () => {
    expect(() => WorkflowSchema.parse({ ...base, autonomy: "invalid" })).toThrow();
  });

  it("preserves existing workflow parsing when autonomy is absent", () => {
    const withoutAutonomy = WorkflowSchema.parse(base);
    // All existing defaults should still be present
    expect(withoutAutonomy.name).toBe("test");
    expect(withoutAutonomy.description).toBe("");
    expect(withoutAutonomy.tools).toEqual([]);
    expect(withoutAutonomy.system).toBe("");
    expect(withoutAutonomy.validation).toEqual({ steps: [], on_failure: "abandon" });
    expect(withoutAutonomy.output).toEqual({ mode: "git", path: "/workspace", collect: [] });
    expect(withoutAutonomy.review).toEqual({ enabled: false, system: "" });
  });
});

describe("WorkflowSchema auto_approve field", () => {
  const base = { name: "test", container: { image: "x" } };

  it("accepts auto_approve with all fields", () => {
    const result = WorkflowSchema.parse({
      ...base,
      auto_approve: { label: "safe", workflow_pattern: "docs-*", max_cost: 0.5 },
    });
    expect(result.auto_approve).toEqual({ label: "safe", workflow_pattern: "docs-*", max_cost: 0.5 });
  });

  it("accepts auto_approve with only label", () => {
    const result = WorkflowSchema.parse({
      ...base,
      auto_approve: { label: "safe" },
    });
    expect(result.auto_approve).toEqual({ label: "safe" });
  });

  it("accepts auto_approve with only workflow_pattern", () => {
    const result = WorkflowSchema.parse({
      ...base,
      auto_approve: { workflow_pattern: "docs-*" },
    });
    expect(result.auto_approve).toEqual({ workflow_pattern: "docs-*" });
  });

  it("accepts auto_approve with only max_cost", () => {
    const result = WorkflowSchema.parse({
      ...base,
      auto_approve: { max_cost: 1.0 },
    });
    expect(result.auto_approve).toEqual({ max_cost: 1.0 });
  });

  it("defaults auto_approve to undefined when not specified", () => {
    const result = WorkflowSchema.parse(base);
    expect(result.auto_approve).toBeUndefined();
  });

  it("rejects negative max_cost", () => {
    expect(() =>
      WorkflowSchema.parse({ ...base, auto_approve: { max_cost: -1 } }),
    ).toThrow();
  });

  it("rejects zero max_cost", () => {
    expect(() =>
      WorkflowSchema.parse({ ...base, auto_approve: { max_cost: 0 } }),
    ).toThrow();
  });
});

describe("needsPreApproval", () => {
  it("returns false for 'full'", () => {
    expect(needsPreApproval("full")).toBe(false);
  });

  it("returns false for 'interactive'", () => {
    expect(needsPreApproval("interactive")).toBe(false);
  });

  it("returns true for 'semi'", () => {
    expect(needsPreApproval("semi")).toBe(true);
  });

  it("returns true for 'supervised'", () => {
    expect(needsPreApproval("supervised")).toBe(true);
  });
});

describe("needsPostApproval", () => {
  it("returns false for 'full'", () => {
    expect(needsPostApproval("full")).toBe(false);
  });

  it("returns false for 'semi'", () => {
    expect(needsPostApproval("semi")).toBe(false);
  });

  it("returns true for 'interactive'", () => {
    expect(needsPostApproval("interactive")).toBe(true);
  });

  it("returns true for 'supervised'", () => {
    expect(needsPostApproval("supervised")).toBe(true);
  });
});

describe("WorkflowFileConfig autonomy field", () => {
  it("accepts autonomy field in WorkflowFileConfig", () => {
    const config: WorkflowFileConfig = {
      autonomy: "semi",
    };
    expect(config.autonomy).toBe("semi");
  });

  it("accepts auto_approve field in WorkflowFileConfig", () => {
    const config: WorkflowFileConfig = {
      auto_approve: { label: "safe", workflow_pattern: "docs-*", max_cost: 0.5 },
    };
    expect(config.auto_approve).toEqual({ label: "safe", workflow_pattern: "docs-*", max_cost: 0.5 });
  });
});

describe("mapFrontMatterToConfig with governance fields", () => {
  it("passes autonomy through when present", () => {
    const fm: WorkflowFileConfig = { autonomy: "semi" };
    const result = mapFrontMatterToConfig(fm);
    // autonomy is a workflow-level field, not a config-level field
    // It flows through zod parsing of WorkflowSchema directly
    // mapFrontMatterToConfig maps to ForgectlConfig which doesn't have autonomy
    // So we just verify it doesn't break
    expect(result).toBeDefined();
  });
});
