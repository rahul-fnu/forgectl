import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { AppServerSession } from "../../src/agent/appserver-session.js";
import type { AgentOptions } from "../../src/agent/types.js";

// --- Mock helpers ---

interface MockExecStream extends PassThrough {
  /** Simulate a JSON-RPC message arriving on stdout (demuxed) */
  simulateStdout: (msg: object) => void;
}

function createMockContainer() {
  let execStream: MockExecStream;
  const stdoutTarget = { write: (_chunk: Buffer) => {} };
  const written: string[] = [];

  const container = {
    exec: vi.fn(async () => ({
      start: vi.fn(async () => {
        const raw = new PassThrough() as MockExecStream;

        // Capture writes (outgoing JSON-RPC messages)
        const originalWrite = raw.write.bind(raw);
        raw.write = ((chunk: string | Buffer, ...args: unknown[]) => {
          const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          for (const line of str.split("\n")) {
            if (line.trim()) written.push(line);
          }
          return originalWrite(chunk, ...args as [BufferEncoding, (error: Error | null | undefined) => void]);
        }) as typeof raw.write;

        // simulateStdout sends data via the demuxed stdout path
        raw.simulateStdout = (msg: object) => {
          const line = JSON.stringify(msg) + "\n";
          stdoutTarget.write(Buffer.from(line, "utf-8"));
        };

        execStream = raw;
        return raw;
      }),
    })),
    modem: {
      demuxStream: (_stream: unknown, stdout: { write: (chunk: Buffer) => void }) => {
        stdoutTarget.write = (chunk: Buffer) => stdout.write(chunk);
      },
    },
  };

  return {
    container: container as unknown as import("dockerode").Container,
    getStream: () => execStream,
    getWritten: () => written,
    getStdoutTarget: () => stdoutTarget,
  };
}

const defaultAgentOptions: AgentOptions = {
  model: "codex-1",
  maxTurns: 50,
  timeout: 5000,
  flags: [],
  workingDir: "/workspace",
};

// Helper: simulate the full handshake from server side
function simulateHandshake(mock: ReturnType<typeof createMockContainer>, threadId = "thread-1") {
  // We need to respond to messages as they come in.
  // The handshake sequence is: initialize request -> response, initialized notification (no response), thread/start request -> response
  const stream = mock.getStream();

  // Slight delay so the session has time to send requests
  let msgIndex = 0;
  const stdoutTarget = mock.getStdoutTarget();

  const interval = setInterval(() => {
    const written = mock.getWritten();
    if (msgIndex < written.length) {
      const msg = JSON.parse(written[msgIndex]);
      msgIndex++;

      if (msg.method === "initialize" && msg.id !== undefined) {
        // Respond to initialize
        stdoutTarget.write(Buffer.from(JSON.stringify({ id: msg.id, result: { capabilities: {} } }) + "\n"));
      } else if (msg.method === "initialized") {
        // Notification, no response needed
      } else if (msg.method === "thread/start" && msg.id !== undefined) {
        stdoutTarget.write(Buffer.from(JSON.stringify({ id: msg.id, result: { threadId } }) + "\n"));
        clearInterval(interval);
      }
    }
  }, 5);

  // Safety cleanup
  setTimeout(() => clearInterval(interval), 3000);

  return { clearHandshake: () => clearInterval(interval) };
}

// Helper: simulate a complete turn (turn/completed after a brief delay)
function simulateTurnComplete(mock: ReturnType<typeof createMockContainer>, opts?: { delay?: number; stdout?: string }) {
  const delay = opts?.delay ?? 10;
  const stdoutTarget = mock.getStdoutTarget();

  setTimeout(() => {
    if (opts?.stdout) {
      stdoutTarget.write(Buffer.from(JSON.stringify({
        method: "agent/message",
        params: { message: opts.stdout },
      }) + "\n"));
    }
    stdoutTarget.write(Buffer.from(JSON.stringify({
      method: "turn/completed",
      params: { status: "completed" },
    }) + "\n"));
  }, delay);
}

