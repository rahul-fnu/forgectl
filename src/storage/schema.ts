import { integer, primaryKey as drizzlePrimaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  task: text("task").notNull(),
  workflow: text("workflow"),
  status: text("status").notNull().default("queued"),
  options: text("options"), // JSON-serialized CLIOptions
  submittedAt: text("submitted_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  result: text("result"), // JSON-serialized ExecutionResult
  error: text("error"),
  pauseReason: text("pause_reason"),
  pauseContext: text("pause_context"), // JSON-serialized
  approvalContext: text("approval_context"), // JSON-serialized
  approvalAction: text("approval_action"),
  githubCommentId: integer("github_comment_id"),
  parentRunId: text("parent_run_id"),
  role: text("role"),
  depth: integer("depth").default(0),
  maxChildren: integer("max_children"),
  childrenDispatched: integer("children_dispatched").default(0),
  complexityScore: integer("complexity_score"),
  complexityAssessment: text("complexity_assessment"), // JSON-serialized ComplexityAssessment
  summary: text("summary"), // JSON-serialized RunSummary
});

export const delegations = sqliteTable("delegations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  parentRunId: text("parent_run_id").notNull(),
  childRunId: text("child_run_id"),
  taskSpec: text("task_spec").notNull(),
  status: text("status").notNull().default("pending"),
  result: text("result"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  pipelineDefinition: text("pipeline_definition").notNull(), // JSON-serialized PipelineDefinition
  status: text("status").notNull().default("running"),
  nodeStates: text("node_states"), // JSON-serialized node states
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
});

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  timestamp: text("timestamp").notNull(),
  data: text("data"), // JSON-serialized
});

export const runSnapshots = sqliteTable("run_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  stepName: text("step_name").notNull(),
  timestamp: text("timestamp").notNull(),
  state: text("state").notNull(), // JSON-serialized
});

export const runCosts = sqliteTable("run_costs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  agentType: text("agent_type").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: text("cost_usd").notNull().default("0"), // stored as string for precision
  timestamp: text("timestamp").notNull(),
});

export const runRetries = sqliteTable("run_retries", {
  runId: text("run_id").notNull(),
  attempt: integer("attempt").notNull(),
  nextRetryAt: text("next_retry_at"),
  backoffMs: integer("backoff_ms"),
  failureReason: text("failure_reason"),
  createdAt: text("created_at"),
}, (table) => [
  drizzlePrimaryKey({ columns: [table.runId, table.attempt] }),
]);

export const executionLocks = sqliteTable(
  "execution_locks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lockType: text("lock_type").notNull(), // "issue" | "workspace"
    lockKey: text("lock_key").notNull(), // issue ID or workspace path
    ownerId: text("owner_id").notNull(), // run ID
    daemonPid: integer("daemon_pid").notNull(),
    acquiredAt: text("acquired_at").notNull(),
  },
  (table) => [unique().on(table.lockType, table.lockKey)]
);

export const runOutcomes = sqliteTable("run_outcomes", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  status: text("status"),
  totalTurns: integer("total_turns"),
  lintIterations: integer("lint_iterations"),
  reviewRounds: integer("review_rounds"),
  reviewCommentsJson: text("review_comments_json"),
  failureMode: text("failure_mode"),
  failureDetail: text("failure_detail"),
  humanReviewResult: text("human_review_result"),
  humanReviewComments: integer("human_review_comments"),
  modulesTouched: text("modules_touched"),
  filesChanged: integer("files_changed"),
  testsAdded: integer("tests_added"),
  rawEventsJson: text("raw_events_json"),
  contextEnabled: integer("context_enabled"),
  contextFilesJson: text("context_files_json"),
  contextHitRate: real("context_hit_rate"),
  recovered: integer("recovered"),
});

export const reviewFindings = sqliteTable(
  "review_findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    category: text("category").notNull(),
    pattern: text("pattern").notNull(),
    module: text("module").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
    promotedToConvention: integer("promoted_to_convention").notNull().default(0),
    exampleComment: text("example_comment"),
  },
  (table) => [unique().on(table.category, table.pattern, table.module)]
);

export const reviewMetrics = sqliteTable(
  "review_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    reviewRound: integer("review_round").notNull().default(1),
    reviewCommentsCount: integer("review_comments_count").notNull().default(0),
    reviewMustFix: integer("review_must_fix").notNull().default(0),
    reviewShouldFix: integer("review_should_fix").notNull().default(0),
    reviewNit: integer("review_nit").notNull().default(0),
    reviewApprovedRound: integer("review_approved_round"),
    reviewEscalated: integer("review_escalated").notNull().default(0),
    finalOutcome: text("final_outcome"), // "merged" | "escalated" | "failed"
    humanOverride: integer("human_override").notNull().default(0),
    parseFailureCount: integer("parse_failure_count").notNull().default(0),
    parseSuccessCount: integer("parse_success_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [unique().on(table.repo, table.prNumber, table.reviewRound)]
);

export const reviewCalibration = sqliteTable(
  "review_calibration",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    module: text("module").notNull(),
    totalComments: integer("total_comments").notNull().default(0),
    overriddenComments: integer("overridden_comments").notNull().default(0),
    falsePositiveRate: real("false_positive_rate").notNull().default(0),
    lastUpdated: text("last_updated").notNull(),
  },
  (table) => [unique().on(table.module)]
);
