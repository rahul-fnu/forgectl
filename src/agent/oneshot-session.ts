import type Docker from "dockerode";
import type { AgentAdapter, AgentOptions } from "./types.js";
import type { AgentSession, AgentResult, AgentSessionOptions, AgentStatus, InvokeOptions } from "./session.js";
import { invokeAgent } from "./invoke.js";
import { parseTokenUsage } from "./token-parser.js";

/**
 * Map exit code to agent status.
 */
function mapExitCodeToStatus(exitCode: number): AgentStatus {
  return exitCode === 0 ? "completed" : "failed";
}

/**
 * One-shot agent session that wraps a single invokeAgent() call.
 * Each invoke() creates a new CLI process inside the container.
 * Maintains backward compatibility with the existing invocation model.
 */
export class OneShotSession implements AgentSession {
  private alive = true;

  constructor(
    private readonly container: Docker.Container,
    private readonly adapter: AgentAdapter,
    private readonly agentOptions: AgentOptions,
    private readonly env: string[],
    private readonly sessionOptions?: AgentSessionOptions,
  ) {}

  async invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult> {
    if (!this.alive) {
      throw new Error("Session is closed");
    }

    const opts: AgentOptions = options?.timeout
      ? { ...this.agentOptions, timeout: options.timeout }
      : this.agentOptions;

    const execResult = await invokeAgent(
      this.container,
      this.adapter,
      prompt,
      opts,
      this.env,
      undefined,
    );

    // Fire activity callback if there is output
    if (this.sessionOptions?.onActivity && (execResult.stdout || execResult.stderr)) {
      this.sessionOptions.onActivity();
    }

    const parsed = parseTokenUsage(this.adapter.name, execResult.stdout, execResult.stderr);
    const tokenUsage = parsed
      ? { input: parsed.inputTokens, output: parsed.outputTokens, total: parsed.inputTokens + parsed.outputTokens }
      : { input: 0, output: 0, total: 0 };

    return {
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      status: mapExitCodeToStatus(execResult.exitCode),
      tokenUsage,
      durationMs: execResult.durationMs,
      turnCount: 1,
    };
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.alive = false;
  }
}
