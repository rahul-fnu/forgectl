import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildResultComment, type CommentData } from "../../src/orchestrator/comment.js";
import type { TrackerIssue } from "../../src/tracker/types.js";
import type { AgentResult, TokenUsage } from "../../src/agent/session.js";
import type { ExecutionResult } from "../../src/orchestration/single.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { WorkspaceInfo } from "../../src/workspace/manager.js";

describe("buildResultComment", () => {
  const baseData: CommentData = {
    status: "completed",
    durationMs: 154_000,
    agentType: "claude-code",
    attempt: 1,
    tokenUsage: { input: 12_345, output: 6_789, total: 19_134 },
  };

  it("includes Pass for completed status", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("Pass");
  });

  it("includes Fail for failed status", () => {
    const result = buildResultComment({ ...baseData, status: "failed" });
    expect(result).toContain("Fail");
  });

  it("includes human-readable duration", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("2m 34s");
  });

  it("includes token usage table with comma-formatted numbers", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("12,345");
    expect(result).toContain("6,789");
    expect(result).toContain("19,134");
  });

  it("includes agent type", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("claude-code");
  });

  it("includes attempt number", () => {
    const result = buildResultComment({ ...baseData, attempt: 3 });
    const result1 = buildResultComment(baseData);
    expect(result).toContain("3");
    expect(result1).toContain("1");
  });

  it("includes validation checklist when validationResults provided", () => {
    const data: CommentData = {
      ...baseData,
      validationResults: [
        { name: "typecheck", passed: true },
        { name: "lint", passed: false, error: "2 errors found" },
      ],
    };
    const result = buildResultComment(data);
    expect(result).toContain("[x] typecheck");
    expect(result).toContain("[ ] lint");
    expect(result).toContain("2 errors found");
  });

  it("omits validation section when validationResults is empty", () => {
    const data: CommentData = { ...baseData, validationResults: [] };
    const result = buildResultComment(data);
    expect(result).not.toContain("Validation");
  });

  it("omits validation section when validationResults is undefined", () => {
    const result = buildResultComment(baseData);
    expect(result).not.toContain("Validation");
  });

  it("includes branch line when branch provided", () => {
    const data: CommentData = { ...baseData, branch: "forge/issue-42/abc123" };
    const result = buildResultComment(data);
    expect(result).toContain("forge/issue-42/abc123");
  });

  it("includes forgectl Agent Report header", () => {
    const result = buildResultComment(baseData);
    expect(result).toContain("## forgectl Agent Report");
  });

  it("formats duration for sub-minute durations", () => {
    const result = buildResultComment({ ...baseData, durationMs: 45_000 });
    expect(result).toContain("45s");
  });

  it("formats duration for hour+ durations", () => {
    const result = buildResultComment({ ...baseData, durationMs: 3_661_000 });
    expect(result).toContain("1h 1m 1s");
  });
});

// ---- Worker lifecycle tests ----

// Mock dependencies before importing worker
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
}));

vi.mock("../../src/governance/autonomy.js", () => ({
  needsPostApproval: vi.fn(),
}));

vi.mock("../../src/governance/approval.js", () => ({
  enterPendingOutputApproval: vi.fn(),
}));

vi.mock("../../src/governance/rules.js", () => ({
  evaluateAutoApprove: vi.fn(),
}));

const { buildOrchestratedRunPlan, executeWorker } = await import("../../src/orchestrator/worker.js");
const { prepareExecution } = await import("../../src/orchestration/single.js");
const { createAgentSession } = await import("../../src/agent/session.js");
const { cleanupRun } = await import("../../src/container/cleanup.js");
const { runValidationLoop, runValidationGate } = await import("../../src/validation/runner.js");
const { collectGitOutput } = await import("../../src/output/git.js");
const { needsPostApproval } = await import("../../src/governance/autonomy.js");
const { enterPendingOutputApproval } = await import("../../src/governance/approval.js");
const { evaluateAutoApprove } = await import("../../src/governance/rules.js");

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "123",
    identifier: "issue-42",
    title: "Fix login bug",
    description: "Login form crashes on empty password",
    state: "open",
    priority: "P1",
    labels: ["bug", "auth"],
    assignees: ["alice"],
    url: "https://github.com/test/repo/issues/42",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    blocked_by: [],
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ForgectlConfig> = {}): ForgectlConfig {
  return {
    agent: {
      type: "claude-code",
      model: "sonnet",
      max_turns: 50,
      timeout: "30m",
      flags: [],
    },
    container: {
      image: "node:20",
      network: { mode: "open" },
      resources: { memory: "4g", cpus: 2 },
    },
    repo: {
      branch: { template: "forge/{{slug}}/{{ts}}", base: "main" },
      exclude: ["node_modules/", "dist/"],
    },
    orchestration: { mode: "single", review: { max_rounds: 3 } },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", include_task: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    output: { dir: "./forge-output", log_dir: ".forgectl/runs" },
    board: { state_dir: "~/.forgectl/board", scheduler_tick_seconds: 30, max_concurrent_card_runs: 2 },
    ...overrides,
  } as ForgectlConfig;
}

