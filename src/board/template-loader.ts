import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import type { PipelineDefinition } from "../pipeline/types.js";
import type { BoardTemplate } from "./store.js";

function interpolate(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => params[key] ?? `{{${key}}}`);
}

function interpolateDeep(obj: unknown, params: Record<string, string>): unknown {
  if (typeof obj === "string") return interpolate(obj, params);
  if (Array.isArray(obj)) return obj.map((item) => interpolateDeep(item, params));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(value, params);
    }
    return result;
  }
  return obj;
}

interface LoadResult {
  pipeline: PipelineDefinition;
}

export function loadTemplatePipeline(
  template: Pick<BoardTemplate, "source" | "params">,
  params: Record<string, string>,
  boardPath: string,
): LoadResult {
  const boardDir = dirname(resolve(boardPath));
  const mergedParams = { ...(template.params?.defaults ?? {}), ...params };

  if (template.source?.format === "yaml") {
    const filePath = resolve(boardDir, template.source.path);
    const content = readFileSync(filePath, "utf-8");
    const raw = yaml.load(content) as Record<string, unknown>;
    const interpolated = interpolateDeep(raw, mergedParams) as PipelineDefinition;
    return { pipeline: interpolated };
  }

  if (template.source?.format === "workflow-md") {
    const filePath = resolve(boardDir, template.source.path);
    const content = readFileSync(filePath, "utf-8");

    // Parse front matter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      throw new Error(`Invalid WORKFLOW.md format in ${filePath}`);
    }

    const frontMatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
    const body = fmMatch[2].trim();

    // Check if front matter references a pipeline
    if (frontMatter.pipeline) {
      const pipelinePath = resolve(dirname(filePath), frontMatter.pipeline as string);
      const pipelineContent = readFileSync(pipelinePath, "utf-8");
      const raw = yaml.load(pipelineContent) as Record<string, unknown>;
      const interpolated = interpolateDeep(raw, mergedParams) as PipelineDefinition;
      return { pipeline: interpolated };
    }

    // Single-node pipeline from body
    const name = (frontMatter.name as string) ?? "workflow-card";
    const defaults: Record<string, unknown> = {};
    if (frontMatter.workflow) defaults.workflow = frontMatter.workflow;
    if (frontMatter.agent) defaults.agent = frontMatter.agent;

    const interpolatedBody = interpolate(body, mergedParams);

    const pipeline: PipelineDefinition = {
      name,
      defaults: defaults as PipelineDefinition["defaults"],
      nodes: [
        { id: "task", task: interpolatedBody },
      ],
    };

    return { pipeline };
  }

  throw new Error(`Unknown template source format: ${template.source?.format}`);
}
