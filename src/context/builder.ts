export interface TaskSpec {
  id: string;
  title: string;
  description?: string;
  context: { files: string[]; docs?: string[]; modules?: string[]; related_tasks?: string[] };
  constraints: string[];
  acceptance: { run?: string; assert?: string; description?: string }[];
  decomposition: { strategy: string; max_depth?: number };
  effort: { max_turns?: number; max_review_rounds?: number; timeout?: string };
  metadata?: Record<string, string>;
  budget?: { max_cost_usd?: number; max_tokens?: number };
}

export interface Convention {
  pattern: string;
  description?: string;
  confidence: number;
}

export interface ContextResult {
  systemContext: string;
  taskContext: string;
  budget: { used: number; max: number; reservedForAgent: number };
  merkleRoot: string;
  includedFiles: Array<{ path: string; tier: "full" | "exports" | "name"; tokens: number }>;
  conventions?: Convention[];
}

const DEFAULT_BUDGET = 60000;
const AGENT_RESERVE_RATIO = 0.5;

/**
 * CLAUDE.md-native context: agents read CLAUDE.md directly from the workspace.
 * No KG-based file scoring needed — the agent discovers context natively.
 * Returns minimal context metadata since the agent handles its own exploration.
 */
export async function buildContext(
  _task: TaskSpec,
  _kgDb?: unknown,
  budget?: number,
  _taskType?: string,
): Promise<ContextResult> {
  const totalBudget = budget ?? DEFAULT_BUDGET;
  const reservedForAgent = Math.floor(totalBudget * AGENT_RESERVE_RATIO);

  const systemContext = [
    "# Context",
    "The agent reads CLAUDE.md from the workspace root for project conventions and structure.",
    "No additional context injection is needed — the agent explores the codebase natively.",
  ].join("\n");

  return {
    systemContext,
    taskContext: "",
    budget: { used: 0, max: totalBudget, reservedForAgent },
    merkleRoot: "",
    includedFiles: [],
  };
}
