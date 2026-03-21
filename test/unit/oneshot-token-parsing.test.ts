import { describe, it, expect, vi } from "vitest";
import { OneShotSession } from "../../src/agent/oneshot-session.js";
import type { AgentAdapter, AgentOptions } from "../../src/agent/types.js";

// Mock invokeAgent to return controlled output
vi.mock("../../src/agent/invoke.js", () => ({
  invokeAgent: vi.fn(),
}));

import { invokeAgent } from "../../src/agent/invoke.js";

const mockInvokeAgent = vi.mocked(invokeAgent);

function makeSession(adapterName: string): OneShotSession {
  const adapter: AgentAdapter = {
    name: adapterName,
    buildShellCommand: () => "echo test",
  };
  const agentOptions: AgentOptions = {
    model: "test-model",
    maxTurns: 1,
    timeout: 30000,
    flags: [],
    workingDir: "/workspace",
  };
  return new OneShotSession(
    {} as any, // container (not used in mocked path)
    adapter,
    agentOptions,
    [],
  );
}

describe("OneShotSession token parsing integration", () => {
  it("parses Claude Code token usage from stderr", async () => {
    mockInvokeAgent.mockResolvedValueOnce({
      stdout: "Agent output here",
      stderr: "Token usage: input=1234, output=567",
      exitCode: 0,
      durationMs: 5000,
    });

    const session = makeSession("claude-code");
    const result = await session.invoke("test prompt");

    expect(result.tokenUsage).toEqual({
      input: 1234,
      output: 567,
      total: 1801,
    });
  });

  it("parses Codex token usage from stdout JSON", async () => {
    const usageJson = JSON.stringify({
      usage: { prompt_tokens: 2000, completion_tokens: 800, total_tokens: 2800 },
    });
    mockInvokeAgent.mockResolvedValueOnce({
      stdout: usageJson,
      stderr: "",
      exitCode: 0,
      durationMs: 3000,
    });

    const session = makeSession("codex");
    const result = await session.invoke("test prompt");

    expect(result.tokenUsage).toEqual({
      input: 2000,
      output: 800,
      total: 2800,
    });
  });

  it("returns zero tokens when no token data found", async () => {
    mockInvokeAgent.mockResolvedValueOnce({
      stdout: "plain output",
      stderr: "some errors",
      exitCode: 0,
      durationMs: 1000,
    });

    const session = makeSession("claude-code");
    const result = await session.invoke("test prompt");

    expect(result.tokenUsage).toEqual({
      input: 0,
      output: 0,
      total: 0,
    });
  });

  it("parses tokens with comma formatting", async () => {
    mockInvokeAgent.mockResolvedValueOnce({
      stdout: "",
      stderr: "Total input tokens: 10,000 | Total output tokens: 3,500",
      exitCode: 0,
      durationMs: 2000,
    });

    const session = makeSession("claude-code");
    const result = await session.invoke("test prompt");

    expect(result.tokenUsage).toEqual({
      input: 10000,
      output: 3500,
      total: 13500,
    });
  });
});
