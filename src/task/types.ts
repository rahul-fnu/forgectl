export interface TaskSpec {
  id: string;
  title: string;
  description?: string;
  context: TaskContext;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  decomposition: DecompositionConfig;
  effort: EffortConfig;
  metadata?: Record<string, string>;
}

export interface TaskContext {
  files: string[];          // glob patterns for relevant files
  docs?: string[];          // documentation references
  modules?: string[];       // knowledge graph module references
  related_tasks?: string[]; // IDs of related tasks
}

export interface AcceptanceCriterion {
  run?: string;            // shell command that must exit 0
  assert?: string;         // declarative assertion (evaluated later)
  description?: string;    // human-readable description
}

export interface DecompositionConfig {
  strategy: "auto" | "manual" | "forbidden";
  max_depth?: number;
}

export interface EffortConfig {
  max_turns?: number;
  max_review_rounds?: number;
  timeout?: string;        // duration string like "30m", "1h"
}

export interface TaskValidationResult {
  valid: boolean;
  errors: TaskValidationError[];
  warnings: TaskValidationWarning[];
}

export interface TaskValidationError {
  field: string;
  message: string;
}

export interface TaskValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface ScaffoldOptions {
  id: string;
  title: string;
  files?: string[];
  constraints?: string[];
}
