import { describe, it, expect } from "vitest";
import { triageIssue, type TriageResult } from "../../src/orchestrator/triage.js";
import { createState } from "../../src/orchestrator/state.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { TrackerIssue } from "../../src/tracker/types.js";
import type { OrchestratorState, WorkerInfo } from "../../src/orchestrator/state.js";

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

function makeWorkerInfo(issue: TrackerIssue): WorkerInfo {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    issue,
    session: null,
    cleanup: { tempDirs: [], secretCleanups: [] },
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    attempt: 1,
    slotWeight: 1,
  };
}

describe("triageIssue", () => {
  it("returns shouldDispatch=true when triage is disabled", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: false } });
    const state = createState();
    const issue = makeIssue();

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.reason).toBe("triage disabled");
  });

  it("detects duplicate title against running issues", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();

    const runningIssue = makeIssue({ id: "2", identifier: "#2", title: "Fix the bug" });
    state.running.set("2", makeWorkerInfo(runningIssue));

    const newIssue = makeIssue({ id: "3", identifier: "#3", title: "Fix the bug" });
    const result = await triageIssue(newIssue, state, config);

    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain("duplicate");
    expect(result.duplicateOf).toBe("2");
  });

  it("is case-insensitive for duplicate detection", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();

    const runningIssue = makeIssue({ id: "2", identifier: "#2", title: "Fix The Bug" });
    state.running.set("2", makeWorkerInfo(runningIssue));

    const newIssue = makeIssue({ id: "3", identifier: "#3", title: "fix the bug" });
    const result = await triageIssue(newIssue, state, config);

    expect(result.shouldDispatch).toBe(false);
    expect(result.duplicateOf).toBe("2");
  });

  it("does not flag different titles as duplicates", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();

    const runningIssue = makeIssue({ id: "2", identifier: "#2", title: "Fix the bug" });
    state.running.set("2", makeWorkerInfo(runningIssue));

    const newIssue = makeIssue({ id: "3", identifier: "#3", title: "Add new feature" });
    const result = await triageIssue(newIssue, state, config);

    expect(result.shouldDispatch).toBe(true);
  });

  it("skips recently completed issues", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();
    state.recentlyCompleted.set("5", Date.now());

    const issue = makeIssue({ id: "5", identifier: "#5" });
    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toBe("issue recently completed");
  });

  it("passes triage when no duplicates or recent completions", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();

    const issue = makeIssue({ id: "10", identifier: "#10", title: "Brand new task" });
    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
    expect(result.reason).toBe("passed triage");
  });

  it("does not flag the same issue running against itself", async () => {
    const config = ConfigSchema.parse({ orchestrator: { enable_triage: true } });
    const state = createState();

    const issue = makeIssue({ id: "1", identifier: "#1", title: "Some task" });
    state.running.set("1", makeWorkerInfo(issue));

    const result = await triageIssue(issue, state, config);

    expect(result.shouldDispatch).toBe(true);
  });
});
