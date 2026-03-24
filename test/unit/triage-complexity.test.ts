import { describe, it, expect } from "vitest";
import { estimateComplexity, triageIssue } from "../../src/orchestrator/triage.js";
import { createState } from "../../src/orchestrator/state.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { TrackerIssue } from "../../src/tracker/types.js";

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "1",
    identifier: "#1",
    title: "Test issue",
    description: "desc",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "https://example.com/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
    ...overrides,
  };
}

describe("estimateComplexity", () => {
  it("returns low for simple typo fixes", () => {
    const issue = makeIssue({ title: "Fix typo in README", description: "Small typo." });
    expect(estimateComplexity(issue)).toBe("low");
  });

  it("returns low for short issues with few file refs", () => {
    const issue = makeIssue({
      title: "Update import",
      description: "Fix import in src/utils/helper.ts",
    });
    expect(estimateComplexity(issue)).toBe("low");
  });

  it("returns high for issues mentioning many files", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/module${i}/index.ts`);
    const issue = makeIssue({
      title: "Refactor across modules",
      description: `Update these files:\n${files.join("\n")}`,
    });
    expect(estimateComplexity(issue)).toBe("high");
  });

  it("returns high for architectural changes", () => {
    const issue = makeIssue({
      title: "Redesign authentication system",
      description: "This is an architectural change that affects the core auth flow.",
    });
    expect(estimateComplexity(issue)).toBe("high");
  });

  it("returns high for very long descriptions", () => {
    const issue = makeIssue({
      title: "Complex feature",
      description: "x".repeat(5000),
    });
    expect(estimateComplexity(issue)).toBe("high");
  });

  it("returns medium for moderate issues", () => {
    const issue = makeIssue({
      title: "Add validation to user input",
      description: "We need to add validation to the form in src/components/form.ts, src/utils/validate.ts, src/api/handler.ts, and src/models/user.ts. This should check email format and required fields.",
    });
    expect(estimateComplexity(issue)).toBe("medium");
  });
});

describe("triageIssue with complexity", () => {
  it("returns complexity in result when triage is enabled", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();
    const issue = makeIssue({ id: "10", identifier: "#10", title: "Fix typo" });

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.complexity).toBeDefined();
    expect(["low", "medium", "high"]).toContain(result.complexity);
  });

  it("does not return complexity when triage is disabled", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: false } });
    const state = createState();
    const issue = makeIssue();

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.complexity).toBeUndefined();
  });
});
