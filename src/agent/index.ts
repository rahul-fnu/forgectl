/**
 * Agent subsystem barrel export.
 * Provides the public API for agent sessions, adapters, and invocation.
 */

// Session abstraction (primary API)
export type {
  AgentSession,
  AgentResult,
  AgentStatus,
  TokenUsage,
  AgentSessionOptions,
  InvokeOptions,
} from "./session.js";
export { createAgentSession } from "./session.js";

// Session implementations
export { OneShotSession } from "./oneshot-session.js";
export { AppServerSession } from "./appserver-session.js";

// Adapter types and registry
export type { AgentAdapter, AgentOptions } from "./types.js";
export { getAgentAdapter } from "./registry.js";

// Low-level invocation (used by validation loop and OneShotSession)
export { invokeAgent } from "./invoke.js";
