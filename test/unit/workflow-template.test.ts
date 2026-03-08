import { describe, it, expect } from "vitest";
import type { TrackerIssue } from "../../src/tracker/types.js";
import {
  renderPromptTemplate,
  buildTemplateVars,
} from "../../src/workflow/template.js";

const fixtureIssue: TrackerIssue = {
  id: "123",
  identifier: "GH-42",
  title: "Fix bug",
  description: "There is a bug that needs fixing",
  state: "open",
  priority: "high",
  labels: ["bug", "forgectl"],
  assignees: ["alice"],
  url: "https://github.com/org/repo/issues/42",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  blocked_by: [],
  metadata: {},
};

describe("renderPromptTemplate", () => {
  it("renders simple issue field", () => {
    const result = renderPromptTemplate("Hello {{issue.title}}", {
      issue: { title: "Fix bug" },
    });
    expect(result).toBe("Hello Fix bug");
  });

  it("renders arrays as JSON", () => {
    const result = renderPromptTemplate("{{issue.labels}}", {
      issue: { labels: ["bug", "forgectl"] },
    });
    expect(result).toBe('["bug","forgectl"]');
  });

  it("renders null as empty string", () => {
    const result = renderPromptTemplate("{{issue.priority}}", {
      issue: { priority: null },
    });
    expect(result).toBe("");
  });

  it("renders attempt as empty string on first run", () => {
    const result = renderPromptTemplate("{{attempt}}", { attempt: "" });
    expect(result).toBe("");
  });

  it("renders attempt number on retry", () => {
    const result = renderPromptTemplate("{{attempt}}", { attempt: 2 });
    expect(result).toBe("2");
  });

  it("throws on unknown top-level variable", () => {
    expect(() =>
      renderPromptTemplate("{{unknown}}", { issue: {} }),
    ).toThrow(/unknown template variable.*\{\{unknown\}\}/i);
  });

  it("throws on unknown nested variable", () => {
    expect(() =>
      renderPromptTemplate("{{issue.nonexistent}}", {
        issue: { title: "x" },
      }),
    ).toThrow(/unknown template variable.*\{\{issue\.nonexistent\}\}/i);
  });

  it("renders multiple variables in one template", () => {
    const result = renderPromptTemplate(
      "Fix: {{issue.title}} (attempt {{attempt}})",
      { issue: { title: "Bug" }, attempt: 2 },
    );
    expect(result).toBe("Fix: Bug (attempt 2)");
  });
});

describe("buildTemplateVars", () => {
  it("nests issue fields under issue.* with null attempt as empty string", () => {
    const vars = buildTemplateVars(fixtureIssue, null);
    expect(vars.attempt).toBe("");
    expect((vars.issue as Record<string, unknown>).title).toBe("Fix bug");
    expect((vars.issue as Record<string, unknown>).id).toBe("123");
  });

  it("maps attempt number", () => {
    const vars = buildTemplateVars(fixtureIssue, 3);
    expect(vars.attempt).toBe(3);
  });

  it("maps null priority to empty string", () => {
    const issueWithNullPriority = { ...fixtureIssue, priority: null };
    const vars = buildTemplateVars(issueWithNullPriority, null);
    expect((vars.issue as Record<string, unknown>).priority).toBe("");
  });

  it("preserves non-null priority", () => {
    const vars = buildTemplateVars(fixtureIssue, null);
    expect((vars.issue as Record<string, unknown>).priority).toBe("high");
  });

  it("preserves arrays in issue fields", () => {
    const vars = buildTemplateVars(fixtureIssue, null);
    expect((vars.issue as Record<string, unknown>).labels).toEqual([
      "bug",
      "forgectl",
    ]);
  });
});
