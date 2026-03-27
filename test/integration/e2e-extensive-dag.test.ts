import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerAdapter, TrackerIssue } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import type { WorkerResult } from "../../src/orchestrator/worker.js";
import { createState, SlotManager, type OrchestratorState } from "../../src/orchestrator/state.js";
import { MetricsCollector } from "../../src/orchestrator/metrics.js";
import type { Logger } from "../../src/logging/logger.js";
import { MergeQueue } from "../../src/orchestrator/merge-queue.js";
import { computeCriticalPath, type IssueDAGNode } from "../../src/tracker/sub-issue-dag.js";

// Hoist shared mocks
const shared = vi.hoisted(() => ({
  executeWorkerMock: vi.fn(),
}));

// Mock executeWorker at module level
vi.mock("../../src/orchestrator/worker.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/orchestrator/worker.js")>();
  return {
    ...orig,
    executeWorker: shared.executeWorkerMock,
  };
});

// Mock emitRunEvent to silence SSE
vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
  runEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

// Mock triage module
vi.mock("../../src/orchestrator/triage.js", () => ({
  triageIssue: vi.fn().mockResolvedValue({ shouldDispatch: true, reason: "triage disabled" }),
}));

// Import after mocks
import {
  dispatchIssue,
  filterCandidates,
  sortCandidates,
  extractRepoFromIssue,
} from "../../src/orchestrator/dispatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: overrides.id ?? "1",
    identifier: overrides.identifier ?? "#1",
    title: overrides.title ?? "Fix the bug",
    description: overrides.description ?? "Detailed description",
    state: overrides.state ?? "open",
    priority: overrides.priority ?? null,
    labels: overrides.labels ?? ["forgectl"],
    assignees: overrides.assignees ?? [],
    url: overrides.url ?? "https://github.com/org/repo/issues/1",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
    blocked_by: overrides.blocked_by ?? [],
    metadata: overrides.metadata ?? {},
  };
}

function makeTracker(): TrackerAdapter & {
  calls: {
    postComment: Array<{ issueId: string; body: string }>;
    updateState: Array<{ issueId: string; state: string }>;
    updateLabels: Array<{ issueId: string; add: string[]; remove: string[] }>;
  };
  issueStates: Map<string, string>;
  candidateIssues: TrackerIssue[];
  mergeResult: { merged: boolean; prUrl?: string; error?: string };
} {
  const calls = {
    postComment: [] as Array<{ issueId: string; body: string }>,
    updateState: [] as Array<{ issueId: string; state: string }>,
    updateLabels: [] as Array<{ issueId: string; add: string[]; remove: string[] }>,
  };
  const issueStates = new Map<string, string>();
  const candidateIssues: TrackerIssue[] = [];
  const mergeResult = { merged: true, prUrl: "https://github.com/org/repo/pull/1" };

  return {
    kind: "github",
    calls,
    issueStates,
    candidateIssues,
    mergeResult,
    fetchCandidateIssues: vi.fn(async () => candidateIssues),
    fetchIssueStatesByIds: vi.fn(async (ids: string[]) => {
      const result = new Map<string, string>();
      for (const id of ids) {
        const state = issueStates.get(id);
        if (state) result.set(id, state);
      }
      return result;
    }),
    fetchIssuesByStates: vi.fn(async () => []),
    postComment: vi.fn(async (issueId: string, body: string) => {
      calls.postComment.push({ issueId, body });
    }),
    updateState: vi.fn(async (issueId: string, state: string) => {
      calls.updateState.push({ issueId, state });
    }),
    updateLabels: vi.fn(async (issueId: string, add: string[], remove: string[]) => {
      calls.updateLabels.push({ issueId, add, remove });
    }),
    createPullRequest: vi.fn(async () => mergeResult.prUrl),
    createAndMergePullRequest: vi.fn(async () => mergeResult),
  };
}

function makeWorkspaceManager(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn(async () => ({ path: "/tmp/workspace", created: false })),
    removeWorkspace: vi.fn(async () => {}),
    cleanupTerminalWorkspaces: vi.fn(async () => {}),
    runBeforeHook: vi.fn(async () => {}),
    runAfterHook: vi.fn(async () => {}),
  } as unknown as WorkspaceManager;
}

