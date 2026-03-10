import { describe, it, expect } from "vitest";
import { evaluateAutoApprove } from "../../src/governance/rules.js";
import type { AutoApproveRule, AutoApproveContext } from "../../src/governance/types.js";

describe("evaluateAutoApprove", () => {
  it("returns true with no rules (empty object)", () => {
    const rules: AutoApproveRule = {};
    const context: AutoApproveContext = { labels: [], workflowName: "test" };
    expect(evaluateAutoApprove(rules, context)).toBe(true);
  });

  it("returns true with undefined rules", () => {
    const context: AutoApproveContext = { labels: [], workflowName: "test" };
    expect(evaluateAutoApprove(undefined, context)).toBe(true);
  });

  describe("label condition", () => {
    it("passes when label is present", () => {
      const rules: AutoApproveRule = { label: "safe" };
      const context: AutoApproveContext = { labels: ["safe", "other"], workflowName: "test" };
      expect(evaluateAutoApprove(rules, context)).toBe(true);
    });

    it("fails when label is absent", () => {
      const rules: AutoApproveRule = { label: "safe" };
      const context: AutoApproveContext = { labels: ["other"], workflowName: "test" };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });
  });

  describe("workflow_pattern condition", () => {
    it("passes when workflow matches pattern", () => {
      const rules: AutoApproveRule = { workflow_pattern: "docs-*" };
      const context: AutoApproveContext = { labels: [], workflowName: "docs-update" };
      expect(evaluateAutoApprove(rules, context)).toBe(true);
    });

    it("fails when workflow does not match pattern", () => {
      const rules: AutoApproveRule = { workflow_pattern: "docs-*" };
      const context: AutoApproveContext = { labels: [], workflowName: "code-fix" };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });
  });

  describe("max_cost condition", () => {
    it("passes when actualCost is below max_cost", () => {
      const rules: AutoApproveRule = { max_cost: 0.50 };
      const context: AutoApproveContext = { labels: [], workflowName: "test", actualCost: 0.30 };
      expect(evaluateAutoApprove(rules, context)).toBe(true);
    });

    it("fails when actualCost exceeds max_cost", () => {
      const rules: AutoApproveRule = { max_cost: 0.50 };
      const context: AutoApproveContext = { labels: [], workflowName: "test", actualCost: 0.60 };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });

    it("fails when actualCost equals max_cost", () => {
      const rules: AutoApproveRule = { max_cost: 0.50 };
      const context: AutoApproveContext = { labels: [], workflowName: "test", actualCost: 0.50 };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });

    it("returns false when actualCost is undefined (pre-gate)", () => {
      const rules: AutoApproveRule = { max_cost: 0.50 };
      const context: AutoApproveContext = { labels: [], workflowName: "test" };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });
  });

  describe("AND logic with multiple conditions", () => {
    it("passes when all conditions pass", () => {
      const rules: AutoApproveRule = { label: "safe", workflow_pattern: "docs-*", max_cost: 1.0 };
      const context: AutoApproveContext = {
        labels: ["safe"],
        workflowName: "docs-update",
        actualCost: 0.50,
      };
      expect(evaluateAutoApprove(rules, context)).toBe(true);
    });

    it("fails when label condition fails", () => {
      const rules: AutoApproveRule = { label: "safe", workflow_pattern: "docs-*", max_cost: 1.0 };
      const context: AutoApproveContext = {
        labels: ["other"],
        workflowName: "docs-update",
        actualCost: 0.50,
      };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });

    it("fails when workflow_pattern condition fails", () => {
      const rules: AutoApproveRule = { label: "safe", workflow_pattern: "docs-*", max_cost: 1.0 };
      const context: AutoApproveContext = {
        labels: ["safe"],
        workflowName: "code-fix",
        actualCost: 0.50,
      };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });

    it("fails when max_cost condition fails", () => {
      const rules: AutoApproveRule = { label: "safe", workflow_pattern: "docs-*", max_cost: 0.50 };
      const context: AutoApproveContext = {
        labels: ["safe"],
        workflowName: "docs-update",
        actualCost: 0.60,
      };
      expect(evaluateAutoApprove(rules, context)).toBe(false);
    });
  });
});