describe("buildOrchestratedRunPlan", () => {
  const issue = makeIssue();
  const config = makeConfig();
  const workspacePath = "/tmp/workspaces/issue-42";
  const promptTemplate = "Fix this: {{issue.title}}\n\n{{issue.description}}";

  it("sets input.sources[0] to workspace path", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.input.sources[0]).toBe(workspacePath);
  });

  it("sets input.mode to repo", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.input.mode).toBe("repo");
  });

  it("renders prompt template with issue data", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.task).toContain("Fix login bug");
    expect(plan.task).toContain("Login form crashes on empty password");
  });

  it("generates unique runId", () => {
    const plan1 = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    const plan2 = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 2);
    expect(plan1.runId).toBeTruthy();
    expect(plan2.runId).toBeTruthy();
    expect(plan1.runId).not.toBe(plan2.runId);
  });

  it("sets output mode to git with workspace hostDir", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.output.mode).toBe("git");
    expect(plan.output.hostDir).toBe(workspacePath);
  });

  it("sets orchestration.mode to single", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.orchestration.mode).toBe("single");
  });

  it("populates validation steps from validationConfig", () => {
    const validationConfig = {
      steps: [{ name: "test", command: "npm test", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1, validationConfig);
    expect(plan.validation.steps).toHaveLength(1);
    expect(plan.validation.steps[0].name).toBe("test");
    expect(plan.validation.steps[0].command).toBe("npm test");
    expect(plan.validation.onFailure).toBe("abandon");
  });

  it("keeps empty validation steps when no validationConfig", () => {
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1);
    expect(plan.validation.steps).toEqual([]);
    expect(plan.validation.onFailure).toBe("abandon");
  });

  it("populates workflow.validation from validationConfig", () => {
    const validationConfig = {
      steps: [{ name: "lint", command: "npm run lint", retries: 2, description: "run linter" }],
      on_failure: "output-wip" as const,
    };
    const plan = buildOrchestratedRunPlan(issue, config, workspacePath, promptTemplate, 1, validationConfig);
    expect(plan.workflow.validation.steps).toHaveLength(1);
    expect(plan.workflow.validation.on_failure).toBe("output-wip");
  });
});

