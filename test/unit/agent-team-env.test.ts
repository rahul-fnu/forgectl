import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunPlan } from "../../src/workflow/types.js";

// Mock all heavy dependencies before importing the module under test.
// vi.mock() calls are hoisted to the top of the file by vitest.
vi.mock("../../src/container/builder.js", () => ({
  ensureImage: vi.fn().mockResolvedValue("node:20"),
}));

vi.mock("../../src/container/runner.js", () => ({
  createContainer: vi.fn().mockResolvedValue({ id: "test-container-id" }),
}));

vi.mock("../../src/container/workspace.js", () => ({
  prepareRepoWorkspace: vi.fn().mockReturnValue("/tmp/test-workspace"),
  prepareFilesWorkspace: vi.fn().mockReturnValue({ inputDir: "/tmp/in", outputDir: "/tmp/out" }),
}));

vi.mock("../../src/auth/claude.js", () => ({
  getClaudeAuth: vi.fn().mockResolvedValue({ type: "api_key", apiKey: "test-key" }),
}));

vi.mock("../../src/auth/codex.js", () => ({
  getCodexAuth: vi.fn().mockResolvedValue({ type: "api_key", apiKey: "test-codex-key" }),
}));

vi.mock("../../src/auth/mount.js", () => ({
  prepareClaudeMounts: vi.fn().mockReturnValue({ binds: [], cleanup: vi.fn(), env: {} }),
  prepareCodexMounts: vi.fn().mockReturnValue({ binds: [], cleanup: vi.fn(), env: {} }),
}));

vi.mock("../../src/skills/mount.js", () => ({
  prepareSkillMounts: vi.fn().mockReturnValue({ mounts: { binds: [] }, addDirFlags: [] }),
}));

vi.mock("../../src/container/network.js", () => ({
  createIsolatedNetwork: vi.fn(),
  applyFirewall: vi.fn(),
}));

vi.mock("../../src/logging/events.js", () => ({
  emitRunEvent: vi.fn(),
}));

vi.mock("../../src/agent/registry.js", () => ({
  getAgentAdapter: vi.fn().mockReturnValue({ name: "claude-code", buildShellCommand: () => "" }),
}));

import { prepareExecution } from "../../src/orchestration/single.js";

/** Build a minimal RunPlan for testing. */
function makeRunPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    runId: "test-run-id",
    task: "do something",
    workflow: {
      name: "test",
      description: "test workflow",
      container: { image: "node:20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: [],
      system: "",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
      autonomy: "full",
      skills: [],
    },
    agent: {
      type: "claude-code",
      model: "claude-opus-4-5",
      maxTurns: 10,
      timeout: 60000,
      flags: [],
    },
    container: {
      image: "node:20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: {
      mode: "repo",
      sources: ["/tmp/source"],
      mountPath: "/workspace",
      exclude: [],
    },
    context: { system: "", files: [], inject: [] },
    validation: { steps: [], onFailure: "abandon" },
    output: { mode: "git", path: "/workspace", collect: [], hostDir: "/tmp/source" },
    orchestration: {
      mode: "single",
      review: { enabled: false, system: "", maxRounds: 0, agent: "claude-code", model: "" },
    },
    commit: {
      message: { prefix: "[forgectl]", template: "{{task}}", includeTask: true },
      author: { name: "forgectl", email: "forgectl@local" },
      sign: false,
    },
    ...overrides,
  };
}

/** Minimal mock logger. */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe("CLAUDE_NUM_TEAMMATES env var injection", () => {
  it("adds CLAUDE_NUM_TEAMMATES env var for claude-code team run", async () => {
    const plan = makeRunPlan({
      team: { size: 3, slotWeight: 3 },
    });
    const cleanup = { tempDirs: [], secretCleanups: [] };
    const logger = makeLogger();

    const result = await prepareExecution(plan, logger, cleanup);

    expect(result.agentEnv).toContain("CLAUDE_NUM_TEAMMATES=2");
  });

  it("does not add CLAUDE_NUM_TEAMMATES when noTeam is true", async () => {
    const plan = makeRunPlan({
      team: { size: 3, slotWeight: 3 },
      noTeam: true,
    });
    const cleanup = { tempDirs: [], secretCleanups: [] };
    const logger = makeLogger();

    const result = await prepareExecution(plan, logger, cleanup);

    const teamVars = result.agentEnv.filter((e: string) => e.startsWith("CLAUDE_NUM_TEAMMATES"));
    expect(teamVars).toHaveLength(0);
  });

  it("does not add CLAUDE_NUM_TEAMMATES when no team config", async () => {
    const plan = makeRunPlan({
      // No team field
    });
    const cleanup = { tempDirs: [], secretCleanups: [] };
    const logger = makeLogger();

    const result = await prepareExecution(plan, logger, cleanup);

    const teamVars = result.agentEnv.filter((e: string) => e.startsWith("CLAUDE_NUM_TEAMMATES"));
    expect(teamVars).toHaveLength(0);
  });

  it("warns for non-claude-code agent with team config", async () => {
    const plan = makeRunPlan({
      agent: { type: "codex", model: "o4-mini", maxTurns: 10, timeout: 60000, flags: [] },
      team: { size: 3, slotWeight: 3 },
    });
    const cleanup = { tempDirs: [], secretCleanups: [] };
    const logger = makeLogger();

    await prepareExecution(plan, logger, cleanup);

    const warnCalls: [string, string][] = logger.warn.mock.calls;
    const teamWarn = warnCalls.find((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("only supported for claude-code")),
    );
    expect(teamWarn).toBeDefined();
  });
});
