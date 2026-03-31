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
 * Stub implementation — KG module has been removed.
 * Returns minimal context without KG-based file scoring.
 */
export async function buildContext(
  task: TaskSpec,
  _kgDb?: unknown,
  budget?: number,
  _taskType?: string,
): Promise<ContextResult> {
  const totalBudget = budget ?? DEFAULT_BUDGET;
  const reservedForAgent = Math.floor(totalBudget * AGENT_RESERVE_RATIO);

  const systemContext = [
    "# Codebase Context (auto-generated from Knowledge Graph)",
    `Merkle root: `,
    `Files included: 0`,
    `Token budget: 0/${totalBudget - reservedForAgent} (${reservedForAgent} reserved for agent exploration)`,
    "",
  ].join("\n");

  return {
    systemContext,
    taskContext: "",
    budget: { used: 0, max: totalBudget, reservedForAgent },
    merkleRoot: "",
    includedFiles: [],
  };
}
