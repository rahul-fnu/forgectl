import { z } from "zod";

const duration = z.string().regex(/^\d+(s|m|h)$/, "Must be a duration like 30s, 5m, 1h");

export const AgentType = z.enum(["claude-code", "codex", "browser-use"]);
export type AgentType = z.infer<typeof AgentType>;

export const NetworkMode = z.enum(["open", "allowlist", "airgapped"]);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const FailureAction = z.enum(["abandon", "output-wip", "pause"]);
export const OrchestrationMode = z.enum(["single", "review", "parallel"]);
export const InputMode = z.enum(["repo", "files", "both"]);
export const OutputMode = z.enum(["git", "files"]);

export const AutonomyLevelEnum = z.enum(["full", "interactive", "semi", "supervised"]);
export type AutonomyLevelEnum = z.infer<typeof AutonomyLevelEnum>;

export const GitHubAppConfigSchema = z.object({
  app_id: z.number().int().positive(),
  private_key_path: z.string(),
  webhook_secret: z.string(),
  installation_id: z.number().int().positive().optional(),
});

export const AutoApproveRuleSchema = z.object({
  label: z.string().optional(),
  workflow_pattern: z.string().optional(),
  max_cost: z.number().positive().optional(),
}).optional();

export const ValidationStepSchema = z.object({
  name: z.string(),
  command: z.string(),
  retries: z.number().int().min(0).default(3),
  timeout: duration.optional(),
  description: z.string().default(""),
});
export type ValidationStep = z.infer<typeof ValidationStepSchema>;

export const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  extends: z.string().optional(),   // Name of built-in workflow to inherit from
  container: z.object({
    image: z.string(),
    network: z.object({
      mode: NetworkMode.default("open"),
      allow: z.array(z.string()).default([]),
    }).default({}),
  }),
  input: z.object({
    mode: InputMode.default("repo"),
    mountPath: z.string().default("/workspace"),
  }).default({}),
  tools: z.array(z.string()).default([]),
  system: z.string().default(""),
  validation: z.object({
    steps: z.array(ValidationStepSchema).default([]),
    on_failure: FailureAction.default("abandon"),
  }).default({}),
  output: z.object({
    mode: OutputMode.default("git"),
    path: z.string().default("/workspace"),
    collect: z.array(z.string()).default([]),
  }).default({}),
  review: z.object({
    enabled: z.boolean().default(false),
    system: z.string().default(""),
  }).default({}),
  autonomy: AutonomyLevelEnum.default("full"),
  skills: z.array(z.string()).default([]),
  auto_approve: AutoApproveRuleSchema,
  team: z.object({
    size: z.number().int().min(2).max(5),
  }).optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;

export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_concurrent_agents: z.number().int().positive().default(3),
  poll_interval_ms: z.number().int().positive().default(30000),
  stall_timeout_ms: z.number().int().positive().default(600000),
  max_retries: z.number().int().min(0).default(5),
  max_retry_backoff_ms: z.number().int().positive().default(300000),
  drain_timeout_ms: z.number().int().positive().default(30000),
  continuation_delay_ms: z.number().int().min(0).default(1000),
  in_progress_label: z.string().default("in-progress"),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const ConfigSchema = z.object({
  agent: z.object({
    type: AgentType.default("claude-code"),
    model: z.string().default(""),
    max_turns: z.number().int().default(50),
    timeout: duration.default("30m"),
    flags: z.array(z.string()).default([]),
  }).default({}),

  container: z.object({
    image: z.string().optional(),       // Override workflow's default image
    dockerfile: z.string().optional(),  // Build from custom Dockerfile
    network: z.object({
      mode: NetworkMode.optional(),     // Override workflow's network mode
      allow: z.array(z.string()).optional(),
    }).default({}),
    resources: z.object({
      memory: z.string().default("4g"),
      cpus: z.number().default(2),
    }).default({}),
  }).default({}),

  repo: z.object({
    branch: z.object({
      template: z.string().default("forge/{{slug}}/{{ts}}"),
      base: z.string().default("main"),
    }).default({}),
    exclude: z.array(z.string()).default([
      "node_modules/", "dist/", "build/", "*.log", ".env", ".env.*",
    ]),
  }).default({}),

  orchestration: z.object({
    mode: OrchestrationMode.default("single"),
    review: z.object({
      max_rounds: z.number().int().default(3),
    }).default({}),
  }).default({}),

  commit: z.object({
    message: z.object({
      prefix: z.string().default("[forge]"),
      template: z.string().default("{{prefix}} {{summary}}"),
      include_task: z.boolean().default(true),
    }).default({}),
    author: z.object({
      name: z.string().default("forgectl"),
      email: z.string().default("forge@localhost"),
    }).default({}),
    sign: z.boolean().default(false),
  }).default({}),

  output: z.object({
    dir: z.string().default("./forge-output"),
    log_dir: z.string().default(".forgectl/runs"),
  }).default({}),

  workspace: z.lazy(() => WorkspaceConfigSchema).optional(),

  tracker: z.lazy(() => TrackerConfigSchema).optional(),

  orchestrator: OrchestratorConfigSchema.default({}),

  storage: z.object({
    db_path: z.string().default("~/.forgectl/forgectl.db"),
  }).default({}),

  board: z.object({
    state_dir: z.string().default("~/.forgectl/board"),
    scheduler_tick_seconds: z.number().int().positive().default(30),
    max_concurrent_card_runs: z.number().int().positive().default(2),
  }).default({}),

  github_app: GitHubAppConfigSchema.optional(),

  team: z.object({
    size: z.number().int().min(2).max(5),
  }).optional(),
});

export type ForgectlConfig = z.infer<typeof ConfigSchema>;

export const WorkspaceConfigSchema = z.object({
  root: z.string().default("~/.forgectl/workspaces"),
  hooks: z.object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
  }).default({}),
  hook_timeout: duration.default("60s"),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const TrackerConfigSchema = z.object({
  kind: z.enum(["github", "notion"]),
  token: z.string(),
  active_states: z.array(z.string()).default(["open"]),
  terminal_states: z.array(z.string()).default(["closed"]),
  poll_interval_ms: z.number().int().positive().default(60000),
  auto_close: z.boolean().default(false),
  repo: z.string().optional(),
  labels: z.array(z.string()).optional(),
  database_id: z.string().optional(),
  property_map: z.record(z.string()).optional(),
  in_progress_label: z.string().optional(),
  done_label: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.kind === "github" && !data.repo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tracker kind "github" requires a "repo" field (e.g. "owner/repo")',
      path: ["repo"],
    });
  }
  if (data.kind === "notion" && !data.database_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tracker kind "notion" requires a "database_id" field',
      path: ["database_id"],
    });
  }
});
