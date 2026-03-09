import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  pipelineDefinition: text("pipeline_definition").notNull(), // JSON-serialized PipelineDefinition
  status: text("status").notNull().default("running"),
  nodeStates: text("node_states"), // JSON-serialized node states
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
});
