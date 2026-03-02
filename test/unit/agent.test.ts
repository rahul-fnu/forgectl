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

const PROMPT_FILE = "/tmp/forgectl/prompt.txt";

describe("claudeCodeAdapter", () => {
  it("builds shell command that pipes prompt file to claude", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, defaultOptions);
    expect(cmd).toContain(`cat "${PROMPT_FILE}"`);
    expect(cmd).toContain("claude -p -");
    expect(cmd).toContain("--output-format text");
  });

  it("includes max-turns when > 0", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, maxTurns: 10 });
    expect(cmd).toContain("--max-turns 10");
  });

  it("includes model when specified", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, model: "claude-opus-4-5" });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-opus-4-5");
  });

  it("includes extra flags", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, flags: ["--no-telemetry"] });
    expect(cmd).toContain("--no-telemetry");
  });

  it("omits max-turns when 0", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, maxTurns: 0 });
    expect(cmd).not.toContain("--max-turns");
  });

  it("shell-escapes model names with special characters", () => {
    const cmd = claudeCodeAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, model: "model's-name" });
    expect(cmd).toContain("'model'\\''s-name'");
  });
});

describe("codexAdapter", () => {
  it("builds shell command with codex exec flags", () => {
    const cmd = codexAdapter.buildShellCommand(PROMPT_FILE, defaultOptions);
    expect(cmd).toContain("codex exec");
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("--skip-git-repo-check");
    expect(cmd).toContain(PROMPT_FILE);
    // Prompt must be passed as a positional argument via command substitution,
    // not piped via stdin — codex exec does not reliably support the `-` stdin flag.
    expect(cmd).not.toContain("| codex exec");
    expect(cmd).toContain(`"$(cat "${PROMPT_FILE}")"`);
  });

  it("includes model when specified", () => {
    const cmd = codexAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, model: "gpt-4o" });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("gpt-4o");
  });

  it("places flags before the prompt argument", () => {
    const cmd = codexAdapter.buildShellCommand(PROMPT_FILE, { ...defaultOptions, model: "gpt-4o" });
    const modelIdx = cmd.indexOf("--model");
    const promptIdx = cmd.indexOf(`"$(cat`);
    expect(modelIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(promptIdx);
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
