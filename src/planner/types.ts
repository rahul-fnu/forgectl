import type { TaskSpec } from "../task/types.js";

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
