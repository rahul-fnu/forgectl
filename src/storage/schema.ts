import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
