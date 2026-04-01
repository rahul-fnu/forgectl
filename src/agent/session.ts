import type Docker from "dockerode";
import type { AgentAdapter, AgentOptions } from "./types.js";
import { getAgentAdapter } from "./registry.js";
import { OneShotSession } from "./oneshot-session.js";
import { AppServerSession } from "./appserver-session.js";
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
  /** Callback invoked with each chunk of agent output as it arrives. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** When true and agent is codex, use AppServerSession for persistent multi-turn sessions. */
  useAppServer?: boolean;
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
 * Returns AppServerSession for codex when useAppServer is enabled,
 * otherwise returns OneShotSession for all agent types.
 */
export function createAgentSession(
  agentType: string,
  container: Docker.Container,
  agentOptions: AgentOptions,
  env: string[],
  sessionOptions?: AgentSessionOptions,
): AgentSession {
  // AppServerSession is only supported for codex agent type
  if (agentType === "codex" && sessionOptions?.useAppServer) {
    return new AppServerSession(container, agentOptions, env, sessionOptions);
  }

  // Default: OneShotSession for all agent types (claude-code, codex without app-server)
  const adapter: AgentAdapter = getAgentAdapter(agentType);
  return new OneShotSession(container, adapter, agentOptions, env, sessionOptions);
}
