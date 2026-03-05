import { z } from "zod";

const primitiveParam = z.union([z.string(), z.number(), z.boolean()]);

export const BoardTemplateSourceSchema = z.object({
  format: z.enum(["yaml", "workflow-md"]),
  path: z.string().min(1),
});

export const BoardTemplateParamSpecSchema = z.object({
  required: z.array(z.string().min(1)).default([]),
  defaults: z.record(primitiveParam).default({}),
}).default({});

export const BoardTemplateTriggersSchema = z.object({
  manual: z.boolean().default(true),
  auto_on_enter: z.array(z.string().min(1)).default([]),
  schedule: z.object({
    enabled: z.boolean().default(false),
    interval_minutes: z.number().int().positive().default(60),
  }).default({}),
}).default({});

export const BoardTemplatePostRunSchema = z.object({
  on_success: z.string().optional(),
  on_failure: z.string().optional(),
}).default({});

export const BoardTemplateSchema = z.object({
  source: BoardTemplateSourceSchema,
  params: BoardTemplateParamSpecSchema.optional(),
  triggers: BoardTemplateTriggersSchema.optional(),
  post_run: BoardTemplatePostRunSchema.optional(),
});

export const BoardDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "Board ID must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  transitions: z.record(z.array(z.string().min(1))).optional(),
  templates: z.record(BoardTemplateSchema).refine((templates) => Object.keys(templates).length > 0, {
    message: "At least one template is required",
  }),
});

const cardIdSchema = z.string().regex(/^[a-z0-9-]+$/, "Card ID must be lowercase alphanumeric with hyphens");

export const CreateCardSchema = z.object({
  id: cardIdSchema.optional(),
  title: z.string().min(1),
  type: z.string().min(1),
  column: z.string().optional(),
  params: z.record(primitiveParam).default({}),
});

export const UpdateCardSchema = z.object({
  title: z.string().min(1).optional(),
  column: z.string().min(1).optional(),
  params: z.record(primitiveParam).optional(),
});

export const TriggerCardSchema = z.object({
  mode: z.enum(["manual", "auto", "scheduled"]).default("manual"),
});

export type BoardDefinitionInput = z.infer<typeof BoardDefinitionSchema>;
export type CreateCardInput = z.infer<typeof CreateCardSchema>;
export type UpdateCardInput = z.infer<typeof UpdateCardSchema>;
