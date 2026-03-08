import type Docker from "dockerode";
import type { AgentAdapter, AgentOptions } from "./types.js";
import { getAgentAdapter } from "./registry.js";
import { OneShotSession } from "./oneshot-session.js";

/**
 * Status of a completed agent invocation.
 */
export type AgentStatus = "completed" | "failed" | "timeout" | "user_input_required";

/**
 * Token usage for an agent invocation.
 * Defaults to zeros for one-shot mode where usage is not tracked.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/**
 * Structured result from an agent session invocation.
 */
export interface AgentResult {
  stdout: string;
  stderr: string;
  status: AgentStatus;
  tokenUsage: TokenUsage;
  durationMs: number;
  turnCount: number;
}

/**
 * Options for configuring agent session behavior.
 */
export interface AgentSessionOptions {
  onActivity?: () => void;
}

/**
 * Options for individual invoke calls.
 */
export interface InvokeOptions {
  timeout?: number;
}

/**
 * Unified interface for agent sessions.
 * Abstracts one-shot CLI invocations and persistent app-server sessions.
 */
export interface AgentSession {
  invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult>;
  isAlive(): boolean;
  close(): Promise<void>;
}

/**
 * Factory function to create an agent session by type.
 * Currently returns OneShotSession for all known agent types.
 * AppServerSession support will be added in plan 02.
 */
export function createAgentSession(
  agentType: string,
  container: Docker.Container,
  agentOptions: AgentOptions,
  env: string[],
  sessionOptions?: AgentSessionOptions,
): AgentSession {
  const adapter: AgentAdapter = getAgentAdapter(agentType);
  return new OneShotSession(container, adapter, agentOptions, env, sessionOptions);
}
