import { describe, it, expect } from "vitest";
import { claudeCodeAdapter } from "../../src/agent/claude-code.js";
import { codexAdapter } from "../../src/agent/codex.js";
import { getAgentAdapter } from "../../src/agent/registry.js";
import type { AgentOptions } from "../../src/agent/types.js";

const defaultOptions: AgentOptions = {
  model: "",
  maxTurns: 50,
  timeout: 30000,
  flags: [],
  workingDir: "/workspace",
};

describe("claudeCodeAdapter", () => {
  it("builds basic command", () => {
    const cmd = claudeCodeAdapter.buildCommand("do the thing", defaultOptions);
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("do the thing");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("text");
  });

  it("includes max-turns when > 0", () => {
    const cmd = claudeCodeAdapter.buildCommand("task", { ...defaultOptions, maxTurns: 10 });
    expect(cmd).toContain("--max-turns");
    expect(cmd).toContain("10");
  });

  it("includes model when specified", () => {
    const cmd = claudeCodeAdapter.buildCommand("task", { ...defaultOptions, model: "claude-opus-4-5" });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-opus-4-5");
  });

  it("includes extra flags", () => {
    const cmd = claudeCodeAdapter.buildCommand("task", { ...defaultOptions, flags: ["--no-telemetry"] });
    expect(cmd).toContain("--no-telemetry");
  });

  it("omits max-turns when 0", () => {
    const cmd = claudeCodeAdapter.buildCommand("task", { ...defaultOptions, maxTurns: 0 });
    expect(cmd).not.toContain("--max-turns");
  });

  it("buildEnv returns ANTHROPIC_API_KEY subcommand when file provided", () => {
    const env = claudeCodeAdapter.buildEnv({ ANTHROPIC_API_KEY_FILE: "/run/secrets/key" });
    expect(env.some(e => e.includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(env.some(e => e.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"))).toBe(true);
  });

  it("buildEnv includes telemetry disable even without key file", () => {
    const env = claudeCodeAdapter.buildEnv({});
    expect(env).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  });
});

describe("codexAdapter", () => {
  it("builds basic command", () => {
    const cmd = codexAdapter.buildCommand("fix the bug", defaultOptions);
    expect(cmd[0]).toBe("codex");
    expect(cmd).toContain("--quiet");
    expect(cmd).toContain("--approval-mode");
    expect(cmd).toContain("full-auto");
    expect(cmd).toContain("fix the bug");
  });

  it("includes model when specified", () => {
    const cmd = codexAdapter.buildCommand("task", { ...defaultOptions, model: "gpt-4o" });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("gpt-4o");
  });

  it("buildEnv returns OPENAI_API_KEY subcommand when file provided", () => {
    const env = codexAdapter.buildEnv({ OPENAI_API_KEY_FILE: "/run/secrets/key" });
    expect(env.some(e => e.includes("OPENAI_API_KEY"))).toBe(true);
  });

  it("buildEnv is empty without key file", () => {
    const env = codexAdapter.buildEnv({});
    expect(env).toHaveLength(0);
  });
});

describe("getAgentAdapter", () => {
  it("returns claude-code adapter", () => {
    const adapter = getAgentAdapter("claude-code");
    expect(adapter.name).toBe("claude-code");
  });

  it("returns codex adapter", () => {
    const adapter = getAgentAdapter("codex");
    expect(adapter.name).toBe("codex");
  });

  it("throws for unknown agent", () => {
    expect(() => getAgentAdapter("unknown-agent")).toThrow("Unknown agent");
    expect(() => getAgentAdapter("unknown-agent")).toThrow("unknown-agent");
  });
});