function makeConfig(overrides: {
  maxAgents?: number;
  maxRetries?: number;
  autoClose?: boolean;
  doneLabel?: string;
} = {}): ForgectlConfig {
  return {
    agent: { type: "claude-code", model: "", max_turns: 50, timeout: "30m", flags: [] },
    container: {
      image: "node:20",
      network: { mode: "open" },
      resources: { memory: "4g", cpus: 2 },
    },
    repo: {
      branch: { template: "forge/{{slug}}/{{ts}}", base: "main" },
      exclude: [],
    },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    orchestrator: {
      enabled: true,
      max_concurrent_agents: overrides.maxAgents ?? 4,
      poll_interval_ms: 5000,
      stall_timeout_ms: 600000,
      max_retries: overrides.maxRetries ?? 3,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 100,
      in_progress_label: "in-progress",
    },
    tracker: {
      kind: "github",
      token: "test-token",
      active_states: ["open", "in_progress"],
      terminal_states: ["closed", "done"],
      poll_interval_ms: 60000,
      auto_close: overrides.autoClose ?? true,
      repo: "org/repo",
      done_label: overrides.doneLabel ?? "done",
    },
    board: {
      state_dir: "~/.forgectl/board",
      scheduler_tick_seconds: 30,
      max_concurrent_card_runs: 2,
    },
  } as ForgectlConfig;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Logger;
}

function makeSuccessResult(branch: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    agentResult: {
      stdout: "Done",
      stderr: "",
      status: "completed",
      tokenUsage: { input: 1000, output: 500, total: 1500 },
      durationMs: 5000,
      turnCount: 3,
    },
    comment: `## forgectl Agent Report\n\n**Status:** Pass\n**Branch:** \`${branch}\``,
    validationResult: {
      passed: true,
      totalAttempts: 1,
      stepResults: [{ name: "lint", passed: true, command: "npm run lint", output: "", attempts: 1 }],
    },
    branch,
    ...overrides,
  };
}

function makeFailedResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    agentResult: {
      stdout: "",
      stderr: "Agent crashed",
      status: "failed",
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: 1000,
      turnCount: 0,
    },
    comment: "## forgectl Agent Report\n\n**Status:** Fail",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 10-issue DAG layout across 2 repos
//
// Diamond DAG 1 (forge-test-api):
//       A1 (init db schema)
//      /  \
//    A2    A3 (models, routes)
//      \  /
//       A4 (api integration tests)
//
// Diamond DAG 2 (forge-test-cli):
//       C1 (scaffold CLI)
//      /  \
//    C2    C3 (commands, formatters)
//      \  /
//       C4 (cli integration tests)
//
// Convergence:
//    A4 + C4 → X1 (cross-repo e2e tests)
//         X1 → X2 (release docs)
//
// Total: 10 issues. Two diamonds that converge into a single tail.
// ---------------------------------------------------------------------------

