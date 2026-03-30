import { z } from "zod";

const duration = z.string().regex(/^\d+(s|m|h|d)$/, "Must be a duration like 30s, 5m, 1h, 7d");

export const AgentType = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof AgentType>;

export const NetworkMode = z.enum(["open", "allowlist", "airgapped"]);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const FailureAction = z.enum(["abandon", "output-wip", "pause"]);
export const RepeatedFailureAction = z.enum(["abort", "change_strategy", "escalate"]);
export const OrchestrationMode = z.enum(["single", "review", "parallel"]);
export const InputMode = z.enum(["repo", "files", "both"]);
export const OutputMode = z.enum(["git"]);

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
  expect_failure: z.boolean().optional(),
  before_fix: z.boolean().optional(),
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
    lint_steps: z.array(ValidationStepSchema).default([]),
    on_failure: FailureAction.default("abandon"),
    max_same_failures: z.number().int().min(1).default(2),
    on_repeated_failure: RepeatedFailureAction.default("abort"),
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
  cache: z.object({
    enabled: z.boolean().default(true),
    ttl: duration.default("7d"),
  }).default({}),
  budget: z.object({
    max_cost_per_run: z.number().positive().optional(),
    max_cost_per_day: z.number().positive().optional(),
  }).optional(),
  autonomy: AutonomyLevelEnum.default("full"),
  skills: z.array(z.string()).default([]),
  auto_approve: AutoApproveRuleSchema,
  team: z.object({
    size: z.number().int().min(2).max(5),
  }).optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;

export const ScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  task: z.string(),
  repo: z.string().optional(),
});
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

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
  child_slots: z.number().int().min(0).default(0),
  enable_triage: z.boolean().default(false),
  triage_max_complexity: z.number().int().min(1).max(10).default(7),
  auto_approve: z.boolean().default(true),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const AlertEventTypeEnum = z.enum([
  "run_failed",
  "run_completed",
  "cost_ceiling_hit",
  "usage_limit_detected",
  "review_escalated",
]);

export const WebhookTargetSchema = z.object({
  url: z.string().url(),
  events: z.array(AlertEventTypeEnum),
  secret: z.string().optional(),
});

export const DiscordConfigSchema = z.object({
  bot_token: z.string(),
  channel_id: z.string(),
  application_id: z.string().optional(),
}).optional();

export const AlertingConfigSchema = z.object({
  webhooks: z.array(WebhookTargetSchema).default([]),
  slack_webhook_url: z.string().optional(),
  discord_webhook_url: z.string().optional(),
}).default({});

export const ConfigSchema = z.object({
  agent: z.object({
    type: AgentType.default("claude-code"),
    model: z.string().default(""),
    max_turns: z.number().int().default(50),
    timeout: duration.default("30m"),
    flags: z.array(z.string()).default([]),
    max_cost_usd: z.number().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    usage_limit: z.object({
      enabled: z.boolean().default(true),
      cooldown_minutes: z.number().int().positive().default(60),
      probe_enabled: z.boolean().default(true),
      probe_interval_minutes: z.number().int().positive().default(15),
      max_resumes: z.number().int().positive().default(3),
      detection_patterns: z.array(z.string()).default([
        "usage limit",
        "rate limit",
        "capacity",
        "too many requests",
        "quota exceeded",
        "please try again later",
      ]),
      hang_timeout_ms: z.number().int().positive().default(300000),
    }).default({}),
  }).default({}),

  container: z.object({
    image: z.string().regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-\/]*(:[a-zA-Z0-9._\-]+)?$/,
      "Must be a valid Docker image reference (e.g. forgectl/code-python312 or registry.io/org/image:tag)"
    ).optional(),       // Override workflow's default image
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
      "target/", "*.rlib", "*.o", "*.so", "*.dylib", "*.exe", "*.dll",
      "*.class", "__pycache__/", "*.pyc", ".next/", "coverage/",
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

  github_app: GitHubAppConfigSchema.optional(),

  merger_app: GitHubAppConfigSchema.optional(),

  schedules: z.array(ScheduleEntrySchema).default([]),

  merge_daemon: z.object({
    ci_timeout_ms: z.number().int().positive().default(2_700_000), // 45 min
    poll_interval_ms: z.number().int().positive().default(60_000),
    enable_review: z.boolean().default(true),
    enable_build_fix: z.boolean().default(true),
    validation_commands: z.array(z.string()).default([]),
    branch_pattern: z.string().default("forge/*"),
  }).optional(),

  reactive: z.object({
    enabled: z.boolean().default(false),
    auto_create_issues: z.boolean().default(true),
    max_issues_per_day: z.number().int().positive().default(5),
    poll_interval_ms: z.number().int().positive().default(300_000), // 5 min
    repeated_failure_threshold: z.number().int().min(1).default(3),
    cost_spike_multiplier: z.number().positive().default(3),
    success_rate_floor: z.number().min(0).max(1).default(0.7),
  }).optional(),

  scheduled_qa: z.object({
    enabled: z.boolean().default(false),
    interval_ms: z.number().int().positive().default(86_400_000), // 24 hours
    coverage_threshold: z.number().min(0).max(1).default(0.5),
    max_issues_per_run: z.number().int().positive().default(5),
    labels: z.array(z.string()).default(["scheduled-qa"]),
  }).optional(),

  team: z.object({
    size: z.number().int().min(2).max(5),
  }).optional(),

  planner: z.object({
    decomposition_model: z.string().default("claude-haiku-4-5-20251001"),
    max_sub_issues: z.number().int().min(1).max(50).default(10),
  }).default({}),

  discord: DiscordConfigSchema,

  alerting: AlertingConfigSchema,

  discord: z.object({
    enabled: z.boolean().default(false),
    bot_token: z.string().default(""),
    guild_id: z.string().default(""),
    channel_ids: z.array(z.string()).default([]),
  }).default({}),

  project: z.object({
    auto_create: z.boolean().default(false),
    github_org: z.string().optional(),
  }).default({}),
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
  kind: z.enum(["github", "notion", "linear"]),
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
  // Linear-specific fields
  team_ids: z.array(z.string()).optional(),
  project_id: z.string().optional(),
  webhook_secret: z.string().optional(),
  comments_enabled: z.boolean().default(true),
  comment_events: z.array(z.string()).default(["completed", "failed", "timeout", "aborted"]),
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
  if (data.kind === "linear" && (!data.team_ids || data.team_ids.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tracker kind "linear" requires at least one entry in "team_ids"',
      path: ["team_ids"],
    });
  }
});
