import { z } from "zod";

export const AcceptanceCriterionSchema = z.object({
  run: z.string().optional(),
  assert: z.string().optional(),
  description: z.string().optional(),
}).refine(
  (data) => data.run || data.assert || data.description,
  { message: "Acceptance criterion must have at least one of: run, assert, description" }
);

export const TaskContextSchema = z.object({
  files: z.array(z.string()).min(1, "At least one file pattern required"),
  docs: z.array(z.string()).optional(),
  modules: z.array(z.string()).optional(),
  related_tasks: z.array(z.string()).optional(),
});

export const DecompositionConfigSchema = z.object({
  strategy: z.enum(["auto", "manual", "forbidden"]).default("auto"),
  max_depth: z.number().int().min(1).max(5).optional(),
});

export const EffortConfigSchema = z.object({
  max_turns: z.number().int().min(1).max(200).optional(),
  max_review_rounds: z.number().int().min(0).max(5).optional(),
  timeout: z.string().regex(/^\d+(s|m|h|d)$/, "Invalid duration format").optional(),
});

export const TaskBudgetSchema = z.object({
  max_cost_usd: z.number().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
}).optional();

export const TaskSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ID must be lowercase alphanumeric with hyphens"),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  context: TaskContextSchema,
  constraints: z.array(z.string()).default([]),
  acceptance: z.array(AcceptanceCriterionSchema).min(1, "At least one acceptance criterion required"),
  decomposition: DecompositionConfigSchema.default({ strategy: "auto" }),
  effort: EffortConfigSchema.default({}),
  metadata: z.record(z.string()).optional(),
  budget: TaskBudgetSchema,
});

export type ValidatedTaskSpec = z.infer<typeof TaskSpecSchema>;
