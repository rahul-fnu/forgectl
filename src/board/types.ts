export type TriggerMode = "manual" | "auto" | "scheduled";

export interface BoardTemplateSource {
  format: "yaml" | "workflow-md";
  path: string;
}

export interface BoardTemplateParamSpec {
  required?: string[];
  defaults?: Record<string, string | number | boolean>;
}

export interface BoardTemplateTriggers {
  manual?: boolean;
  auto_on_enter?: string[];
  schedule?: {
    enabled?: boolean;
    interval_minutes?: number;
  };
}

export interface BoardTemplatePostRun {
  on_success?: string;
  on_failure?: string;
}

export interface BoardTemplate {
  source: BoardTemplateSource;
  params?: BoardTemplateParamSpec;
  triggers?: BoardTemplateTriggers;
  post_run?: BoardTemplatePostRun;
}

export interface BoardDefinition {
  id: string;
  name: string;
  columns: string[];
  transitions?: Record<string, string[]>;
  templates: Record<string, BoardTemplate>;
}

export interface BoardCardRunLink {
  runId: string;
  triggerMode: TriggerMode;
  status: "running" | "completed" | "failed";
  statusVersion: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface BoardCard {
  id: string;
  title: string;
  type: string;
  column: string;
  params: Record<string, string | number | boolean>;
  depends_on?: string[];
  createdAt: string;
  updatedAt: string;
  statusVersion: number;
  lastAutoTriggeredVersion?: number;
  nextScheduledAt?: string;
  runHistory: BoardCardRunLink[];
}

export interface BoardState {
  boardId: string;
  boardName: string;
  definitionPath: string;
  columns: string[];
  transitions: Record<string, string[]>;
  templates: Record<string, BoardTemplate>;
  cards: BoardCard[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  definitionPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardRegistry {
  boards: BoardSummary[];
}

export interface LoadedTemplate {
  pipeline: Record<string, unknown>;
}
