import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectAnomalies,
  createReactiveIssue,
  dispatchReactiveIssues,
  buildIssueTitle,
  resetDailyCount,
  type ReactiveConfig,
  DEFAULT_REACTIVE_CONFIG,
} from "../../src/analysis/reactive-dispatch.js";
import type { OutcomeRow } from "../../src/storage/repositories/outcomes.js";
import type { TrackerAdapter } from "../../src/tracker/types.js";
import type { Logger } from "../../src/logging/logger.js";

function makeRow(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    id: "run-1",
    taskId: "task-1",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:10:00Z",
    status: "failure",
    totalTurns: 10,
    lintIterations: null,
    reviewRounds: null,
    reviewCommentsJson: null,
    failureMode: "typecheck",
    failureDetail: "Type error in src/orchestrator/worker.ts",
    humanReviewResult: null,
    humanReviewComments: null,
    modulesTouched: JSON.stringify(["src/orchestrator"]),
    filesChanged: null,
    testsAdded: null,
    rawEventsJson: null,
    contextEnabled: null,
    contextFilesJson: null,
    contextHitRate: null,
    recovered: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeTracker(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    kind: "linear",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue("ISSUE-123"),
    ...overrides,
  };
}

describe("detectAnomalies", () => {
  it("returns empty for no failures", () => {
    const rows = [makeRow({ status: "success", failureMode: null })];
    expect(detectAnomalies(rows)).toEqual([]);
  });

  it("ignores single failures (requires 2+ occurrences)", () => {
    const rows = [makeRow({ id: "run-1" })];
    expect(detectAnomalies(rows)).toEqual([]);
  });

  it("detects repeated failures in same module", () => {
    const rows = [
      makeRow({ id: "run-1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "run-2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ];
    const anomalies = detectAnomalies(rows);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].module).toBe("src/orchestrator");
    expect(anomalies[0].failureMode).toBe("typecheck");
    expect(anomalies[0].occurrences).toBe(2);
    expect(anomalies[0].affectedRuns).toEqual(["run-1", "run-2"]);
  });

  it("separates anomalies by failure mode", () => {
    const rows = [
      makeRow({ id: "run-1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "run-2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "run-3", failureMode: "lint", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "run-4", failureMode: "lint", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ];
    const anomalies = detectAnomalies(rows);
    expect(anomalies).toHaveLength(2);
  });
});

describe("issue creation format", () => {
  it("builds title with correct format", () => {
    const anomaly = detectAnomalies([
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ])[0];
    const title = buildIssueTitle(anomaly);
    expect(title).toBe("[reactive] Fix repeated typecheck failure in src/orchestrator");
  });

  it("includes evidence and affected runs in description", () => {
    const anomaly = detectAnomalies([
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]), failureDetail: "TS2322: Type error" }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]), failureDetail: "TS2345: Argument error" }),
    ])[0];
    expect(anomaly.description).toContain("Evidence");
    expect(anomaly.description).toContain("r1, r2");
    expect(anomaly.description).toContain("TS2322");
    expect(anomaly.description).toContain("Suggested approach");
  });
});

describe("deduplication", () => {
  beforeEach(() => resetDailyCount());

  it("skips creating duplicate issues", async () => {
    const logger = makeLogger();
    const tracker = makeTracker();
    const config: ReactiveConfig = { auto_create_issues: true, max_issues_per_day: 5 };
    const anomaly = detectAnomalies([
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ])[0];

    const existingTitles = ["[reactive] Fix repeated typecheck failure in src/orchestrator"];
    const result = await createReactiveIssue(anomaly, tracker, config, logger, existingTitles);
    expect(result).toBeUndefined();
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("creates issue when no duplicate exists", async () => {
    const logger = makeLogger();
    const tracker = makeTracker();
    const config: ReactiveConfig = { auto_create_issues: true, max_issues_per_day: 5 };
    const anomaly = detectAnomalies([
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ])[0];

    const result = await createReactiveIssue(anomaly, tracker, config, logger, []);
    expect(result).toBe("ISSUE-123");
    expect(tracker.createIssue).toHaveBeenCalledWith(
      "[reactive] Fix repeated typecheck failure in src/orchestrator",
      expect.stringContaining("Anomaly detected"),
      ["reactive-maintenance"],
    );
  });
});

describe("daily limit", () => {
  beforeEach(() => resetDailyCount());

  it("respects max_issues_per_day", async () => {
    const logger = makeLogger();
    const tracker = makeTracker();
    const config: ReactiveConfig = { auto_create_issues: true, max_issues_per_day: 1 };

    const rows = [
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r3", failureMode: "lint", modulesTouched: JSON.stringify(["src/config"]) }),
      makeRow({ id: "r4", failureMode: "lint", modulesTouched: JSON.stringify(["src/config"]) }),
    ];

    const created = await dispatchReactiveIssues(rows, tracker, config, logger);
    expect(created).toHaveLength(1);
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
  });

  it("skips all when auto_create_issues is false", async () => {
    const logger = makeLogger();
    const tracker = makeTracker();
    const config: ReactiveConfig = { auto_create_issues: false, max_issues_per_day: 5 };

    const rows = [
      makeRow({ id: "r1", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
      makeRow({ id: "r2", failureMode: "typecheck", modulesTouched: JSON.stringify(["src/orchestrator"]) }),
    ];

    const created = await dispatchReactiveIssues(rows, tracker, config, logger);
    expect(created).toHaveLength(0);
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });
});

describe("default config", () => {
  it("has correct defaults", () => {
    expect(DEFAULT_REACTIVE_CONFIG.auto_create_issues).toBe(true);
    expect(DEFAULT_REACTIVE_CONFIG.max_issues_per_day).toBe(5);
  });
});
