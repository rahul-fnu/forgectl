import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { parsePipeline } from "../pipeline/parser.js";
import type { PipelineDefaults, PipelineDefinition } from "../pipeline/types.js";
import type { BoardTemplate, LoadedTemplate } from "./types.js";

interface WorkflowMarkdown {
  frontMatter: Record<string, unknown>;
  body: string;
}

function interpolateTemplate(input: string, vars: Record<string, unknown>): string {
  return input.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function deepInterpolate<T>(input: T, vars: Record<string, unknown>): T {
  if (typeof input === "string") {
    return interpolateTemplate(input, vars) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => deepInterpolate(item, vars)) as T;
  }

  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = deepInterpolate(value, vars);
    }
    return output as T;
  }

  return input;
}

function parseWorkflowMarkdown(markdownPath: string): WorkflowMarkdown {
  const raw = readFileSync(markdownPath, "utf-8");
  if (!raw.startsWith("---\n")) {
    return { frontMatter: {}, body: raw.trim() };
  }

  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return { frontMatter: {}, body: raw.trim() };
  }

  const frontMatterRaw = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n/, "").trim();
  const parsed = parseYaml(frontMatterRaw);
  const frontMatter = parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : {};

  return { frontMatter, body };
}

function defaultsFromFrontMatter(frontMatter: Record<string, unknown>): PipelineDefaults | undefined {
  const explicit = frontMatter.defaults;
  if (explicit && typeof explicit === "object") {
    return explicit as PipelineDefaults;
  }

  const defaults: PipelineDefaults = {};
  if (typeof frontMatter.workflow === "string") defaults.workflow = frontMatter.workflow;
  if (typeof frontMatter.agent === "string") defaults.agent = frontMatter.agent;
  if (typeof frontMatter.repo === "string") defaults.repo = frontMatter.repo;
  if (typeof frontMatter.review === "boolean") defaults.review = frontMatter.review;
  if (typeof frontMatter.model === "string") defaults.model = frontMatter.model;

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

export function loadTemplatePipeline(
  template: BoardTemplate,
  params: Record<string, string | number | boolean>,
  definitionPath: string,
): LoadedTemplate {
  const templatePath = resolve(dirname(definitionPath), template.source.path);
  if (!existsSync(templatePath)) {
    throw new Error(`Template source not found: ${templatePath}`);
  }

  let pipeline: PipelineDefinition;

  if (template.source.format === "yaml") {
    pipeline = parsePipeline(templatePath);
  } else {
    const parsed = parseWorkflowMarkdown(templatePath);
    const frontMatter = parsed.frontMatter;
    const pipelineRef = frontMatter.pipeline;

    if (typeof pipelineRef === "string" && pipelineRef.length > 0) {
      const pipelinePath = resolve(dirname(templatePath), pipelineRef);
      pipeline = parsePipeline(pipelinePath);
    } else {
      const task = parsed.body || String(frontMatter.task || "").trim();
      if (!task) {
        throw new Error(`Workflow markdown ${templatePath} has no task body`);
      }

      const workflowName = typeof frontMatter.name === "string" && frontMatter.name.trim().length > 0
        ? frontMatter.name.trim()
        : `workflow-${Date.now()}`;

      pipeline = {
        name: workflowName,
        description: typeof frontMatter.description === "string" ? frontMatter.description : undefined,
        defaults: defaultsFromFrontMatter(frontMatter),
        nodes: [
          {
            id: "task",
            task,
          },
        ],
      };
    }

  }

  const mergedVars: Record<string, unknown> = {
    ...(template.params?.defaults ?? {}),
    ...params,
  };

  return {
    pipeline: deepInterpolate(pipeline, mergedVars),
  };
}
