import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunPlan } from "../../src/workflow/types.js";

// --- Hoisted mocks ---
const mocks = vi.hoisted(() => {
  const implementerContainer = {
    getArchive: vi.fn().mockResolvedValue(Buffer.from("fake-tar")),
    putArchive: vi.fn().mockResolvedValue(undefined),
  };
  return { implementerContainer };
});

// Mock prepareExecution (shared prepare phase from single.ts)
vi.mock("../../src/orchestration/single.js", () => ({
  prepareExecution: vi.fn().mockResolvedValue({
    container: mocks.implementerContainer,
    adapter: { name: "claude-code", buildShellCommand: vi.fn().mockReturnValue("echo test") },
    agentOptions: { model: "", maxTurns: 50, timeout: 30000, flags: [], workingDir: "/workspace" },
    agentEnv: [],
    resolvedImage: "forgectl/code-node20",
  }),
}));

vi.mock("../../src/agent/invoke.js", () => ({
  invokeAgent: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1000 }),
}));

vi.mock("../../src/context/prompt.js", () => ({
  buildPrompt: vi.fn().mockReturnValue("test prompt"),
}));

vi.mock("../../src/container/runner.js", () => ({
  createContainer: vi.fn().mockResolvedValue({
    putArchive: vi.fn().mockResolvedValue(undefined),
  }),
  destroyContainer: vi.fn().mockResolvedValue(undefined),
  execInContainer: vi.fn(),
}));

vi.mock("../../src/agent/registry.js", () => ({
  getAgentAdapter: vi.fn().mockReturnValue({
    name: "claude-code",
    buildShellCommand: vi.fn().mockReturnValue("echo test"),
  }),
}));

vi.mock("../../src/auth/claude.js", () => ({
  getClaudeAuth: vi.fn().mockResolvedValue({ type: "api_key", apiKey: "test-key" }),
}));

vi.mock("../../src/auth/codex.js", () => ({
  getCodexAuth: vi.fn().mockResolvedValue("test-openai-key"),
}));

vi.mock("../../src/auth/mount.js", () => ({
  prepareClaudeMounts: vi.fn().mockReturnValue({ binds: [], env: {}, cleanup: vi.fn() }),
  prepareCodexMounts: vi.fn().mockReturnValue({ binds: [], env: {}, cleanup: vi.fn() }),
}));

vi.mock("../../src/validation/runner.js", () => ({
  runValidationLoop: vi.fn().mockResolvedValue({ passed: true, totalAttempts: 1, stepResults: [] }),
}));

vi.mock("../../src/output/collector.js", () => ({
  collectOutput: vi.fn().mockResolvedValue({
    mode: "git",
    branch: "forge/test",
    sha: "abc123",
    filesChanged: 3,
    insertions: 50,
    deletions: 10,
  }),
}));

