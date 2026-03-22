import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────
// Change 3: Build Gate in Worker (integration)
// ──────────────────────────────────────────────────────

// Re-use the mocked worker setup pattern
vi.mock("../../src/orchestration/single.js", () => ({
  prepareExecution: vi.fn(),
}));
vi.mock("../../src/agent/session.js", () => ({
  createAgentSession: vi.fn(),
}));
vi.mock("../../src/container/cleanup.js", () => ({
  cleanupRun: vi.fn(),
}));
vi.mock("../../src/agent/registry.js", () => ({
  getAgentAdapter: vi.fn(() => ({
    buildCommand: vi.fn(),
    buildEnv: vi.fn(),
  })),
}));
vi.mock("../../src/validation/runner.js", () => ({
  runValidationLoop: vi.fn(),
  runValidationGate: vi.fn(),
}));
vi.mock("../../src/output/git.js", () => ({
  collectGitOutput: vi.fn(),
  HARD_EXCLUDE_PATTERNS: [],
}));
vi.mock("../../src/governance/autonomy.js", () => ({
  needsPostApproval: vi.fn().mockReturnValue(false),
}));
vi.mock("../../src/governance/approval.js", () => ({
  enterPendingOutputApproval: vi.fn(),
}));
vi.mock("../../src/governance/rules.js", () => ({
  evaluateAutoApprove: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/kg/builder.js", () => ({
  buildFullGraph: vi.fn().mockResolvedValue({ modules: 0, edges: 0 }),
}));

const { executeWorker } = await import("../../src/orchestrator/worker.js");
const { prepareExecution } = await import("../../src/orchestration/single.js");
const { createAgentSession } = await import("../../src/agent/session.js");
const { cleanupRun } = await import("../../src/container/cleanup.js");
const { runValidationLoop, runValidationGate } = await import("../../src/validation/runner.js");
const { collectGitOutput } = await import("../../src/output/git.js");

import type { TrackerIssue } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { AgentResult } from "../../src/agent/session.js";
import type { WorkspaceInfo } from "../../src/workspace/manager.js";

function makeIssue(): TrackerIssue {
  return {
    id: "123", identifier: "issue-42", title: "Fix bug",
    description: "Bug desc", state: "open", priority: "P1",
    labels: ["bug"], assignees: ["alice"],
    url: "https://github.com/test/repo/issues/42",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    blocked_by: [], metadata: {},
  };
}

function makeConfig(): ForgectlConfig {
  return {
    agent: { type: "claude-code", model: "sonnet", max_turns: 50, timeout: "30m", flags: [] },
    container: { image: "node:20", network: { mode: "open" }, resources: { memory: "4g", cpus: 2 } },
    repo: { branch: { template: "forge/{{slug}}/{{ts}}", base: "main" }, exclude: ["node_modules/"] },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" }, sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    board: { state_dir: "~/.forgectl/board", scheduler_tick_seconds: 30, max_concurrent_card_runs: 2 },
  } as ForgectlConfig;
}

const mockAgentResult: AgentResult = {
  stdout: "Done", stderr: "", status: "completed",
  tokenUsage: { input: 1000, output: 500, total: 1500 },
  durationMs: 30_000, turnCount: 5,
};

