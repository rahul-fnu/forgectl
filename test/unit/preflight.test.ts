import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunPlan } from "../../src/workflow/types.js";

// Mock heavy dependencies
vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockRejectedValue(new Error("Docker not available")),
  })),
}));

vi.mock("../../src/auth/claude.js", () => ({
  getClaudeAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/auth/codex.js", () => ({
  getCodexAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => { throw new Error("not a git repo"); }),
}));

import { runPreflightChecks } from "../../src/orchestration/preflight.js";
import { Logger } from "../../src/logging/logger.js";

function makeMinimalPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    runId: "forge-test-001",
    task: "test task",
    workflow: {
      name: "code",
      description: "",
      container: { image: "forgectl/code-node20", network: { mode: "open", allow: [] } },
      input: { mode: "repo", mountPath: "/workspace" },
      tools: [],
      system: "",
      validation: { steps: [], on_failure: "abandon" },
      output: { mode: "git", path: "/workspace", collect: [] },
      review: { enabled: false, system: "" },
    },
    agent: { type: "claude-code", model: "", maxTurns: 50, timeout: 1800000, flags: [] },
    container: {
      image: "forgectl/code-node20",
      network: { mode: "open", dockerNetwork: "bridge" },
      resources: { memory: "4g", cpus: 2 },
    },
    input: { mode: "repo", sources: ["/nonexistent/repo"], mountPath: "/workspace", exclude: [] },
    context: { system: "", files: [], inject: [] },
    validation: { steps: [], onFailure: "abandon" },
    output: { mode: "files", path: "/output", collect: [], hostDir: "/host/output" },
    orchestration: {
      mode: "single",
      review: { enabled: false, system: "", maxRounds: 3, agent: "claude-code", model: "" },
    },
    commit: {
      message: { prefix: "[forge]", template: "{{prefix}} {{summary}}", includeTask: true },
      author: { name: "forgectl", email: "forge@localhost" },
      sign: false,
    },
    ...overrides,
  } as RunPlan;
}

describe("runPreflightChecks", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger(false);
    vi.clearAllMocks();
  });

  it("reports Docker not running as error", async () => {
    const plan = makeMinimalPlan();
    const result = await runPreflightChecks(plan, logger);
    expect(result.errors.some(e => e.includes("Docker"))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("reports missing claude-code credentials as error", async () => {
    const { getClaudeAuth } = await import("../../src/auth/claude.js");
    vi.mocked(getClaudeAuth).mockResolvedValue(null);
    const plan = makeMinimalPlan({ agent: { type: "claude-code", model: "", maxTurns: 50, timeout: 1800000, flags: [] } });
    const result = await runPreflightChecks(plan, logger);
    expect(result.errors.some(e => e.includes("Claude Code credentials"))).toBe(true);
  });

  it("reports missing codex credentials as error", async () => {
    const { getCodexAuth } = await import("../../src/auth/codex.js");
    vi.mocked(getCodexAuth).mockResolvedValue(null);
    const plan = makeMinimalPlan({ agent: { type: "codex", model: "", maxTurns: 50, timeout: 1800000, flags: [] } });
    const result = await runPreflightChecks(plan, logger);
    expect(result.errors.some(e => e.includes("Codex credentials"))).toBe(true);
  });

  it("reports missing input sources as errors", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    const plan = makeMinimalPlan({
      input: { mode: "repo", sources: ["/missing/path"], mountPath: "/workspace", exclude: [] },
    });
    const result = await runPreflightChecks(plan, logger);
    expect(result.errors.some(e => e.includes("/missing/path"))).toBe(true);
  });

  it("reports missing context files as warnings (not errors)", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockImplementation((path) => {
      // Source exists, context file doesn't
      if (String(path).includes("context")) return false;
      return true;
    });
    const plan = makeMinimalPlan({
      input: { mode: "repo", sources: ["/repo"], mountPath: "/workspace", exclude: [] },
      context: { system: "", files: ["/some/context.md"], inject: [] },
    });
    const result = await runPreflightChecks(plan, logger);
    expect(result.warnings.some(w => w.includes("context.md"))).toBe(true);
    // Context file missing is a warning, not error
    expect(result.errors.some(e => e.includes("context.md"))).toBe(false);
  });

  it("returns passed:false when there are errors", async () => {
    const plan = makeMinimalPlan();
    const result = await runPreflightChecks(plan, logger);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
