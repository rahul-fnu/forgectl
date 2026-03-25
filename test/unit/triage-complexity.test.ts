import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { estimateComplexity, triageIssue, assessComplexity } from "../../src/orchestrator/triage.js";
import { createState } from "../../src/orchestrator/state.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { TrackerIssue } from "../../src/tracker/types.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});

const mockedExecFileSync = vi.mocked(childProcess.execFileSync);

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

beforeEach(() => {
  mockedExecFileSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("assessComplexity", () => {
  it("returns LLM assessment for a simple issue", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 2,
      estimatedFiles: 1,
      estimatedEffort: "trivial",
      riskFactors: [],
      recommendation: "dispatch",
    }));

    const issue = makeIssue({ title: "Fix typo", description: "Small typo in README" });
    const result = await assessComplexity(issue);

    expect(result.complexityScore).toBe(2);
    expect(result.estimatedFiles).toBe(1);
    expect(result.estimatedEffort).toBe("trivial");
    expect(result.recommendation).toBe("dispatch");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "claude-haiku-4-5-20251001"]),
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("returns LLM assessment for a complex issue", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 9,
      estimatedFiles: 15,
      estimatedEffort: "epic",
      riskFactors: ["cross-cutting concern", "database migration"],
      recommendation: "split",
    }));

    const issue = makeIssue({
      title: "Redesign the database layer",
      description: "Major architectural overhaul",
    });
    const result = await assessComplexity(issue);

    expect(result.complexityScore).toBe(9);
    expect(result.estimatedFiles).toBe(15);
    expect(result.estimatedEffort).toBe("epic");
    expect(result.riskFactors).toContain("cross-cutting concern");
    expect(result.recommendation).toBe("split");
  });

  it("passes kgContext to the prompt", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 3,
      estimatedFiles: 2,
      estimatedEffort: "simple",
      riskFactors: [],
      recommendation: "dispatch",
    }));

    const issue = makeIssue({ title: "Fix bug", description: "Something broken" });
    await assessComplexity(issue, "Files: src/foo.ts, src/bar.ts");

    const promptArg = mockedExecFileSync.mock.calls[0][1]![1] as string;
    expect(promptArg).toContain("src/foo.ts");
    expect(promptArg).toContain("src/bar.ts");
  });

  it("falls back to heuristic on LLM failure", async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("command not found");
    });

    const issue = makeIssue({ title: "Fix typo in README", description: "Small typo." });
    const result = await assessComplexity(issue);

    expect(result.complexityScore).toBe(2);
    expect(result.estimatedEffort).toBe("simple");
    expect(result.recommendation).toBe("dispatch");
  });

  it("falls back to heuristic on invalid JSON", async () => {
    mockedExecFileSync.mockReturnValue("not valid json at all");

    const issue = makeIssue({ title: "Fix typo", description: "Small typo." });
    const result = await assessComplexity(issue);

    expect(result.complexityScore).toBe(2);
    expect(result.estimatedEffort).toBe("simple");
  });

  it("falls back to heuristic on invalid field values", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 999,
      estimatedFiles: 1,
      estimatedEffort: "invalid_value",
      riskFactors: [],
      recommendation: "dispatch",
    }));

    const issue = makeIssue({ title: "Fix typo", description: "Small typo." });
    const result = await assessComplexity(issue);

    // Should fall back since complexityScore is out of range
    expect(result.complexityScore).toBe(2);
  });

  it("extracts JSON from markdown fences", async () => {
    mockedExecFileSync.mockReturnValue('```json\n{"complexityScore":4,"estimatedFiles":3,"estimatedEffort":"moderate","riskFactors":[],"recommendation":"dispatch"}\n```');

    const issue = makeIssue({ title: "Add feature", description: "New feature" });
    const result = await assessComplexity(issue);

    expect(result.complexityScore).toBe(4);
    expect(result.estimatedEffort).toBe("moderate");
  });
});

describe("triageIssue with complexity", () => {
  it("returns complexity and assessment when triage is enabled", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 3,
      estimatedFiles: 2,
      estimatedEffort: "simple",
      riskFactors: [],
      recommendation: "dispatch",
    }));

    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();
    const issue = makeIssue({ id: "10", identifier: "#10", title: "Fix typo" });

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.complexity).toBeDefined();
    expect(["low", "medium", "high"]).toContain(result.complexity);
    expect(result.assessment).toBeDefined();
    expect(result.assessment!.complexityScore).toBe(3);
  });

  it("does not return complexity when triage is disabled", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: false } });
    const state = createState();
    const issue = makeIssue();

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.complexity).toBeUndefined();
    expect(result.assessment).toBeUndefined();
  });

  it("blocks dispatch when complexity exceeds threshold", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 9,
      estimatedFiles: 20,
      estimatedEffort: "epic",
      riskFactors: ["massive scope"],
      recommendation: "split",
    }));

    const config = ConfigSchema.parse({
      orchestrator: { enable_triage: true, triage_max_complexity: 7 },
    });
    const state = createState();
    const issue = makeIssue({ id: "10", identifier: "#10", title: "Big refactor" });

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain("complexity score 9");
    expect(result.reason).toContain("exceeds max 7");
    expect(result.assessment).toBeDefined();
    expect(result.assessment!.complexityScore).toBe(9);
  });

  it("allows dispatch when complexity is at threshold", async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({
      complexityScore: 7,
      estimatedFiles: 5,
      estimatedEffort: "complex",
      riskFactors: [],
      recommendation: "dispatch",
    }));

    const config = ConfigSchema.parse({
      orchestrator: { enable_triage: true, triage_max_complexity: 7 },
    });
    const state = createState();
    const issue = makeIssue({ id: "10", identifier: "#10", title: "Moderate task" });

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.assessment!.complexityScore).toBe(7);
  });

  it("dispatches with heuristic fallback on LLM failure", async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("timeout");
    });

    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();
    const issue = makeIssue({ id: "10", identifier: "#10", title: "Fix typo" });

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.assessment).toBeDefined();
    expect(result.assessment!.complexityScore).toBe(2); // heuristic for "low"
  });
});