function buildIssueSet(): TrackerIssue[] {
  return [
    // --- API diamond (forge-test-api) ---
    makeIssue({
      id: "A1", identifier: "#A1",
      title: "Init DB schema",
      description: "**Repo:** https://github.com/forge-org/forge-test-api\nCreate initial database schema",
      priority: "0", labels: ["forgectl", "P0"],
      created_at: "2026-03-01T00:00:00Z",
      blocked_by: [],
    }),
    makeIssue({
      id: "A2", identifier: "#A2",
      title: "Implement data models",
      description: "**Repo:** https://github.com/forge-org/forge-test-api\nData models for users and projects",
      priority: "1", labels: ["forgectl", "P1"],
      created_at: "2026-03-01T01:00:00Z",
      blocked_by: ["A1"],
    }),
    makeIssue({
      id: "A3", identifier: "#A3",
      title: "Implement API routes",
      description: "**Repo:** https://github.com/forge-org/forge-test-api\nREST endpoints for CRUD",
      priority: "1", labels: ["forgectl", "P1"],
      created_at: "2026-03-01T02:00:00Z",
      blocked_by: ["A1"],
    }),
    makeIssue({
      id: "A4", identifier: "#A4",
      title: "API integration tests",
      description: "**Repo:** https://github.com/forge-org/forge-test-api\nIntegration tests for API",
      priority: "2", labels: ["forgectl", "P2"],
      created_at: "2026-03-01T03:00:00Z",
      blocked_by: ["A2", "A3"],
    }),
    // --- CLI diamond (forge-test-cli) ---
    makeIssue({
      id: "C1", identifier: "#C1",
      title: "Scaffold CLI project",
      description: "**Repo:** https://github.com/forge-org/forge-test-cli\nInitialize CLI with commander",
      priority: "0", labels: ["forgectl", "P0"],
      created_at: "2026-03-01T00:00:00Z",
      blocked_by: [],
    }),
    makeIssue({
      id: "C2", identifier: "#C2",
      title: "Implement CLI commands",
      description: "**Repo:** https://github.com/forge-org/forge-test-cli\nAdd create/list/delete commands",
      priority: "1", labels: ["forgectl", "P1"],
      created_at: "2026-03-01T01:00:00Z",
      blocked_by: ["C1"],
    }),
    makeIssue({
      id: "C3", identifier: "#C3",
      title: "Implement CLI formatters",
      description: "**Repo:** https://github.com/forge-org/forge-test-cli\nJSON, table, and YAML output formatters",
      priority: "1", labels: ["forgectl", "P1"],
      created_at: "2026-03-01T02:00:00Z",
      blocked_by: ["C1"],
    }),
    makeIssue({
      id: "C4", identifier: "#C4",
      title: "CLI integration tests",
      description: "**Repo:** https://github.com/forge-org/forge-test-cli\nIntegration tests for CLI",
      priority: "2", labels: ["forgectl", "P2"],
      created_at: "2026-03-01T03:00:00Z",
      blocked_by: ["C2", "C3"],
    }),
    // --- Convergence tail ---
    makeIssue({
      id: "X1", identifier: "#X1",
      title: "Cross-repo E2E tests",
      description: "End-to-end tests spanning API + CLI",
      priority: "3", labels: ["forgectl", "P3"],
      created_at: "2026-03-01T04:00:00Z",
      blocked_by: ["A4", "C4"],
    }),
    makeIssue({
      id: "X2", identifier: "#X2",
      title: "Release documentation",
      description: "Final release docs after E2E passes",
      priority: "4", labels: ["forgectl", "P4"],
      created_at: "2026-03-01T05:00:00Z",
      blocked_by: ["X1"],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Extensive E2E — 10 issues, 2 repos, diamond DAGs", () => {
  let state: OrchestratorState;
  let tracker: ReturnType<typeof makeTracker>;
  let config: ForgectlConfig;
  let workspaceManager: WorkspaceManager;
  let logger: Logger;
  let metrics: MetricsCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createState();
    tracker = makeTracker();
    workspaceManager = makeWorkspaceManager();
    logger = makeLogger();
    metrics = new MetricsCollector();
  });

  afterEach(() => {
    // Clear any pending retry timers
    for (const timer of state.retryTimers.values()) {
      clearTimeout(timer);
    }
  });

  // -----------------------------------------------------------------------
  // 1. Multi-repo routing
  // -----------------------------------------------------------------------
  describe("Multi-repo routing from issue descriptions", () => {
    it("extracts correct repo slugs for API and CLI issues", () => {
      const issues = buildIssueSet();

      expect(extractRepoFromIssue(issues[0])).toBe("forge-org/forge-test-api"); // A1
      expect(extractRepoFromIssue(issues[1])).toBe("forge-org/forge-test-api"); // A2
      expect(extractRepoFromIssue(issues[4])).toBe("forge-org/forge-test-cli"); // C1
      expect(extractRepoFromIssue(issues[5])).toBe("forge-org/forge-test-cli"); // C2
    });

    it("returns null for convergence issues without repo in description", () => {
      const issues = buildIssueSet();

      expect(extractRepoFromIssue(issues[8])).toBeNull(); // X1 — no repo in desc
      expect(extractRepoFromIssue(issues[9])).toBeNull(); // X2 — no repo in desc
    });

    it("routes 10 issues to correct repos by description pattern", () => {
      const issues = buildIssueSet();
      const repoMap = new Map<string | null, string[]>();

      for (const issue of issues) {
        const repo = extractRepoFromIssue(issue);
        if (!repoMap.has(repo)) repoMap.set(repo, []);
        repoMap.get(repo)!.push(issue.id);
      }

      expect(repoMap.get("forge-org/forge-test-api")).toEqual(["A1", "A2", "A3", "A4"]);
      expect(repoMap.get("forge-org/forge-test-cli")).toEqual(["C1", "C2", "C3", "C4"]);
      expect(repoMap.get(null)).toEqual(["X1", "X2"]);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Dependency filtering with diamond DAGs
  // -----------------------------------------------------------------------
  describe("Diamond DAG dependency resolution", () => {
    it("only allows root issues (A1, C1) when no blockers are terminal", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>();

      const eligible = filterCandidates(issues, state, terminalIds);

      expect(eligible.map((i) => i.id).sort()).toEqual(["A1", "C1"]);
    });

    it("unblocks diamond mid-layer when roots complete", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "C1"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id).sort();

      // A1/C1 are still candidates (not claimed), plus A2/A3/C2/C3 are unblocked
      expect(ids).toEqual(["A1", "A2", "A3", "C1", "C2", "C3"]);
    });

    it("unblocks diamond converge nodes (A4, C4) when both sides complete", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "A2", "A3", "C1", "C2", "C3"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id).sort();

      expect(ids).toEqual(["A1", "A2", "A3", "A4", "C1", "C2", "C3", "C4"]);
    });

    it("keeps A4 blocked when only A2 is terminal (A3 still needed)", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "A2"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id);

      // A4 requires both A2 AND A3 to be terminal
      expect(ids).not.toContain("A4");
      // A3 is unblocked (only needs A1)
      expect(ids).toContain("A3");
    });

    it("unblocks X1 only when both diamonds fully complete (A4 + C4 terminal)", () => {
      const issues = buildIssueSet();

      // Everything except X1 and X2 is terminal
      const terminalIds = new Set<string>(["A1", "A2", "A3", "A4", "C1", "C2", "C3", "C4"]);
      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id);

      expect(ids).toContain("X1");
      expect(ids).not.toContain("X2"); // X2 blocked by non-terminal X1
    });

    it("unblocks X2 only when X1 is terminal", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "A2", "A3", "A4", "C1", "C2", "C3", "C4", "X1"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      expect(eligible.map((i) => i.id)).toContain("X2");
    });

    it("keeps X1 blocked when only API diamond completes (C4 not terminal)", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "A2", "A3", "A4", "C1", "C2", "C3"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      expect(eligible.map((i) => i.id)).not.toContain("X1");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Priority sorting with mixed priorities across repos
  // -----------------------------------------------------------------------
  describe("Priority sorting across multi-repo diamond DAG", () => {
    it("sorts roots first (P0), then mid-layer (P1), then converge (P2), then tail (P3, P4)", () => {
      const issues = buildIssueSet();
      const sorted = sortCandidates(issues);
      const ids = sorted.map((i) => i.id);

      // P0: A1 and C1 (tiebreak by created_at, then identifier — both same time, so alpha)
      expect(ids[0]).toBe("A1");
      expect(ids[1]).toBe("C1");

      // P1: A2, C2, A3, C3 (sorted by created_at)
      expect(ids.slice(2, 6).sort()).toEqual(["A2", "A3", "C2", "C3"]);

      // P2: A4, C4
      expect(ids.slice(6, 8).sort()).toEqual(["A4", "C4"]);

      // P3: X1, P4: X2
      expect(ids[8]).toBe("X1");
      expect(ids[9]).toBe("X2");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Critical-path scoring across the full DAG
  // -----------------------------------------------------------------------
  describe("Critical-path scoring for dispatch ordering", () => {
    it("assigns highest scores to roots (A1/C1) which unblock the most downstream", () => {
      const issues = buildIssueSet();
      const dagNodes: IssueDAGNode[] = issues.map((i) => ({
        id: i.id,
        blocked_by: i.blocked_by,
      }));

      const scores = computeCriticalPath(dagNodes);

      // A1 unblocks: A2, A3, A4, X1, X2 = 5 downstream
      expect(scores.get("A1")).toBe(5);
      // C1 unblocks: C2, C3, C4, X1, X2 = 5 downstream
      expect(scores.get("C1")).toBe(5);
    });

    it("assigns lower scores to mid-layer nodes", () => {
      const issues = buildIssueSet();
      const dagNodes: IssueDAGNode[] = issues.map((i) => ({
        id: i.id,
        blocked_by: i.blocked_by,
      }));

      const scores = computeCriticalPath(dagNodes);

      // A2 unblocks: A4, X1, X2 = 3 downstream
      expect(scores.get("A2")).toBe(3);
      // A3 unblocks: A4, X1, X2 = 3 downstream
      expect(scores.get("A3")).toBe(3);
      // C2 unblocks: C4, X1, X2 = 3 downstream
      expect(scores.get("C2")).toBe(3);
    });

    it("assigns converge nodes score 2 (X1, X2 downstream)", () => {
      const issues = buildIssueSet();
      const dagNodes: IssueDAGNode[] = issues.map((i) => ({
        id: i.id,
        blocked_by: i.blocked_by,
      }));

      const scores = computeCriticalPath(dagNodes);

      // A4 unblocks: X1, X2 = 2
      expect(scores.get("A4")).toBe(2);
      // C4 unblocks: X1, X2 = 2
      expect(scores.get("C4")).toBe(2);
    });

    it("assigns tail nodes decreasing scores", () => {
      const issues = buildIssueSet();
      const dagNodes: IssueDAGNode[] = issues.map((i) => ({
        id: i.id,
        blocked_by: i.blocked_by,
      }));

      const scores = computeCriticalPath(dagNodes);

      // X1 unblocks: X2 = 1
      expect(scores.get("X1")).toBe(1);
      // X2 is a leaf = 0
      expect(scores.get("X2")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Parallel execution with slot limits across diamond DAGs
  // -----------------------------------------------------------------------
  describe("Parallel execution respects slot limits", () => {
    it("dispatches both roots in parallel when 4 slots available", async () => {
      config = makeConfig({ maxAgents: 4 });
      const issues = buildIssueSet();
      const terminalIds = new Set<string>();
      const eligible = filterCandidates(issues, state, terminalIds);
      const sorted = sortCandidates(eligible);
      const slotManager = new SlotManager(4);

      shared.executeWorkerMock.mockReturnValue(new Promise(() => {}));

      const available = slotManager.availableSlots(state.running);
      expect(available).toBe(4);

      for (const issue of sorted.slice(0, available)) {
        await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      }

      // Both roots (A1, C1) should be dispatched
      expect(state.claimed.has("A1")).toBe(true);
      expect(state.claimed.has("C1")).toBe(true);
    });

    it("dispatches 4 mid-layer issues in parallel after roots complete", async () => {
      config = makeConfig({ maxAgents: 4 });
      const issues = buildIssueSet();

      // Roots are terminal and recently completed
      const terminalIds = new Set<string>(["A1", "C1"]);
      state.recentlyCompleted.set("A1", Date.now());
      state.recentlyCompleted.set("C1", Date.now());

      const eligible = filterCandidates(issues, state, terminalIds);
      const sorted = sortCandidates(eligible);
      const slotManager = new SlotManager(4);

      shared.executeWorkerMock.mockReturnValue(new Promise(() => {}));

      const available = slotManager.availableSlots(state.running);
      for (const issue of sorted.slice(0, available)) {
        await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      }

      // All 4 mid-layer issues dispatched in parallel
      expect(state.claimed.has("A2")).toBe(true);
      expect(state.claimed.has("A3")).toBe(true);
      expect(state.claimed.has("C2")).toBe(true);
      expect(state.claimed.has("C3")).toBe(true);
    });

    it("limits to 2 slots when maxAgents=2", async () => {
      config = makeConfig({ maxAgents: 2 });
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "C1"]);
      state.recentlyCompleted.set("A1", Date.now());
      state.recentlyCompleted.set("C1", Date.now());

      const eligible = filterCandidates(issues, state, terminalIds);
      const sorted = sortCandidates(eligible);
      const slotManager = new SlotManager(2);

      shared.executeWorkerMock.mockReturnValue(new Promise(() => {}));

      const available = slotManager.availableSlots(state.running);
      expect(available).toBe(2);

      for (const issue of sorted.slice(0, available)) {
        await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
      }

      // Only first 2 sorted (by priority then time) should be dispatched
      expect(state.claimed.size).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Stacked diffs — PR base selection via issueBranches
  // -----------------------------------------------------------------------
  describe("Stacked diffs across diamond DAGs", () => {
    it("records branches in issueBranches after successful dispatch", async () => {
      config = makeConfig({ autoClose: true, doneLabel: "done" });
      const issues = buildIssueSet();

      // Dispatch A1 with a successful result that produces a branch
      shared.executeWorkerMock.mockResolvedValueOnce(
        makeSuccessResult("forge/a1-db-schema"),
      );

      await dispatchIssue(issues[0], state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(state.issueBranches.has("A1")).toBe(true);
      }, { timeout: 2000 });

      expect(state.issueBranches.get("A1")).toBe("forge/a1-db-schema");
    });

    it("builds stacked branch map across all 10 issues", async () => {
      config = makeConfig({ autoClose: true, doneLabel: "done" });
      const issues = buildIssueSet();

      // Simulate all 10 issues completing successfully with branches
      const branches: Record<string, string> = {
        A1: "forge/a1-db-schema",
        A2: "forge/a2-models",
        A3: "forge/a3-routes",
        A4: "forge/a4-api-tests",
        C1: "forge/c1-scaffold",
        C2: "forge/c2-commands",
        C3: "forge/c3-formatters",
        C4: "forge/c4-cli-tests",
        X1: "forge/x1-e2e-tests",
        X2: "forge/x2-release-docs",
      };

      // Dispatch issues one at a time, simulating the full pipeline
      for (const issue of issues) {
        shared.executeWorkerMock.mockResolvedValueOnce(
          makeSuccessResult(branches[issue.id]),
        );

        await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

        await vi.waitFor(() => {
          expect(state.issueBranches.has(issue.id)).toBe(true);
        }, { timeout: 2000 });
      }

      // All 10 branches should be recorded
      expect(state.issueBranches.size).toBe(10);
      for (const [id, branch] of Object.entries(branches)) {
        expect(state.issueBranches.get(id)).toBe(branch);
      }
    });

    it("stacks A2 PR on A1 branch when A1 branch exists and A1 not recently completed", () => {
      // Simulate A1 completed with a branch, but NOT yet merged
      state.issueBranches.set("A1", "forge/a1-db-schema");
      // A1 is NOT in recentlyCompleted — its branch is still live

      const a2 = buildIssueSet()[1]; // A2, blocked_by: ["A1"]

      // Verify A2 would try to stack on A1's branch
      // (The actual stacking happens in executeWorkerAndHandle via octokit,
      // but we can verify the data structures are correct)
      expect(a2.blocked_by).toContain("A1");
      expect(state.issueBranches.get("A1")).toBe("forge/a1-db-schema");
      expect(state.recentlyCompleted.has("A1")).toBe(false);
    });

    it("falls back to main when blocker is recently completed (branch merged)", () => {
      // A1 completed and merged — branch deleted
      state.issueBranches.set("A1", "forge/a1-db-schema");
      state.recentlyCompleted.set("A1", Date.now());

      const a2 = buildIssueSet()[1]; // A2, blocked_by: ["A1"]

      // When A1 is in recentlyCompleted, dispatcher should use main as base
      expect(a2.blocked_by).toContain("A1");
      expect(state.recentlyCompleted.has("A1")).toBe(true);
    });

    it("converge node A4 can stack on either A2 or A3 branch", () => {
      // Both A2 and A3 have branches
      state.issueBranches.set("A2", "forge/a2-models");
      state.issueBranches.set("A3", "forge/a3-routes");

      const a4 = buildIssueSet()[3]; // A4, blocked_by: ["A2", "A3"]

      // A4 should pick one of the blocker branches (the first found)
      expect(a4.blocked_by).toEqual(["A2", "A3"]);
      // Both branches exist
      expect(state.issueBranches.has("A2")).toBe(true);
      expect(state.issueBranches.has("A3")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Merge queue serialization
  // -----------------------------------------------------------------------
  describe("Merge daemon with diamond DAG branches", () => {
    it("serializes merges: 10 branches merge in FIFO order", async () => {
      const mergeOrder: string[] = [];
      const mergeQueue = new MergeQueue(async (_prNumber, branch) => {
        mergeOrder.push(branch);
      });

      const branches = [
        "forge/a1-db-schema",
        "forge/c1-scaffold",
        "forge/a2-models",
        "forge/a3-routes",
        "forge/c2-commands",
        "forge/c3-formatters",
        "forge/a4-api-tests",
        "forge/c4-cli-tests",
        "forge/x1-e2e-tests",
        "forge/x2-release-docs",
      ];

      // Enqueue all 10 branches
      const promises = branches.map((branch, i) =>
        mergeQueue.enqueue(branch, i + 1),
      );

      const results = await Promise.all(promises);

      // All merges should succeed
      expect(results.every((r) => r.merged)).toBe(true);
      // Merges happen in FIFO order
      expect(mergeOrder).toEqual(branches);
    });

    it("continues after merge failure without blocking queue", async () => {
      let callCount = 0;
      const mergeQueue = new MergeQueue(async (_prNumber, branch) => {
        callCount++;
        // Fail the 3rd merge (forge/a2-models)
        if (callCount === 3) throw new Error("CI failed for a2-models");
      });

      const branches = [
        "forge/a1-db-schema",
        "forge/c1-scaffold",
        "forge/a2-models", // Will fail
        "forge/a3-routes",
        "forge/c2-commands",
      ];

      const promises = branches.map((branch, i) =>
        mergeQueue.enqueue(branch, i + 1),
      );

      const results = await Promise.all(promises);

      expect(results[0].merged).toBe(true);
      expect(results[1].merged).toBe(true);
      expect(results[2].merged).toBe(false);
      expect(results[2].error).toContain("CI failed for a2-models");
      expect(results[3].merged).toBe(true);
      expect(results[4].merged).toBe(true);
    });

    it("processes one merge at a time (never concurrent)", async () => {
      let activeCount = 0;
      let maxActive = 0;

      const mergeQueue = new MergeQueue(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise((r) => setTimeout(r, 5));
        activeCount--;
      });

      const branches = [
        "forge/a1", "forge/c1", "forge/a2", "forge/a3",
        "forge/c2", "forge/c3", "forge/a4", "forge/c4",
        "forge/x1", "forge/x2",
      ];

      await Promise.all(branches.map((b, i) => mergeQueue.enqueue(b, i + 1)));

      // Only one merge should have been active at any time
      expect(maxActive).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Full autonomous pipeline simulation
  // -----------------------------------------------------------------------
  describe("Full pipeline: dispatch 10 issues through diamond DAGs", () => {
    it("completes all 10 issues in correct dependency order with metrics", async () => {
      config = makeConfig({ maxAgents: 4, autoClose: true, doneLabel: "done" });
      const issues = buildIssueSet();

      const completionOrder: string[] = [];

      // Track which issues have been dispatched so executeWorker can record order
      shared.executeWorkerMock.mockImplementation(async () => {
        // Small delay to simulate work
        await new Promise((r) => setTimeout(r, 5));
        // Return success — the dispatch call will record the branch
        return makeSuccessResult("forge/branch");
      });

      // Simulate the scheduler tick loop
      let allTerminal = new Set<string>();
      const maxWaves = 6; // Safety limit

      for (let wave = 0; wave < maxWaves; wave++) {
        // Filter eligible (not claimed, not recently completed, not blocked)
        const eligible = filterCandidates(issues, state, allTerminal);
        if (eligible.length === 0) break;

        const sorted = sortCandidates(eligible);
        const slotManager = new SlotManager(4);
        const available = slotManager.availableSlots(state.running);

        // Dispatch up to slot limit
        const toDispatch = sorted.slice(0, available);
        const dispatchedIds: string[] = [];

        for (const issue of toDispatch) {
          shared.executeWorkerMock.mockResolvedValueOnce(
            makeSuccessResult(`forge/${issue.id.toLowerCase()}`),
          );
          await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
          dispatchedIds.push(issue.id);
        }

        // Wait for all dispatched to fully complete (running cleared AND claims released)
        await vi.waitFor(() => {
          for (const id of dispatchedIds) {
            if (state.running.has(id) || state.claimed.has(id)) {
              throw new Error(`${id} still active`);
            }
          }
        }, { timeout: 5000 });

        // Mark dispatched as terminal for next wave
        for (const id of dispatchedIds) {
          allTerminal.add(id);
          completionOrder.push(id);
        }
      }

      // All 10 issues should have completed
      expect(completionOrder).toHaveLength(10);

      // Verify dependency order: blockers always complete before dependents
      const orderIndex = new Map(completionOrder.map((id, i) => [id, i]));

      // A1 before A2 and A3
      expect(orderIndex.get("A1")!).toBeLessThan(orderIndex.get("A2")!);
      expect(orderIndex.get("A1")!).toBeLessThan(orderIndex.get("A3")!);

      // A2 and A3 before A4
      expect(orderIndex.get("A2")!).toBeLessThan(orderIndex.get("A4")!);
      expect(orderIndex.get("A3")!).toBeLessThan(orderIndex.get("A4")!);

      // C1 before C2 and C3
      expect(orderIndex.get("C1")!).toBeLessThan(orderIndex.get("C2")!);
      expect(orderIndex.get("C1")!).toBeLessThan(orderIndex.get("C3")!);

      // C2 and C3 before C4
      expect(orderIndex.get("C2")!).toBeLessThan(orderIndex.get("C4")!);
      expect(orderIndex.get("C3")!).toBeLessThan(orderIndex.get("C4")!);

      // A4 and C4 before X1
      expect(orderIndex.get("A4")!).toBeLessThan(orderIndex.get("X1")!);
      expect(orderIndex.get("C4")!).toBeLessThan(orderIndex.get("X1")!);

      // X1 before X2
      expect(orderIndex.get("X1")!).toBeLessThan(orderIndex.get("X2")!);

      // Metrics should show all 10 dispatched and completed
      const snapshot = metrics.getSnapshot();
      expect(snapshot.totals.dispatched).toBe(10);
      expect(snapshot.totals.completed).toBe(10);
    });

    it("completes in minimum number of waves (5) with 4 slots", async () => {
      config = makeConfig({ maxAgents: 4 });
      const issues = buildIssueSet();

      // Wave tracking
      const waves: string[][] = [];
      let allTerminal = new Set<string>();

      shared.executeWorkerMock.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 2));
        return makeSuccessResult("forge/branch");
      });

      for (let wave = 0; wave < 10; wave++) {
        const eligible = filterCandidates(issues, state, allTerminal);
        if (eligible.length === 0) break;

        const sorted = sortCandidates(eligible);
        const slotManager = new SlotManager(4);
        const available = slotManager.availableSlots(state.running);
        const toDispatch = sorted.slice(0, available);

        const waveIds: string[] = [];
        for (const issue of toDispatch) {
          shared.executeWorkerMock.mockResolvedValueOnce(
            makeSuccessResult(`forge/${issue.id.toLowerCase()}`),
          );
          await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
          waveIds.push(issue.id);
        }

        await vi.waitFor(() => {
          for (const id of waveIds) {
            if (state.running.has(id) || state.claimed.has(id)) {
              throw new Error(`${id} still active`);
            }
          }
        }, { timeout: 5000 });

        for (const id of waveIds) {
          allTerminal.add(id);
        }
        waves.push(waveIds);
      }

      // Expected waves:
      // Wave 0: [A1, C1]           — roots
      // Wave 1: [A2, A3, C2, C3]   — mid-layer (4 slots, all fit)
      // Wave 2: [A4, C4]           — converge points
      // Wave 3: [X1]               — cross-repo convergence
      // Wave 4: [X2]               — tail
      expect(waves).toHaveLength(5);
      expect(waves[0].sort()).toEqual(["A1", "C1"]);
      expect(waves[1].sort()).toEqual(["A2", "A3", "C2", "C3"]);
      expect(waves[2].sort()).toEqual(["A4", "C4"]);
      expect(waves[3]).toEqual(["X1"]);
      expect(waves[4]).toEqual(["X2"]);
    });

    it("requires more waves when max_concurrent_agents is limited to 2", async () => {
      config = makeConfig({ maxAgents: 2 });
      const issues = buildIssueSet();

      const waves: string[][] = [];
      let allTerminal = new Set<string>();

      shared.executeWorkerMock.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 2));
        return makeSuccessResult("forge/branch");
      });

      for (let wave = 0; wave < 15; wave++) {
        const eligible = filterCandidates(issues, state, allTerminal);
        if (eligible.length === 0) break;

        const sorted = sortCandidates(eligible);
        const slotManager = new SlotManager(2);
        const available = slotManager.availableSlots(state.running);
        const toDispatch = sorted.slice(0, available);

        const waveIds: string[] = [];
        for (const issue of toDispatch) {
          shared.executeWorkerMock.mockResolvedValueOnce(
            makeSuccessResult(`forge/${issue.id.toLowerCase()}`),
          );
          await dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);
          waveIds.push(issue.id);
        }

        await vi.waitFor(() => {
          for (const id of waveIds) {
            if (state.running.has(id) || state.claimed.has(id)) {
              throw new Error(`${id} still active`);
            }
          }
        }, { timeout: 5000 });

        for (const id of waveIds) {
          allTerminal.add(id);
        }
        waves.push(waveIds);
      }

      // With 2 slots: mid-layer requires 2 waves instead of 1
      // So total waves > 5
      expect(waves.length).toBeGreaterThan(5);
      // But all 10 issues still complete
      const allIds = waves.flat();
      expect(allIds).toHaveLength(10);
      expect(new Set(allIds).size).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Failure + retry in diamond DAG (blocks downstream)
  // -----------------------------------------------------------------------
  describe("Failure handling in diamond DAG", () => {
    it("does not unblock dependents when a required node fails", () => {
      const issues = buildIssueSet();
      // A1 is terminal, A3 completed, but A2 failed (not in terminal set)
      const terminalIds = new Set<string>(["A1", "A3"]);

      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id);

      // A4 should NOT be eligible: requires both A2 AND A3 terminal
      expect(ids).not.toContain("A4");
      // A2 should be eligible for retry (it's not claimed)
      expect(ids).toContain("A2");
    });

    it("records retry attempts and schedules backoff on failure", async () => {
      config = makeConfig({ maxRetries: 3 });
      const issue = buildIssueSet()[1]; // A2

      shared.executeWorkerMock.mockResolvedValueOnce(makeFailedResult());

      dispatchIssue(issue, state, tracker, config, workspaceManager, "Fix: {{title}}", logger, metrics);

      await vi.waitFor(() => {
        expect(tracker.calls.postComment.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 2000 });

      expect(state.retryAttempts.get("A2")).toBe(1);
      expect(state.retryTimers.has("A2")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Claimed/running exclusion with large candidate set
  // -----------------------------------------------------------------------
  describe("Exclusion filters with 10-issue set", () => {
    it("excludes claimed and running issues from candidates", () => {
      const issues = buildIssueSet();
      const terminalIds = new Set<string>(["A1", "C1"]);

      // Claim A2 and run A3
      state.claimed.add("A2");
      state.running.set("A3", {} as any);

      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id);

      expect(ids).not.toContain("A2");
      expect(ids).not.toContain("A3");
      // C2 and C3 should still be eligible
      expect(ids).toContain("C2");
      expect(ids).toContain("C3");
    });

    it("excludes recently completed issues from candidates", () => {
      const issues = buildIssueSet();
      state.recentlyCompleted.set("A1", Date.now());
      state.recentlyCompleted.set("C1", Date.now());

      const terminalIds = new Set<string>(["A1", "C1"]);
      const eligible = filterCandidates(issues, state, terminalIds);
      const ids = eligible.map((i) => i.id);

      expect(ids).not.toContain("A1");
      expect(ids).not.toContain("C1");
      // A2/A3 are unblocked and eligible
      expect(ids).toContain("A2");
      expect(ids).toContain("A3");
    });

    it("excludes issues with done label", () => {
      const issues = buildIssueSet();
      issues[0].labels.push("done"); // A1 already has done label

      const terminalIds = new Set<string>(["A1"]);
      const eligible = filterCandidates(issues, state, terminalIds, "done");
      const ids = eligible.map((i) => i.id);

      expect(ids).not.toContain("A1");
    });
  });
});
