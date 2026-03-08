import type Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { AgentOptions } from "./types.js";

// --- Types (mirrors session.ts interface when plan 01 is implemented) ---

export type AgentStatus = "completed" | "failed" | "timeout" | "user_input_required";

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface AgentResult {
  stdout: string;
  stderr: string;
  status: AgentStatus;
  tokenUsage: TokenUsage;
  durationMs: number;
  turnCount: number;
}

export interface AgentSessionOptions {
  onActivity?: () => void;
}

// --- JSON line reader ---

class JsonLineReader {
  private buffer = "";

  feed(chunk: string): object[] {
    this.buffer += chunk;
    const results: object[] = [];
    const lines = this.buffer.split("\n");

    // Keep the last element (possibly partial line) in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines (e.g., Rust log output on stderr)
      }
    }

    return results;
  }
}

// --- JSON-RPC message types ---

interface JsonRpcRequest {
  method: string;
  id: number;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type TurnResolver = {
  resolve: (result: AgentResult) => void;
  reject: (reason: Error) => void;
  startTime: number;
  stdout: string[];
  stderr: string[];
};

// --- AppServerSession ---

export class AppServerSession {
  private container: Docker.Container;
  private agentOptions: AgentOptions;
  private env: string[];
  private onActivity?: () => void;

  private state: "idle" | "invoking" | "closed" = "idle";
  private alive = false;
  private threadId: string | null = null;
  private turnCount = 0;
  private totalTokens: TokenUsage = { input: 0, output: 0, total: 0 };

  private execStream: NodeJS.ReadWriteStream | null = null;
  private stdoutPassthrough: PassThrough | null = null;
  private lineReader = new JsonLineReader();
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private currentTurn: TurnResolver | null = null;

  constructor(
    container: Docker.Container,
    agentOptions: AgentOptions,
    env: string[],
    sessionOptions?: AgentSessionOptions,
  ) {
    this.container = container;
    this.agentOptions = agentOptions;
    this.env = env;
    this.onActivity = sessionOptions?.onActivity;
  }

  // --- Public API ---

  async invoke(prompt: string, options?: { timeout?: number }): Promise<AgentResult> {
    if (this.state === "closed") {
      throw new Error("Session is closed");
    }

    // First invoke: spawn and handshake
    if (!this.alive) {
      await this.spawn();
      await this.handshake();
      this.alive = true;
    }

    this.turnCount++;
    const timeout = options?.timeout ?? this.agentOptions.timeout;

    return this.executeTurn(prompt, timeout);
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.state = "closed";
    this.alive = false;

    // Reject any pending turn
    if (this.currentTurn) {
      this.currentTurn.reject(new Error("Session closed during turn"));
      this.currentTurn = null;
    }

    // Reject any pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error("Session closed"));
      this.pendingRequests.delete(id);
    }

    // Destroy the stream
    if (this.execStream) {
      try {
        (this.execStream as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.();
      } catch {
        // ignore
      }
      this.execStream = null;
    }

    if (this.stdoutPassthrough) {
      this.stdoutPassthrough.destroy();
      this.stdoutPassthrough = null;
    }
  }

  // --- Private methods ---