describe("executeWorker", () => {
  const issue = makeIssue();
  const config = makeConfig();
  const promptTemplate = "Fix this: {{issue.title}}";

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

  const mockAgentResult: AgentResult = {
    stdout: "Done",
    stderr: "",
    status: "completed",
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    durationMs: 30_000,
    turnCount: 5,
  };

  const mockSession = {
    invoke: vi.fn().mockResolvedValue(mockAgentResult),
    isAlive: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockContainer = { id: "mock-container-id" };

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkspaceManager.ensureWorkspace.mockResolvedValue({
      path: "/tmp/workspaces/issue-42",
      identifier: "issue-42",
      created: false,
    } as WorkspaceInfo);
    mockWorkspaceManager.runBeforeHook.mockResolvedValue(undefined);
    mockWorkspaceManager.runAfterHook.mockResolvedValue(undefined);

    vi.mocked(prepareExecution).mockResolvedValue({
      container: mockContainer as any,
      adapter: {} as any,
      agentOptions: {} as any,
      agentEnv: [],
      resolvedImage: "node:20",
    });

    vi.mocked(createAgentSession).mockReturnValue(mockSession as any);
    vi.mocked(cleanupRun).mockResolvedValue(undefined);
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git", branch: "forge/test/branch", sha: "abc123",
      filesChanged: 0, insertions: 0, deletions: 0,
    } as any);
  });

  it("calls workspaceManager.ensureWorkspace with issue identifier", async () => {
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(mockWorkspaceManager.ensureWorkspace).toHaveBeenCalledWith("issue-42");
  });

  it("calls workspaceManager.runBeforeHook before agent invocation", async () => {
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(mockWorkspaceManager.runBeforeHook).toHaveBeenCalledWith("issue-42");

    // Verify before hook called before prepareExecution
    const beforeHookOrder = mockWorkspaceManager.runBeforeHook.mock.invocationCallOrder[0];
    const prepareOrder = vi.mocked(prepareExecution).mock.invocationCallOrder[0];
    expect(beforeHookOrder).toBeLessThan(prepareOrder);
  });

  it("calls workspaceManager.runAfterHook after completion", async () => {
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(mockWorkspaceManager.runAfterHook).toHaveBeenCalledWith("issue-42");
  });

  it("creates CleanupContext with empty tempDirs", async () => {
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    const cleanupArg = vi.mocked(prepareExecution).mock.calls[0][2];
    expect(cleanupArg.tempDirs).toEqual([]);
  });

  it("returns WorkerResult with agentResult and comment", async () => {
    const result = await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(result.agentResult).toBeDefined();
    expect(result.agentResult.status).toBe("completed");
    expect(result.comment).toContain("Completed");
  });

  it("passes onActivity callback to createAgentSession", async () => {
    const onActivity = vi.fn();
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any, onActivity);
    const sessionOptions = vi.mocked(createAgentSession).mock.calls[0][4];
    expect(sessionOptions?.onActivity).toBe(onActivity);
  });

  it("calls cleanupRun to destroy container", async () => {
    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(cleanupRun).toHaveBeenCalled();
  });

  it("returns failure result when beforeHook throws", async () => {
    mockWorkspaceManager.runBeforeHook.mockRejectedValue(new Error("hook failed"));
    const result = await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(result.agentResult.status).toBe("failed");
    expect(result.comment).toContain("setup failed");
  });

  it("calls runValidationLoop when plan has validation steps", async () => {
    const validationResult = {
      passed: true,
      totalAttempts: 1,
      stepResults: [{ name: "test", passed: true, attempts: 1 }],
    };
    vi.mocked(runValidationLoop).mockResolvedValue(validationResult);
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git" as const,
      branch: "forge/issue-42/abc",
      sha: "abc123",
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
    });

    const validationConfig = {
      steps: [{ name: "test", command: "npm test", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };

    const result = await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, validationConfig,
    );

    expect(runValidationLoop).toHaveBeenCalled();
    expect(result.validationResult).toEqual(validationResult);
  });

  it("does NOT call runValidationLoop when no validation steps", async () => {
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git" as const,
      branch: "forge/issue-42/abc",
      sha: "abc123",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });

    await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(runValidationLoop).not.toHaveBeenCalled();
  });

  it("calls collectGitOutput and includes branch in WorkerResult", async () => {
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git" as const,
      branch: "forge/issue-42/abc",
      sha: "abc123",
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
    });

    const result = await executeWorker(issue, config, mockWorkspaceManager as any, promptTemplate, 1, mockLogger as any);
    expect(collectGitOutput).toHaveBeenCalled();
    expect(result.branch).toBe("forge/issue-42/abc");
    // Comment now uses github/comments.ts format (RunResult), branch is in WorkerResult.branch not comment text
    expect(result.comment).toContain("Completed");
  });

  it("keeps container alive until after validation and output collection", async () => {
    const callOrder: string[] = [];

    vi.mocked(collectGitOutput).mockImplementation(async () => {
      callOrder.push("collectGitOutput");
      return { mode: "git" as const, branch: "b", sha: "s", filesChanged: 0, insertions: 0, deletions: 0 };
    });
    mockSession.close.mockImplementation(async () => {
      callOrder.push("session.close");
    });
    vi.mocked(cleanupRun).mockImplementation(async () => {
      callOrder.push("cleanupRun");
    });

    const validationConfig = {
      steps: [{ name: "test", command: "npm test", retries: 3, description: "" }],
      on_failure: "abandon" as const,
    };
    vi.mocked(runValidationLoop).mockImplementation(async () => {
      callOrder.push("runValidationLoop");
      return { passed: true, totalAttempts: 1, stepResults: [] };
    });
    vi.mocked(runValidationGate).mockImplementation(async () => {
      callOrder.push("runValidationGate");
      return { passed: true, totalAttempts: 1, stepResults: [] };
    });

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, validationConfig,
    );

    // validation and output collection must happen before session close and cleanup
    expect(callOrder.indexOf("runValidationLoop")).toBeLessThan(callOrder.indexOf("session.close"));
    expect(callOrder.indexOf("collectGitOutput")).toBeLessThan(callOrder.indexOf("session.close"));
    expect(callOrder.indexOf("session.close")).toBeLessThan(callOrder.indexOf("cleanupRun"));
  });
});

