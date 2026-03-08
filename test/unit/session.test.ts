import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/agent/invoke.js", () => ({
  invokeAgent: vi.fn(),
}));

vi.mock("../../src/agent/registry.js", () => ({
  getAgentAdapter: vi.fn(),
}));

import { invokeAgent } from "../../src/agent/invoke.js";
import { getAgentAdapter } from "../../src/agent/registry.js";
import { createAgentSession } from "../../src/agent/session.js";
import { OneShotSession } from "../../src/agent/oneshot-session.js";
import { AppServerSession } from "../../src/agent/appserver-session.js";
import type { AgentAdapter, AgentOptions } from "../../src/agent/types.js";
import type { ExecResult } from "../../src/container/runner.js";
import type Docker from "dockerode";

const mockInvokeAgent = vi.mocked(invokeAgent);
const mockGetAgentAdapter = vi.mocked(getAgentAdapter);

const fakeAdapter: AgentAdapter = {
  name: "claude-code",
  buildShellCommand: vi.fn(() => "echo test"),
};

const fakeContainer = {} as Docker.Container;

const baseAgentOptions: AgentOptions = {
  model: "claude-sonnet",
  maxTurns: 1,
  timeout: 30000,
  flags: [],
  workingDir: "/workspace",
};

const baseExecResult: ExecResult = {
  exitCode: 0,
  stdout: "Hello world",
  stderr: "",
  durationMs: 1500,
};

describe("createAgentSession factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentAdapter.mockReturnValue(fakeAdapter);
  });

  it("returns OneShotSession for claude-code agent type", () => {
    const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
    expect(session).toBeInstanceOf(OneShotSession);
  });

  it("returns OneShotSession for codex agent type", () => {
    const session = createAgentSession("codex", fakeContainer, baseAgentOptions, []);
    expect(session).toBeInstanceOf(OneShotSession);
  });

  it("throws for unknown agent type (delegates to getAgentAdapter)", () => {
    mockGetAgentAdapter.mockImplementation(() => {
      throw new Error('Unknown agent: "unknown". Available: claude-code, codex');
    });
    expect(() => createAgentSession("unknown", fakeContainer, baseAgentOptions, [])).toThrow(
      /Unknown agent/
    );
  });

  it("returns AppServerSession when agentType is codex and useAppServer is true", () => {
    const session = createAgentSession("codex", fakeContainer, baseAgentOptions, [], { useAppServer: true });
    expect(session).toBeInstanceOf(AppServerSession);
  });

  it("returns OneShotSession when agentType is codex and useAppServer is false", () => {
    const session = createAgentSession("codex", fakeContainer, baseAgentOptions, [], { useAppServer: false });
    expect(session).toBeInstanceOf(OneShotSession);
  });

  it("returns OneShotSession when agentType is codex and useAppServer is undefined", () => {
    const session = createAgentSession("codex", fakeContainer, baseAgentOptions, []);
    expect(session).toBeInstanceOf(OneShotSession);
  });

  it("returns OneShotSession when agentType is claude-code even with useAppServer true", () => {
    const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, [], { useAppServer: true });
    expect(session).toBeInstanceOf(OneShotSession);
  });
});

describe("OneShotSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentAdapter.mockReturnValue(fakeAdapter);
    mockInvokeAgent.mockResolvedValue({ ...baseExecResult });
  });

  describe("invoke()", () => {
    it("delegates to invokeAgent and returns AgentResult", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, ["KEY=val"]);
      const result = await session.invoke("Do something");

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        fakeContainer,
        fakeAdapter,
        "Do something",
        baseAgentOptions,
        ["KEY=val"],
        undefined,
      );
      expect(result.stdout).toBe("Hello world");
      expect(result.stderr).toBe("");
    });

    it("returns status completed when exit code is 0", async () => {
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, exitCode: 0 });
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.status).toBe("completed");
    });

    it("returns status failed when exit code is non-zero", async () => {
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, exitCode: 1 });
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.status).toBe("failed");
    });

    it("defaults tokenUsage to zeros", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.tokenUsage).toEqual({ input: 0, output: 0, total: 0 });
    });

    it("sets turnCount to 1 for one-shot", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.turnCount).toBe(1);
    });

    it("durationMs comes from ExecResult", async () => {
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, durationMs: 2500 });
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.durationMs).toBe(2500);
    });

    it("stdout and stderr come from ExecResult", async () => {
      mockInvokeAgent.mockResolvedValue({
        ...baseExecResult,
        stdout: "out",
        stderr: "err",
      });
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      const result = await session.invoke("test");
      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
    });

    it("forwards timeout option to invokeAgent via AgentOptions", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      await session.invoke("test", { timeout: 60000 });

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        fakeContainer,
        fakeAdapter,
        "test",
        { ...baseAgentOptions, timeout: 60000 },
        [],
        undefined,
      );
    });
  });

  describe("activity callback", () => {
    it("fires when invokeAgent returns non-empty stdout", async () => {
      const onActivity = vi.fn();
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, [], { onActivity });
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, stdout: "output", stderr: "" });
      await session.invoke("test");
      expect(onActivity).toHaveBeenCalledTimes(1);
    });

    it("fires when invokeAgent returns non-empty stderr", async () => {
      const onActivity = vi.fn();
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, [], { onActivity });
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, stdout: "", stderr: "warning" });
      await session.invoke("test");
      expect(onActivity).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire when both stdout and stderr are empty", async () => {
      const onActivity = vi.fn();
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, [], { onActivity });
      mockInvokeAgent.mockResolvedValue({ ...baseExecResult, stdout: "", stderr: "" });
      await session.invoke("test");
      expect(onActivity).not.toHaveBeenCalled();
    });

    it("works fine without onActivity callback (no crash)", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      await expect(session.invoke("test")).resolves.toBeDefined();
    });
  });

  describe("lifecycle", () => {
    it("isAlive() returns true initially", () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      expect(session.isAlive()).toBe(true);
    });

    it("isAlive() returns false after close()", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      await session.close();
      expect(session.isAlive()).toBe(false);
    });

    it("invoke() throws after close()", async () => {
      const session = createAgentSession("claude-code", fakeContainer, baseAgentOptions, []);
      await session.close();
      await expect(session.invoke("test")).rejects.toThrow("Session is closed");
    });
  });
});