  private async spawn(): Promise<void> {
    const exec = await this.container.exec({
      Cmd: ["codex", "app-server"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: this.env,
      WorkingDir: this.agentOptions.workingDir,
    });

    const stream = await exec.start({ hijack: true, stdin: true });
    this.execStream = stream;

    // Set up demuxed reading
    const stdoutPassthrough = new PassThrough();
    const stderrPassthrough = new PassThrough();

    this.stdoutPassthrough = stdoutPassthrough;

    // Access modem from the container's docker instance
    const modem = (this.container as unknown as { modem: { demuxStream: typeof Docker.prototype.modem.demuxStream } }).modem;
    modem.demuxStream(stream, stdoutPassthrough, stderrPassthrough);

    // Listen on stdout for JSON-RPC messages
    stdoutPassthrough.on("data", (chunk: Buffer) => {
      const messages = this.lineReader.feed(chunk.toString("utf-8"));
      for (const msg of messages) {
        this.handleMessage(msg as Record<string, unknown>);
      }
    });

    // stderr is just logged (ignored in tests)
    stderrPassthrough.on("data", () => {
      // Could log stderr here if needed
    });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { method, id, params };
    this.writeMessage(msg);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { method, params };
    this.writeMessage(msg);
  }

  private sendResponse(id: number, result: unknown): void {
    const msg: JsonRpcResponse = { id, result };
    this.writeMessage(msg);
  }

  private writeMessage(msg: object): void {
    if (!this.execStream) return;
    this.execStream.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;

    // Response to a pending request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) {
          pending.reject(new Error((msg.error as { message: string }).message ?? "JSON-RPC error"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Fire activity callback for any method-bearing message
    if (method) {
      this.onActivity?.();
    }

    // Route by method
    if (method === "item/commandExecution/requestApproval") {
      // Auto-approve
      this.sendResponse(msg.id as number, { decision: "accept" });
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const params = msg.params as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
      if (params) {
        this.totalTokens.input = params.inputTokens ?? this.totalTokens.input;
        this.totalTokens.output = params.outputTokens ?? this.totalTokens.output;
        this.totalTokens.total = params.totalTokens ?? this.totalTokens.total;
      }
      return;
    }

    if (method === "turn/completed") {
      if (this.currentTurn) {
        const turn = this.currentTurn;
        this.currentTurn = null;
        turn.resolve({
          stdout: turn.stdout.join(""),
          stderr: turn.stderr.join(""),
          status: "completed",
          tokenUsage: { ...this.totalTokens },
          durationMs: Date.now() - turn.startTime,
          turnCount: this.turnCount,
        });
      }
      return;
    }

    if (method === "turn/userInputRequired") {
      if (this.currentTurn) {
        const turn = this.currentTurn;
        this.currentTurn = null;
        turn.resolve({
          stdout: turn.stdout.join(""),
          stderr: turn.stderr.join(""),
          status: "user_input_required",
          tokenUsage: { ...this.totalTokens },
          durationMs: Date.now() - turn.startTime,
          turnCount: this.turnCount,
        });
      }
      return;
    }

    if (method === "agent/message") {
      const params = msg.params as { message?: string } | undefined;
      if (params?.message && this.currentTurn) {
        this.currentTurn.stdout.push(params.message);
      }
      return;
    }
  }

  private async handshake(): Promise<void> {
    // 1. Send initialize request
    await Promise.race([
      this.sendRequest("initialize", { capabilities: {} }),
      this.timeoutPromise(5000, "Initialize handshake timed out"),
    ]);

    // 2. Send initialized notification
    this.sendNotification("initialized", {});

    // 3. Send thread/start request
    const threadResult = await Promise.race([
      this.sendRequest("thread/start", {}),
      this.timeoutPromise(5000, "Thread start timed out"),
    ]) as { threadId: string };

    this.threadId = threadResult.threadId;
  }

  private executeTurn(prompt: string, timeout: number): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      this.currentTurn = {
        resolve,
        reject,
        startTime,
        stdout: [],
        stderr: [],
      };

      // Send turn/start
      this.sendNotification("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
      });

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        if (this.currentTurn) {
          const turn = this.currentTurn;
          this.currentTurn = null;
          turn.resolve({
            stdout: turn.stdout.join(""),
            stderr: turn.stderr.join(""),
            status: "timeout",
            tokenUsage: { ...this.totalTokens },
            durationMs: Date.now() - turn.startTime,
            turnCount: this.turnCount,
          });
        }
      }, timeout);

      // Store timeout handle for cleanup
      const originalResolve = this.currentTurn.resolve;
      this.currentTurn.resolve = (result) => {
        clearTimeout(timeoutHandle);
        originalResolve(result);
      };
      const originalReject = this.currentTurn.reject;
      this.currentTurn.reject = (reason) => {
        clearTimeout(timeoutHandle);
        originalReject(reason);
      };
    });
  }

  private timeoutPromise(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }
}
