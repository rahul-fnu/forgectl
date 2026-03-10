import type Docker from "dockerode";
import type { AgentOptions } from "./types.js";
import type { AgentSession, AgentSessionOptions, AgentResult, InvokeOptions } from "./session.js";
import { execInContainer } from "../container/runner.js";

/**
 * Agent session that delegates work to a Python browser-use sidecar
 * running inside the container.  Communication is via HTTP over localhost.
 *
 * Lifecycle:
 *   1. First invoke() starts the sidecar process in the background
 *   2. Health-poll until the sidecar is ready (GET /health)
 *   3. POST /task with the prompt
 *   4. close() sends POST /shutdown
 */
export class BrowserUseSession implements AgentSession {
  private alive = false;
  private readonly sidecarPort = 8765;
  private readonly container: Docker.Container;
  private readonly agentOptions: AgentOptions;
  private readonly env: string[];
  private readonly onActivity?: () => void;

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

  async invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult> {
    if (!this.alive) {
      await this.startSidecar();
      await this.waitForHealth();
      this.alive = true;
    }

    this.onActivity?.();
    const timeout = options?.timeout ?? this.agentOptions.timeout;
    return this.runTask(prompt, timeout);
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    if (this.alive) {
      try {
        await execInContainer(this.container, [
          "sh", "-c",
          `curl -s -X POST http://localhost:${this.sidecarPort}/shutdown`,
        ], { env: this.env });
      } catch {
        // Best-effort shutdown; container may already be stopping
      }
      this.alive = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async startSidecar(): Promise<void> {
    await execInContainer(this.container, [
      "sh", "-c",
      `python3 /usr/local/bin/browser-use-sidecar.py --port ${this.sidecarPort} &`,
    ], { env: this.env });
  }

  private async waitForHealth(): Promise<void> {
    const maxAttempts = 60; // 60 * 500ms = 30s
    const intervalMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await execInContainer(this.container, [
          "sh", "-c",
          `curl -s http://localhost:${this.sidecarPort}/health`,
        ]);

        if (result.exitCode === 0) {
          try {
            const body = JSON.parse(result.stdout);
            if (body.status === "ok") {
              return;
            }
          } catch {
            // JSON parse failed; retry
          }
        }
      } catch {
        // exec failed; retry
      }

      await this.sleep(intervalMs);
    }

    throw new Error("Browser-use sidecar failed to start within 30s");
  }

  private async runTask(task: string, timeout: number): Promise<AgentResult> {
    const start = Date.now();
    const { provider, model } = this.resolveProviderModel();

    const body = JSON.stringify({ task, provider, model });
    // Escape single quotes in the JSON body for shell safety
    const escapedBody = body.replace(/'/g, "'\\''");

    try {
      const result = await execInContainer(this.container, [
        "sh", "-c",
        `curl -s -X POST -H "Content-Type: application/json" -d '${escapedBody}' http://localhost:${this.sidecarPort}/task`,
      ], { env: this.env, timeout });

      const durationMs = Date.now() - start;

      if (result.exitCode !== 0) {
        return {
          stdout: result.stdout,
          stderr: result.stderr || "curl request to sidecar failed",
          status: "failed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs,
          turnCount: 1,
        };
      }

      try {
        const response = JSON.parse(result.stdout);
        return {
          stdout: response.output || "",
          stderr: response.error || "",
          status: response.status === "completed" ? "completed" : "failed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs,
          turnCount: 1,
        };
      } catch {
        return {
          stdout: result.stdout,
          stderr: "Failed to parse sidecar response",
          status: "failed",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs,
          turnCount: 1,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timed out")) {
        return {
          stdout: "",
          stderr: message,
          status: "timeout",
          tokenUsage: { input: 0, output: 0, total: 0 },
          durationMs,
          turnCount: 1,
        };
      }
      throw err;
    }
  }

  private resolveProviderModel(): { provider: string; model: string } {
    const model = this.agentOptions.model || "claude-sonnet-4-20250514";

    // Determine provider from model name
    if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
      return { provider: "openai", model };
    }
    return { provider: "anthropic", model };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