const mockSession = {
  invoke: vi.fn().mockResolvedValue(mockAgentResult),
  isAlive: vi.fn().mockReturnValue(true),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockWorkspaceManager = {
  ensureWorkspace: vi.fn(),
  runBeforeHook: vi.fn(),
  runAfterHook: vi.fn(),
  removeWorkspace: vi.fn(),
  cleanupTerminalWorkspaces: vi.fn(),
  getWorkspacePath: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("executeWorker build gate integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceManager.ensureWorkspace.mockResolvedValue({
      path: "/tmp/workspaces/issue-42", identifier: "issue-42", created: false,
    } as WorkspaceInfo);
    mockWorkspaceManager.runBeforeHook.mockResolvedValue(undefined);
    mockWorkspaceManager.runAfterHook.mockResolvedValue(undefined);
    vi.mocked(prepareExecution).mockResolvedValue({
      container: { id: "mock" } as any, adapter: {} as any,
      agentOptions: {} as any, agentEnv: [], resolvedImage: "node:20",
    });
    vi.mocked(createAgentSession).mockReturnValue(mockSession as any);
    vi.mocked(cleanupRun).mockResolvedValue(undefined);
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git", branch: "forge/test/b", sha: "abc", filesChanged: 1, insertions: 5, deletions: 2,
    });
  });

  it("calls runValidationGate when validation loop passes", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [{ name: "build", passed: true, attempts: 1 }],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [{ name: "build", passed: true, attempts: 1 }],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(runValidationGate).toHaveBeenCalledOnce();
  });

  it("does NOT call runValidationGate when validation loop fails", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: false, totalAttempts: 3, stepResults: [{ name: "build", passed: false, attempts: 3 }],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(runValidationGate).not.toHaveBeenCalled();
  });

  it("does NOT call runValidationGate when no validation steps", async () => {
    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any);

    expect(runValidationGate).not.toHaveBeenCalled();
    expect(runValidationLoop).not.toHaveBeenCalled();
  });

  it("marks run as failed when build gate fails", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [{ name: "build", passed: true, attempts: 1 }],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: false, totalAttempts: 1, stepResults: [{ name: "build", passed: false, attempts: 1 }],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };

    const result = await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(result.agentResult.status).toBe("failed");
    expect(result.agentResult.stderr).toContain("build gate failed");
  });

  it("skips collectGitOutput when build gate fails", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: false, totalAttempts: 1, stepResults: [{ name: "test", passed: false, attempts: 1 }],
    });

    const validationConfig = {
      steps: [{ name: "test", command: "npm test", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(collectGitOutput).not.toHaveBeenCalled();
  });

  it("calls collectGitOutput when build gate passes", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(collectGitOutput).toHaveBeenCalled();
  });

  it("returns no branch when build gate fails (no PR created)", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: false, totalAttempts: 1, stepResults: [{ name: "build", passed: false, attempts: 1 }],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    const result = await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(result.branch).toBeUndefined();
  });

  it("updates validationResult with gate result on gate failure", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [{ name: "build", passed: true, attempts: 1 }],
    });
    const gateResult = {
      passed: false, totalAttempts: 1,
      stepResults: [{ name: "build", passed: false, attempts: 1 }],
    };
    vi.mocked(runValidationGate).mockResolvedValue(gateResult);

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    const result = await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(result.validationResult).toEqual(gateResult);
  });

  it("logs error when gate fails", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: false, totalAttempts: 1, stepResults: [],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(mockLogger.error).toHaveBeenCalledWith(
      "worker",
      expect.stringContaining("Build gate failed"),
    );
  });

  it("logs skip message when output collection is skipped", async () => {
    vi.mocked(runValidationLoop).mockResolvedValue({
      passed: true, totalAttempts: 1, stepResults: [],
    });
    vi.mocked(runValidationGate).mockResolvedValue({
      passed: false, totalAttempts: 1, stepResults: [],
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "worker",
      expect.stringContaining("Skipping output collection"),
    );
  });

  it("gate runs AFTER validation loop and BEFORE collectGitOutput in order", async () => {
    const callOrder: string[] = [];

    vi.mocked(runValidationLoop).mockImplementation(async () => {
      callOrder.push("validationLoop");
      return { passed: true, totalAttempts: 1, stepResults: [] };
    });
    vi.mocked(runValidationGate).mockImplementation(async () => {
      callOrder.push("validationGate");
      return { passed: true, totalAttempts: 1, stepResults: [] };
    });
    vi.mocked(collectGitOutput).mockImplementation(async () => {
      callOrder.push("collectGitOutput");
      return { mode: "git" as const, branch: "b", sha: "s", filesChanged: 0, insertions: 0, deletions: 0 };
    });

    const validationConfig = {
      steps: [{ name: "build", command: "npm run build", retries: 1, description: "" }],
      on_failure: "abandon" as const,
    };

    await executeWorker(makeIssue(), makeConfig(), mockWorkspaceManager as any,
      "Fix: {{issue.title}}", 1, mockLogger as any, undefined, validationConfig);

    expect(callOrder).toEqual(["validationLoop", "validationGate", "collectGitOutput"]);
  });
});

// ──────────────────────────────────────────────────────
// Change 4: Hard CI Gate — verify source code patterns
// ──────────────────────────────────────────────────────

describe("autoMergeWithCI safety patterns", () => {
  it("does NOT contain last-resort resolveAndMerge fallback on merge failure", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).not.toContain("// Last resort: resolve and retry");
  });

  it("contains CI failure comment", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("CI checks failed. Leaving PR open");
  });

  it("contains CI timeout comment", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("CI checks timed out after 15 minutes");
  });

  it("contains merge failure comment", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("Merge failed and conflict resolution failed");
  });

  it("uses ciResolved flag for timeout detection", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("ciResolved");
    expect(source).toContain("if (!ciResolved)");
  });
});

// ──────────────────────────────────────────────────────
// Change 5: Merge Queue integration in createPullRequest
// ──────────────────────────────────────────────────────

describe("createPullRequest uses merge queue", () => {
  it("enqueues merge via mergeQueue instead of direct autoMergeWithCI call", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/tracker/github.ts", import.meta.url),
      "utf-8",
    );
    expect(source).toContain("mergeQueue.enqueue(branch, data.number)");
    expect(source).not.toContain("void autoMergeWithCI(owner, repo, branch, data.number");
  });

  it("merge queue is exposed on the adapter", async () => {
    const { createGitHubAdapter } = await import("../../src/tracker/github.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "5000" },
      json: async () => ({}),
    }));
    const adapter = createGitHubAdapter({
      kind: "github", token: "test", repo: "acme/repo",
      active_states: ["open"], terminal_states: ["closed"],
      poll_interval_ms: 60000, auto_close: false,
    });
    expect(adapter.mergeQueue).toBeDefined();
    expect(typeof adapter.mergeQueue.enqueue).toBe("function");
    expect(adapter.mergeQueue.pending).toBe(0);
    expect(adapter.mergeQueue.isProcessing).toBe(false);
    vi.unstubAllGlobals();
  });
});
