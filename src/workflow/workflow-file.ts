import { z } from "zod";
import { readFile } from "node:fs/promises";
import { AgentType, ValidationStepSchema, FailureAction } from "../config/schema.js";
import type { WorkflowFileConfig, ValidatedWorkflowFile } from "./types.js";
import yaml from "js-yaml";

/**
 * Default prompt template used when WORKFLOW.md body is empty.
 */
export const DEFAULT_PROMPT_TEMPLATE = `You are an autonomous coding agent working inside a Docker container.
Your task is to implement the changes described in the GitHub issue below.

## Issue: {{issue.title}}

{{issue.description}}

## Instructions

1. Read the relevant source files to understand the codebase before making changes.
2. Implement the requested changes by editing files directly.
3. After making changes, run any available build/test commands to verify your work.
4. If tests fail, read the error output carefully and fix the issues.
5. Make sure your changes are minimal and focused — only change what is needed.
6. Do NOT create new files unless the issue specifically requires it.
7. Do NOT add unnecessary comments, docstrings, or refactoring beyond what is asked.

Your working directory is the repository root. All source files are available.
Make the changes now.`;

/**
 * Zod schema for WORKFLOW.md front matter.
 * Uses .strict() to reject unknown keys.
 * Tracker is a partial version WITHOUT superRefine (overrides, not complete config).
 */
export const WorkflowFrontMatterSchema = z
  .object({
    extends: z.string().optional(),
    tracker: z
      .object({
        kind: z.enum(["github", "notion"]).optional(),
        token: z.string().optional(),
        active_states: z.array(z.string()).optional(),
        terminal_states: z.array(z.string()).optional(),
        poll_interval_ms: z.number().int().positive().optional(),
        auto_close: z.boolean().optional(),
        repo: z.string().optional(),
        labels: z.array(z.string()).optional(),
        database_id: z.string().optional(),
        property_map: z.record(z.string()).optional(),
        in_progress_label: z.string().optional(),
        done_label: z.string().optional(),
      })
      .optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive(),
      })
      .optional(),
    concurrency: z
      .object({
        max_agents: z.number().int().positive(),
      })
      .optional(),
    workspace: z
      .object({
        root: z.string().optional(),
        hooks: z
          .object({
            after_create: z.string().optional(),
            before_run: z.string().optional(),
            after_run: z.string().optional(),
            before_remove: z.string().optional(),
          })
          .optional(),
        hook_timeout: z
          .string()
          .regex(/^\d+(s|m|h)$/, "Must be a duration like 30s, 5m, 1h")
          .optional(),
      })
      .optional(),
    agent: z
      .object({
        type: AgentType.optional(),
        model: z.string().optional(),
        timeout: z
          .string()
          .regex(/^\d+(s|m|h)$/, "Must be a duration like 30s, 5m, 1h")
          .optional(),
      })
      .optional(),
    validation: z
      .object({
        steps: z.array(ValidationStepSchema).default([]),
        on_failure: FailureAction.default("abandon"),
      })
      .optional(),
  })
  .strict();

export type ParsedFrontMatter = z.infer<typeof WorkflowFrontMatterSchema>;

/**
 * Parse a WORKFLOW.md file content into front matter and body.
 * Front matter must be delimited by --- at the very start of the file.
 * The closing --- uses non-greedy match so horizontal rules in the body are preserved.
 */
export function parseWorkflowFile(content: string): {
  frontMatter: Record<string, unknown>;
  body: string;
} {
  // Front matter must start at position 0 with ---
  const match = content.match(/^---\r?\n([\s\S]*?)---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      "Invalid WORKFLOW.md: missing --- delimiters for front matter. " +
        "File must start with --- followed by YAML front matter and a closing ---.",
    );
  }

  const yamlContent = match[1];
  const body = (match[2] ?? "").trimEnd();

  // Parse YAML (empty string yields null/undefined)
  const parsed = yaml.load(yamlContent);
  const frontMatter =
    parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};

  return { frontMatter, body };
}

/**
 * Load a WORKFLOW.md file from disk, parse, validate, and return config + prompt template.
 */
export async function loadWorkflowFile(
  filePath: string,
): Promise<ValidatedWorkflowFile> {
  const content = await readFile(filePath, "utf-8");
  const { frontMatter, body } = parseWorkflowFile(content);

  // Validate front matter with zod strict schema
  const config = WorkflowFrontMatterSchema.parse(
    frontMatter,
  ) as WorkflowFileConfig;

  // Use body or default prompt template
  const promptTemplate =
    body.trim().length > 0 ? body : DEFAULT_PROMPT_TEMPLATE;

  return { config, promptTemplate };
}
