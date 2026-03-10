import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentOptions } from "../../src/agent/types.js";
import type { ExecResult } from "../../src/container/runner.js";

// Mock execInContainer before importing session modules
const mockExecInContainer = vi.fn<(...args: unknown[]) => Promise<ExecResult>>();

vi.mock("../../src/container/runner.js", () => ({
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

// Import after mocks
const { BrowserUseSession } = await import("../../src/agent/browser-use-session.js");
const { createAgentSession } = await import("../../src/agent/session.js");

function createMockContainer() {
  return {} as unknown as import("dockerode").Container;
}

const defaultAgentOptions: AgentOptions = {
  model: "claude-sonnet-4-20250514",
  maxTurns: 1,
  timeout: 30000,
  flags: [],
  workingDir: "/workspace",
};

function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 10,
    ...overrides,
  };
}

describe("BrowserUseSession", () => {
  let container: import("dockerode").Container;

  beforeEach(() => {
    vi.clearAllMocks();
    container = createMockContainer();
  });

  describe("constructor", () => {
    it("sets alive to false initially", () => {
      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      expect(session.isAlive()).toBe(false);
    });
  });

  describe("invoke", () => {
    it("starts sidecar, polls health, then sends task", async () => {
      let callIndex = 0;
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdArr = cmd as string[];
        const cmdStr = cmdArr.join(" ");

        if (cmdStr.includes("browser-use-sidecar")) {
          // startSidecar call
          return makeExecResult();
        }
        if (cmdStr.includes("/health")) {
          // health poll
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          // task call
          return makeExecResult({
            stdout: JSON.stringify({
              status: "completed",
              output: "Task done",
              error: "",
            }),
          });
        }
        return makeExecResult({ exitCode: 1 });
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      const result = await session.invoke("Search for cats");

      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("Task done");
      expect(result.turnCount).toBe(1);
      expect(session.isAlive()).toBe(true);

      // Verify sidecar was started
      const calls = mockExecInContainer.mock.calls;
      const sidecarCall = calls.find((c) => {
        const cmd = (c[1] as string[]).join(" ");
        return cmd.includes("browser-use-sidecar");
      });
      expect(sidecarCall).toBeDefined();

      // Verify health was polled
      const healthCall = calls.find((c) => {
        const cmd = (c[1] as string[]).join(" ");
        return cmd.includes("/health");
      });
      expect(healthCall).toBeDefined();

      // Verify task was sent
      const taskCall = calls.find((c) => {
        const cmd = (c[1] as string[]).join(" ");
        return cmd.includes("/task");
      });
      expect(taskCall).toBeDefined();
    });

    it("calls onActivity callback when task starts", async () => {
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          return makeExecResult({
            stdout: JSON.stringify({ status: "completed", output: "done", error: "" }),
          });
        }
        return makeExecResult();
      });

      const onActivity = vi.fn();
      const session = new BrowserUseSession(container, defaultAgentOptions, [], { onActivity });
      await session.invoke("test");

      expect(onActivity).toHaveBeenCalled();
    });

    it("returns failed status on task failure", async () => {
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          return makeExecResult({
            stdout: JSON.stringify({ status: "failed", output: "", error: "Something went wrong" }),
          });
        }
        return makeExecResult();
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      const result = await session.invoke("test");

      expect(result.status).toBe("failed");
      expect(result.stderr).toBe("Something went wrong");
    });
  });

  describe("health polling", () => {
    it("retries on non-zero exit code and succeeds when health returns ok", async () => {
      let healthAttempts = 0;
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          healthAttempts++;
          if (healthAttempts <= 3) {
            return makeExecResult({ exitCode: 7, stdout: "" }); // curl connection refused
          }
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          return makeExecResult({
            stdout: JSON.stringify({ status: "completed", output: "ok", error: "" }),
          });
        }
        return makeExecResult();
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      const result = await session.invoke("test");

      expect(healthAttempts).toBe(4); // 3 failures + 1 success
      expect(result.status).toBe("completed");
    });

    it("throws after 30s worth of health check failures", async () => {
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          return makeExecResult({ exitCode: 7, stdout: "" });
        }
        return makeExecResult();
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);

      await expect(session.invoke("test")).rejects.toThrow(
        "Browser-use sidecar failed to start within 30s"
      );
    }, 60000);
  });

  describe("close", () => {
    it("sends POST /shutdown and sets alive to false", async () => {
      // First set up invoke to succeed
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          return makeExecResult({
            stdout: JSON.stringify({ status: "completed", output: "ok", error: "" }),
          });
        }
        if (cmdStr.includes("/shutdown")) {
          return makeExecResult({ stdout: JSON.stringify({ status: "shutting_down" }) });
        }
        return makeExecResult();
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      await session.invoke("test");
      expect(session.isAlive()).toBe(true);

      await session.close();
      expect(session.isAlive()).toBe(false);

      // Verify shutdown was called
      const shutdownCall = mockExecInContainer.mock.calls.find((c) => {
        const cmd = (c[1] as string[]).join(" ");
        return cmd.includes("/shutdown");
      });
      expect(shutdownCall).toBeDefined();
    });
  });

  describe("isAlive", () => {
    it("returns false before invoke, true after, false after close", async () => {
      mockExecInContainer.mockImplementation(async (_container: unknown, cmd: unknown) => {
        const cmdStr = (cmd as string[]).join(" ");
        if (cmdStr.includes("/health")) {
          return makeExecResult({ stdout: JSON.stringify({ status: "ok" }) });
        }
        if (cmdStr.includes("/task")) {
          return makeExecResult({
            stdout: JSON.stringify({ status: "completed", output: "ok", error: "" }),
          });
        }
        if (cmdStr.includes("/shutdown")) {
          return makeExecResult();
        }
        return makeExecResult();
      });

      const session = new BrowserUseSession(container, defaultAgentOptions, []);
      expect(session.isAlive()).toBe(false);

      await session.invoke("test");
      expect(session.isAlive()).toBe(true);

      await session.close();
      expect(session.isAlive()).toBe(false);
    });
  });
});

describe("createAgentSession factory", () => {
  it("returns BrowserUseSession for browser-use agent type", () => {
    const container = createMockContainer();
    const session = createAgentSession("browser-use", container, defaultAgentOptions, []);
    expect(session).toBeInstanceOf(BrowserUseSession);
  });
});
