import { z } from "zod";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import type { PipelineDefinition } from "./types.js";
import { expandShorthands } from "./condition.js";

const PipelineNodeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "Node IDs must be lowercase alphanumeric with hyphens"),
  task: z.string().min(1),
  depends_on: z.array(z.string()).optional(),
  workflow: z.string().optional(),
  agent: z.string().optional(),
  repo: z.string().optional(),
  review: z.boolean().optional(),
  model: z.string().optional(),
  input: z.array(z.string()).optional(),
  context: z.array(z.string()).optional(),
  pipe: z.object({
    mode: z.enum(["branch", "files", "context"]),
  }).optional(),
  node_type: z.enum(["task", "condition", "loop"]).optional(),
  condition: z.string().optional(),
  else_node: z.string().optional(),
  if_failed: z.string().optional(),
  if_passed: z.string().optional(),
  loop: z.object({
    until: z.string(),
    max_iterations: z.number().int().positive().optional(),
    body: z.array(z.string()).optional(),
  }).optional(),
});

const PipelineDefaultsSchema = z.object({
  workflow: z.string().optional(),
  agent: z.string().optional(),
  repo: z.string().optional(),
  review: z.boolean().optional(),
  model: z.string().optional(),
}).optional();

const PipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaults: PipelineDefaultsSchema,
  nodes: z.array(PipelineNodeSchema).min(1),
});

export { PipelineSchema };

/** Parse and validate a pipeline YAML file */
export function parsePipeline(filePath: string): PipelineDefinition {
  const raw = readFileSync(filePath, "utf-8");
  return parsePipelineYaml(raw);
}

/** Parse and validate pipeline YAML content */
export function parsePipelineYaml(yamlContent: string): PipelineDefinition {
  const data = load(yamlContent);
  const parsed = PipelineSchema.parse(data) as PipelineDefinition;
  return expandShorthands(parsed);
}
