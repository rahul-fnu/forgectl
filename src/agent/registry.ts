import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";

const ADAPTERS: Record<string, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex": codexAdapter,
};

export function getAgentAdapter(name: string): AgentAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}
