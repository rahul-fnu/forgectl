import { describe, it, expect, vi } from "vitest";
import { scheduledQATick, type ScheduledQADeps } from "../../src/orchestrator/scheduled-qa.js";
import { createState } from "../../src/orchestrator/state.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";

function makeTracker(overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    kind: "github",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe("scheduledQATick", () => {
  it("returns zeros when scheduled_qa is not enabled", async () => {
    const config = ConfigSchema.parse({});
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      dispatchIssue: vi.fn(),
    };

    const result = await scheduledQATick(deps);

    expect(result.created).toBe(0);
    expect(result.dispatched).toBe(0);
  });

  it("returns zeros when KG database does not exist", async () => {
    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: "/tmp/nonexistent-kg.db",
      dispatchIssue: vi.fn(),
    };

    const result = await scheduledQATick(deps);

    expect(result.created).toBe(0);
    expect(result.dispatched).toBe(0);
  });

  it("respects the enabled flag", async () => {
    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: false },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBe(0);
    expect(dispatchFn).not.toHaveBeenCalled();
  });
});

describe("scheduled_qa config schema", () => {
  it("parses defaults correctly", () => {
    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });

    expect(config.scheduled_qa).toBeDefined();
    expect(config.scheduled_qa!.enabled).toBe(true);
    expect(config.scheduled_qa!.interval_ms).toBe(86_400_000);
    expect(config.scheduled_qa!.coverage_threshold).toBe(0.5);
    expect(config.scheduled_qa!.max_issues_per_run).toBe(5);
    expect(config.scheduled_qa!.labels).toEqual(["scheduled-qa"]);
  });

  it("allows custom values", () => {
    const config = ConfigSchema.parse({
      scheduled_qa: {
        enabled: true,
        interval_ms: 3_600_000,
        max_issues_per_run: 10,
        labels: ["qa", "automated"],
      },
    });

    expect(config.scheduled_qa!.interval_ms).toBe(3_600_000);
    expect(config.scheduled_qa!.max_issues_per_run).toBe(10);
    expect(config.scheduled_qa!.labels).toEqual(["qa", "automated"]);
  });

  it("is optional (undefined when not specified)", () => {
    const config = ConfigSchema.parse({});
    expect(config.scheduled_qa).toBeUndefined();
  });
});
