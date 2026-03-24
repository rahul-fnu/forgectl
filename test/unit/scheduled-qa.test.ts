import { describe, it, expect, vi, afterEach } from "vitest";
import { scheduledQATick, type ScheduledQADeps } from "../../src/orchestrator/scheduled-qa.js";
import { createState } from "../../src/orchestrator/state.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import { createKGDatabase, saveModules, saveTestMappings } from "../../src/kg/storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function createKGWithModules(
    modules: Array<{ path: string; isTest: boolean }>,
    testMappings: Array<{ sourceFile: string; testFiles: string[]; confidence: string }> = [],
  ): string {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-qa-"));
    const kgPath = join(tmpDir, "kg.db");
    const db = createKGDatabase(kgPath);
    saveModules(
      db,
      modules.map((m) => ({
        path: m.path,
        exports: [],
        imports: [],
        isTest: m.isTest,
      })),
    );
    if (testMappings.length > 0) {
      saveTestMappings(db, testMappings as any);
    }
    db.close();
    return kgPath;
  }

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

  it("dispatches issues for source files with no test mappings", async () => {
    const kgPath = createKGWithModules(
      [
        { path: "src/foo.ts", isTest: false },
        { path: "src/bar.ts", isTest: false },
        { path: "test/foo.test.ts", isTest: true },
      ],
      [{ sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "high" }],
    );

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBe(1);
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const issue = dispatchFn.mock.calls[0][0] as TrackerIssue;
    expect(issue.title).toContain("src/bar.ts");
    expect(issue.labels).toContain("scheduled-qa");
  });

  it("returns zero gaps when all source files have test mappings", async () => {
    const kgPath = createKGWithModules(
      [
        { path: "src/foo.ts", isTest: false },
        { path: "test/foo.test.ts", isTest: true },
      ],
      [{ sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "high" }],
    );

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBe(0);
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("excludes index.ts files from gap detection", async () => {
    const kgPath = createKGWithModules([
      { path: "src/index.ts", isTest: false },
      { path: "src/utils/index.ts", isTest: false },
    ]);

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBe(0);
  });

  it("excludes test files from gap detection", async () => {
    const kgPath = createKGWithModules([
      { path: "test/foo.test.ts", isTest: true },
      { path: "test/bar.test.ts", isTest: true },
    ]);

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBe(0);
  });

  it("respects max_issues_per_run limit", async () => {
    const kgPath = createKGWithModules([
      { path: "src/a.ts", isTest: false },
      { path: "src/b.ts", isTest: false },
      { path: "src/c.ts", isTest: false },
      { path: "src/d.ts", isTest: false },
    ]);

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true, max_issues_per_run: 2 },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.dispatched).toBeLessThanOrEqual(2);
  });

  it("calls tracker.createIssue when available", async () => {
    const kgPath = createKGWithModules([
      { path: "src/foo.ts", isTest: false },
    ]);

    const createIssue = vi.fn().mockResolvedValue("ISSUE-123");
    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker({ createIssue }),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    const result = await scheduledQATick(deps);

    expect(result.created).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
    const issue = dispatchFn.mock.calls[0][0] as TrackerIssue;
    expect(issue.id).toBe("ISSUE-123");
  });

  it("uses custom labels from config", async () => {
    const kgPath = createKGWithModules([
      { path: "src/foo.ts", isTest: false },
    ]);

    const config = ConfigSchema.parse({
      scheduled_qa: { enabled: true, labels: ["qa", "automated"] },
    });
    const dispatchFn = vi.fn();
    const deps: ScheduledQADeps = {
      config,
      tracker: makeTracker(),
      state: createState(),
      logger: makeLogger(),
      kgDbPath: kgPath,
      dispatchIssue: dispatchFn,
    };

    await scheduledQATick(deps);

    const issue = dispatchFn.mock.calls[0][0] as TrackerIssue;
    expect(issue.labels).toEqual(["qa", "automated"]);
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
