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

export interface ExecutionPlan {
  tasks: PlannedTask[];
  estimatedTurns: number;
  riskLevel: "LOW" | "MED" | "HIGH" | "CRITICAL";
  rationale: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  spec: TaskSpec;
  dependsOn: string[];
  estimatedTurns: number;
  riskNotes: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