describe("executeWorker post-gate", () => {
  const issue = makeIssue();
  const config = makeConfig();
  const promptTemplate = "Fix this: {{issue.title}}";

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

  const mockAgentResult: AgentResult = {
    stdout: "Done",
    stderr: "",
    status: "completed",
    tokenUsage: { input: 1000, output: 500, total: 1500 },
    durationMs: 30_000,
    turnCount: 5,
  };

  const mockSession = {
    invoke: vi.fn().mockResolvedValue(mockAgentResult),
    isAlive: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockContainer = { id: "mock-container-id" };

  const mockRunRepo = {
    insert: vi.fn(),
    findById: vi.fn().mockReturnValue({ id: "test-run-id", status: "running" }),
    updateStatus: vi.fn(),
    setGithubCommentId: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkspaceManager.ensureWorkspace.mockResolvedValue({
      path: "/tmp/workspaces/issue-42",
      identifier: "issue-42",
      created: false,
    } as WorkspaceInfo);
    mockWorkspaceManager.runBeforeHook.mockResolvedValue(undefined);
    mockWorkspaceManager.runAfterHook.mockResolvedValue(undefined);

    vi.mocked(prepareExecution).mockResolvedValue({
      container: mockContainer as any,
      adapter: {} as any,
      agentOptions: {} as any,
      agentEnv: [],
      resolvedImage: "node:20",
    });

    vi.mocked(createAgentSession).mockReturnValue(mockSession as any);
    vi.mocked(cleanupRun).mockResolvedValue(undefined);
    vi.mocked(collectGitOutput).mockResolvedValue({
      mode: "git" as const,
      branch: "forge/issue-42/abc",
      sha: "abc123",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });

    // Default: needsPostApproval returns false
    vi.mocked(needsPostApproval).mockReturnValue(false);
    vi.mocked(enterPendingOutputApproval).mockReturnValue(undefined);
    vi.mocked(evaluateAutoApprove).mockReturnValue(false);
  });

  it("calls enterPendingOutputApproval when autonomy is interactive", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(true);
    const governance = { autonomy: "interactive" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(needsPostApproval).toHaveBeenCalledWith("interactive");
    expect(enterPendingOutputApproval).toHaveBeenCalledWith(mockRunRepo, "test-run-id");
  });

  it("calls enterPendingOutputApproval when autonomy is supervised", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(true);
    const governance = { autonomy: "supervised" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(needsPostApproval).toHaveBeenCalledWith("supervised");
    expect(enterPendingOutputApproval).toHaveBeenCalledWith(mockRunRepo, "test-run-id");
  });

  it("does NOT call enterPendingOutputApproval when autonomy is full", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(false);
    const governance = { autonomy: "full" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(needsPostApproval).toHaveBeenCalledWith("full");
    expect(enterPendingOutputApproval).not.toHaveBeenCalled();
  });

  it("does NOT call enterPendingOutputApproval when autonomy is semi", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(false);
    const governance = { autonomy: "semi" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(needsPostApproval).toHaveBeenCalledWith("semi");
    expect(enterPendingOutputApproval).not.toHaveBeenCalled();
  });

  it("auto-approves when evaluateAutoApprove returns true", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(true);
    vi.mocked(evaluateAutoApprove).mockReturnValue(true);
    const governance = {
      autonomy: "interactive" as const,
      autoApprove: { label: "safe" },
      runRepo: mockRunRepo,
      runId: "test-run-id",
    };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(evaluateAutoApprove).toHaveBeenCalled();
    expect(enterPendingOutputApproval).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "governance",
      expect.stringContaining("Auto-approved"),
    );
  });

  it("still calls session.close and cleanupRun when entering pending_output_approval", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(true);
    const governance = { autonomy: "interactive" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(enterPendingOutputApproval).toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
    expect(cleanupRun).toHaveBeenCalled();
  });

  it("sets pendingApproval=true on WorkerResult when post-gate fires", async () => {
    vi.mocked(needsPostApproval).mockReturnValue(true);
    const governance = { autonomy: "interactive" as const, runRepo: mockRunRepo, runId: "test-run-id" };

    const result = await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any, undefined, undefined, undefined, governance,
    );

    expect(result.pendingApproval).toBe(true);
  });

  it("skips post-gate gracefully when governance is undefined", async () => {
    const result = await executeWorker(
      issue, config, mockWorkspaceManager as any, promptTemplate, 1,
      mockLogger as any,
    );

    expect(needsPostApproval).not.toHaveBeenCalled();
    expect(enterPendingOutputApproval).not.toHaveBeenCalled();
    expect(result.pendingApproval).toBeUndefined();
  });
});