describe("AppServerSession", () => {
  let mock: ReturnType<typeof createMockContainer>;

  beforeEach(() => {
    mock = createMockContainer();
  });

  describe("handshake", () => {
    it("sends initialize, initialized, and thread/start in sequence", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      // Start invoke which triggers handshake
      const { clearHandshake } = simulateHandshake(mock);
      simulateTurnComplete(mock, { delay: 100 });

      await session.invoke("test prompt");
      clearHandshake();

      const written = mock.getWritten();
      const methods = written.map((w) => JSON.parse(w).method).filter(Boolean);

      expect(methods).toContain("initialize");
      expect(methods).toContain("initialized");
      expect(methods).toContain("thread/start");
      expect(methods).toContain("turn/start");

      // Ensure correct order
      const initIdx = methods.indexOf("initialize");
      const initializedIdx = methods.indexOf("initialized");
      const threadStartIdx = methods.indexOf("thread/start");
      expect(initIdx).toBeLessThan(initializedIdx);
      expect(initializedIdx).toBeLessThan(threadStartIdx);

      await session.close();
    });
  });

  describe("turn lifecycle", () => {
    it("sends turn/start with prompt and resolves on turn/completed", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // After handshake, simulate turn completion
      const checkTurn = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => {
          const msg = JSON.parse(w);
          return msg.method === "turn/start";
        });
        if (hasTurnStart) {
          clearInterval(checkTurn);
          mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
            method: "turn/completed",
            params: { status: "completed" },
          }) + "\n"));
        }
      }, 5);

      const result = await session.invoke("hello agent");
      clearHandshake();
      clearInterval(checkTurn);

      expect(result.status).toBe("completed");
      expect(result.turnCount).toBe(1);

      // Verify turn/start was sent with the prompt
      const turnStartMsg = mock.getWritten().find((w) => JSON.parse(w).method === "turn/start");
      expect(turnStartMsg).toBeDefined();
      const parsed = JSON.parse(turnStartMsg!);
      expect(parsed.params.input).toEqual([{ type: "text", text: "hello agent" }]);

      await session.close();
    });
  });

  describe("multi-turn", () => {
    it("reuses threadId and does not re-handshake on second invoke", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock, "thread-42");

      // First invoke
      const waitForTurn = (prompt: string) =>
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const written = mock.getWritten();
            const hasTurnStart = written.some((w) => {
              const msg = JSON.parse(w);
              return msg.method === "turn/start" && msg.params?.input?.[0]?.text === prompt;
            });
            if (hasTurnStart) {
              clearInterval(check);
              mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
                method: "turn/completed",
                params: { status: "completed" },
              }) + "\n"));
              resolve();
            }
          }, 5);
        });

      const p1 = session.invoke("first turn");
      await waitForTurn("first turn");
      const r1 = await p1;

      expect(r1.turnCount).toBe(1);

      // Second invoke
      const p2 = session.invoke("second turn");
      await waitForTurn("second turn");
      const r2 = await p2;

      expect(r2.turnCount).toBe(2);
      clearHandshake();

      // Verify only ONE initialize was sent (no re-handshake)
      const initCount = mock.getWritten().filter((w) => JSON.parse(w).method === "initialize").length;
      expect(initCount).toBe(1);

      // Verify both turn/start messages use same threadId
      const turnStarts = mock.getWritten()
        .filter((w) => JSON.parse(w).method === "turn/start")
        .map((w) => JSON.parse(w).params.threadId);
      expect(turnStarts).toEqual(["thread-42", "thread-42"]);

      await session.close();
    });
  });

  describe("approval auto-accept", () => {
    it("auto-approves approval requests with accept decision", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // After handshake, wait for turn/start then send approval request before completing
      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);
          // Send approval request
          mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
            method: "item/commandExecution/requestApproval",
            id: 999,
            params: { command: "npm install" },
          }) + "\n"));

          // After a small delay, complete the turn
          setTimeout(() => {
            mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
              method: "turn/completed",
              params: { status: "completed" },
            }) + "\n"));
          }, 20);
        }
      }, 5);

      await session.invoke("do something");
      clearHandshake();
      clearInterval(check);

      // Verify approval response was sent
      const approvalResponse = mock.getWritten().find((w) => {
        const msg = JSON.parse(w);
        return msg.id === 999 && msg.result?.decision === "accept";
      });
      expect(approvalResponse).toBeDefined();

      await session.close();
    });
  });

  describe("token usage tracking", () => {
    it("accumulates token usage from notifications across turns", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // Wait for turn/start, send token usage then complete
      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);

          mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          }) + "\n"));

          setTimeout(() => {
            mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
              method: "turn/completed",
              params: { status: "completed" },
            }) + "\n"));
          }, 10);
        }
      }, 5);

      const result = await session.invoke("test");
      clearHandshake();
      clearInterval(check);

      expect(result.tokenUsage.input).toBe(100);
      expect(result.tokenUsage.output).toBe(50);
      expect(result.tokenUsage.total).toBe(150);

      await session.close();
    });
  });

  describe("activity callback", () => {
    it("fires onActivity on agent events", async () => {
      const onActivity = vi.fn();
      const session = new AppServerSession(mock.container, defaultAgentOptions, [], { onActivity });

      const { clearHandshake } = simulateHandshake(mock);

      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);

          mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
            method: "agent/message",
            params: { message: "working..." },
          }) + "\n"));

          setTimeout(() => {
            mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
              method: "turn/completed",
              params: { status: "completed" },
            }) + "\n"));
          }, 10);
        }
      }, 5);

      await session.invoke("test");
      clearHandshake();
      clearInterval(check);

      // onActivity should have been called for agent/message and turn/completed (and possibly handshake messages)
      expect(onActivity).toHaveBeenCalled();

      await session.close();
    });
  });

  describe("timeout", () => {
    it("rejects with timeout status when turn does not complete in time", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // Don't send turn/completed — let it timeout
      // Use a short timeout
      const result = await session.invoke("test", { timeout: 50 });
      clearHandshake();

      expect(result.status).toBe("timeout");

      await session.close();
    });
  });

  describe("isAlive", () => {
    it("returns false before first invoke", () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);
      expect(session.isAlive()).toBe(false);
    });

    it("returns true after handshake completes", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);
      simulateTurnComplete(mock, { delay: 100 });

      await session.invoke("test");
      clearHandshake();

      expect(session.isAlive()).toBe(true);

      await session.close();
    });

    it("returns false after close", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);
      simulateTurnComplete(mock, { delay: 100 });

      await session.invoke("test");
      clearHandshake();

      await session.close();
      expect(session.isAlive()).toBe(false);
    });
  });

  describe("close", () => {
    it("destroys stream and rejects pending turn", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // Start invoke but don't complete the turn
      let invokeResult: unknown;
      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);
          // Close the session while turn is pending
          setTimeout(() => session.close(), 10);
        }
      }, 5);

      try {
        invokeResult = await session.invoke("test");
      } catch (err) {
        invokeResult = err;
      }
      clearHandshake();
      clearInterval(check);

      // The pending invoke should have been rejected or returned failed status
      if (invokeResult instanceof Error) {
        expect(invokeResult.message).toContain("closed");
      } else {
        expect((invokeResult as { status: string }).status).toBe("failed");
      }
    });
  });

  describe("invoke after close", () => {
    it("throws 'Session is closed'", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);
      await session.close();

      await expect(session.invoke("test")).rejects.toThrow("Session is closed");
    });
  });

  describe("user_input_required", () => {
    it("resolves with user_input_required status", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);
          mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
            method: "turn/userInputRequired",
            params: {},
          }) + "\n"));
        }
      }, 5);

      const result = await session.invoke("test");
      clearHandshake();
      clearInterval(check);

      expect(result.status).toBe("user_input_required");

      await session.close();
    });
  });

  describe("JSONL line buffering", () => {
    it("handles partial lines across chunks correctly", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      // After handshake, simulate partial chunks for turn/start response
      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);

          // Send turn/completed in two partial chunks
          const msg = JSON.stringify({ method: "turn/completed", params: { status: "completed" } });
          const half = Math.floor(msg.length / 2);

          mock.getStdoutTarget().write(Buffer.from(msg.slice(0, half)));
          setTimeout(() => {
            mock.getStdoutTarget().write(Buffer.from(msg.slice(half) + "\n"));
          }, 10);
        }
      }, 5);

      const result = await session.invoke("test");
      clearHandshake();
      clearInterval(check);

      expect(result.status).toBe("completed");

      await session.close();
    });

    it("skips malformed JSON lines", async () => {
      const session = new AppServerSession(mock.container, defaultAgentOptions, []);

      const { clearHandshake } = simulateHandshake(mock);

      const check = setInterval(() => {
        const written = mock.getWritten();
        const hasTurnStart = written.some((w) => JSON.parse(w).method === "turn/start");
        if (hasTurnStart) {
          clearInterval(check);

          // Send some garbage Rust log output first
          mock.getStdoutTarget().write(Buffer.from("WARN codex_core: some rust log output\n"));

          setTimeout(() => {
            mock.getStdoutTarget().write(Buffer.from(JSON.stringify({
              method: "turn/completed",
              params: { status: "completed" },
            }) + "\n"));
          }, 10);
        }
      }, 5);

      // Should not crash on malformed JSON
      const result = await session.invoke("test");
      clearHandshake();
      clearInterval(check);

      expect(result.status).toBe("completed");

      await session.close();
    });
  });
});