vi.mock("../../src/container/cleanup.js", () => ({
  cleanupRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

import { executeReviewMode } from "../../src/orchestration/review.js";
import { emitRunEvent } from "../../src/logging/events.js";
import { invokeAgent } from "../../src/agent/invoke.js";
import { runValidationLoop } from "../../src/validation/runner.js";
import { destroyContainer } from "../../src/container/runner.js";
import { cleanupRun } from "../../src/container/cleanup.js";
import { collectOutput } from "../../src/output/collector.js";
import { Logger } from "../../src/logging/logger.js";

function makePlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    runId: "forge-test-001",
    task: "Add rate limiting",
    workflow: {
      name: "code",
      description: "",
      container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: [],
      system: "",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: true, system: "Review the code." },
    },
    agent: { type: "claude-code", model: "", maxTurns: 50, timeout: 300000, flags: [] },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: { mode: "repo", sources: ["/tmp/repo"], mountPath: "/workspace", exclude: [] },
    context: { system: "", files: [], inject: [] },
    validation: { steps: [], lintSteps: [], onFailure: "abandon" },
    output: { mode: "git", path: "/workspace", collect: [], hostDir: "/tmp/out" },
    orchestration: {
      mode: "review",
      review: {
        enabled: true,
        system: "You are a code reviewer.",
        maxRounds: 2,
        agent: "claude-code",
        model: "",
      },
    },
    commit: {
      message: { prefix: "[forge]", template: "{{task}}", includeTask: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    ...overrides,
  } as RunPlan;
}

describe("executeReviewMode", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger(false);
    vi.clearAllMocks();
    // Reset default mock for implementer container
    mocks.implementerContainer.getArchive.mockResolvedValue(Buffer.from("fake-tar"));
    mocks.implementerContainer.putArchive.mockResolvedValue(undefined);
  });

  it("exits after first round when reviewer approves", async () => {
    vi.mocked(invokeAgent)
      // 1st call: implementer initial execution
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // 2nd call: reviewer says LGTM
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Everything looks good.\n\nLGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(true);
    expect(result.review).toBeDefined();
    expect(result.review!.approved).toBe(true);
    expect(result.review!.approvedOnRound).toBe(1);
    expect(result.review!.totalRounds).toBe(1);
    expect(result.output).toBeDefined();
    // invokeAgent called 2 times: implementer + reviewer
    expect(vi.mocked(invokeAgent)).toHaveBeenCalledTimes(2);
  });

  it("re-invokes implementer when reviewer finds issues, then approves", async () => {
    vi.mocked(invokeAgent)
      // 1st: implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // 2nd: reviewer round 1 — issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Missing error handling\n2. No tests", stderr: "", durationMs: 500 })
      // 3rd: implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // 4th: reviewer round 2 — approved
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(true);
    expect(result.review!.approved).toBe(true);
    expect(result.review!.approvedOnRound).toBe(2);
    expect(result.review!.totalRounds).toBe(2);
    // 4 invokeAgent calls: implementer + reviewer1 + fix + reviewer2
    expect(vi.mocked(invokeAgent)).toHaveBeenCalledTimes(4);
  });

  it("stops after maxRounds and reports failure", async () => {
    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Issue A", stderr: "", durationMs: 500 })
      // implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // reviewer round 2 — still issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Issue B", stderr: "", durationMs: 500 });

    const plan = makePlan({
      orchestration: {
        mode: "review",
        review: { enabled: true, system: "Review.", maxRounds: 2, agent: "claude-code", model: "" },
      },
    });

    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.review!.approved).toBe(false);
    expect(result.review!.totalRounds).toBe(2);
    expect(result.review!.approvedOnRound).toBeUndefined();
    // Output is still collected since validation passed
    expect(vi.mocked(collectOutput)).toHaveBeenCalled();
  });

  it("handles validation failure during fix cycle with abandon policy", async () => {
    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Bug found", stderr: "", durationMs: 500 })
      // implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "tried to fix", stderr: "", durationMs: 1000 });

    // Initial validation passes, re-validation after fix fails
    vi.mocked(runValidationLoop)
      .mockResolvedValueOnce({ passed: true, totalAttempts: 1, stepResults: [] })
      .mockResolvedValueOnce({ passed: false, totalAttempts: 2, stepResults: [{ name: "test", passed: false, attempts: 2 }] });

    const plan = makePlan({
      validation: {
        steps: [{ name: "test", command: "npm test", retries: 2, description: "Tests" }],
        lintSteps: [],
        onFailure: "abandon",
      },
    });

    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed during review fix cycle");
    expect(result.review).toBeDefined();
    expect(result.review!.approved).toBe(false);
    // Output should NOT be collected since validation failed with abandon
    expect(vi.mocked(collectOutput)).not.toHaveBeenCalled();
  });

  it("handles initial validation failure with abandon policy", async () => {
    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 });

    vi.mocked(runValidationLoop)
      .mockResolvedValueOnce({ passed: false, totalAttempts: 3, stepResults: [{ name: "lint", passed: false, attempts: 3 }] });

    const plan = makePlan({
      validation: {
        steps: [{ name: "lint", command: "npm run lint", retries: 3, description: "Lint" }],
        lintSteps: [],
        onFailure: "abandon",
      },
    });

    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    // Review loop should not even start
    expect(result.review).toBeUndefined();
  });

  it("cleans up reviewer container even on errors", async () => {
    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer throws
      .mockRejectedValueOnce(new Error("Agent crashed"));

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent crashed");
    // cleanupRun should be called for both reviewer and implementer cleanup
    expect(vi.mocked(cleanupRun)).toHaveBeenCalledTimes(2);
  });

  it("destroys reviewer container after each round", async () => {
    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Issue", stderr: "", durationMs: 500 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    await executeReviewMode(plan, logger);

    // destroyContainer called once per review round (2 rounds)
    expect(vi.mocked(destroyContainer)).toHaveBeenCalledTimes(2);
  });

  it("snapshots workspace from implementer to reviewer container", async () => {
    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    await executeReviewMode(plan, logger);

    // getArchive called on implementer container
    expect(mocks.implementerContainer.getArchive).toHaveBeenCalledWith({ path: "/workspace" });
  });

  it("returns review summary even when not approved but output collected", async () => {
    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Critical issue", stderr: "", durationMs: 500 });

    const plan = makePlan({
      orchestration: {
        mode: "review",
        review: { enabled: true, system: "Review.", maxRounds: 1, agent: "claude-code", model: "" },
      },
    });

    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.review!.totalRounds).toBe(1);
    expect(result.review!.approved).toBe(false);
    // Output still collected because validation passed
    expect(result.output).toBeDefined();
  });

  it("self-addresses MUST_FIX comments with structured context", async () => {
    const structuredOutput = 'Issues found:\n```json\n[{"file":"src/foo.ts","line":42,"severity":"MUST_FIX","message":"Missing null check","suggested_fix":"Add if (x != null) guard"}]\n```';

    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — structured comments
      .mockResolvedValueOnce({ exitCode: 0, stdout: structuredOutput, stderr: "", durationMs: 500 })
      // implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // reviewer round 2 — approved
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(true);
    expect(result.review!.approved).toBe(true);
    expect(result.review!.approvedOnRound).toBe(2);
    expect(result.review!.comments).toHaveLength(1);
    expect(result.review!.comments![0].severity).toBe("MUST_FIX");
  });

  it("escalates to human after 2 failed review rounds", async () => {
    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: '```json\n[{"file":"a.ts","line":1,"severity":"MUST_FIX","message":"bug"}]\n```', stderr: "", durationMs: 500 })
      // implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // reviewer round 2 — still issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: '```json\n[{"file":"a.ts","line":1,"severity":"MUST_FIX","message":"still buggy"}]\n```', stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(false);
    expect(result.review!.approved).toBe(false);
    expect(result.review!.totalRounds).toBe(2);
    expect(result.review!.escalatedToHuman).toBe(true);
    // Escalation event should be emitted
    const escalationCalls = vi.mocked(emitRunEvent).mock.calls.filter(
      (call) => call[0].type === "escalation",
    );
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0][0].data).toEqual(
      expect.objectContaining({ reason: "review_max_rounds_exhausted", rounds: 2 }),
    );
  });

  it("caps maxRounds at 2 even when plan specifies higher", async () => {
    vi.mocked(invokeAgent)
      // implementer initial run
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Issue A", stderr: "", durationMs: 500 })
      // implementer fix
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // reviewer round 2 — still issues
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1. Issue B", stderr: "", durationMs: 500 });

    const plan = makePlan({
      orchestration: {
        mode: "review",
        review: { enabled: true, system: "Review.", maxRounds: 5, agent: "claude-code", model: "" },
      },
    });

    const result = await executeReviewMode(plan, logger);

    // Should stop at 2 rounds even though plan says 5
    expect(result.review!.totalRounds).toBe(2);
    expect(result.review!.escalatedToHuman).toBe(true);
    // Only 4 invokeAgent calls: implementer + reviewer1 + fix + reviewer2
    expect(vi.mocked(invokeAgent)).toHaveBeenCalledTimes(4);
  });

  it("populates review_rounds in review summary", async () => {
    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.review).toBeDefined();
    expect(result.review!.totalRounds).toBe(1);
  });

  it("ignores NIT comments in self-addressing loop", async () => {
    // Only NITs — no actionable comments to fix, but still not approved
    const nitOutput = '```json\n[{"file":"a.ts","line":1,"severity":"NIT","message":"trailing whitespace"}]\n```';

    vi.mocked(invokeAgent)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1000 })
      // reviewer round 1 — only NITs
      .mockResolvedValueOnce({ exitCode: 0, stdout: nitOutput, stderr: "", durationMs: 500 })
      // implementer fix (uses plain feedback since no actionable structured comments)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "", durationMs: 1000 })
      // reviewer round 2
      .mockResolvedValueOnce({ exitCode: 0, stdout: "LGTM", stderr: "", durationMs: 500 });

    const plan = makePlan();
    const result = await executeReviewMode(plan, logger);

    expect(result.success).toBe(true);
    expect(result.review!.approved).toBe(true);
  });
});
