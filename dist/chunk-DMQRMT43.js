#!/usr/bin/env node

// src/config/loader.ts
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import yaml from "js-yaml";

// src/config/schema.ts
import { z } from "zod";
var duration = z.string().regex(/^\d+(s|m|h)$/, "Must be a duration like 30s, 5m, 1h");
var AgentType = z.enum(["claude-code", "codex"]);
var NetworkMode = z.enum(["open", "allowlist", "airgapped"]);
var FailureAction = z.enum(["abandon", "output-wip", "pause"]);
var OrchestrationMode = z.enum(["single", "review", "parallel"]);
var InputMode = z.enum(["repo", "files", "both"]);
var OutputMode = z.enum(["git", "files"]);
var ValidationStepSchema = z.object({
  name: z.string(),
  command: z.string(),
  retries: z.number().int().min(0).default(3),
  timeout: duration.optional(),
  description: z.string().default("")
});
var WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  extends: z.string().optional(),
  // Name of built-in workflow to inherit from
  container: z.object({
    image: z.string(),
    network: z.object({
      mode: NetworkMode.default("open"),
      allow: z.array(z.string()).default([])
    }).default({})
  }),
  input: z.object({
    mode: InputMode.default("repo"),
    mountPath: z.string().default("/workspace")
  }).default({}),
  tools: z.array(z.string()).default([]),
  system: z.string().default(""),
  validation: z.object({
    steps: z.array(ValidationStepSchema).default([]),
    on_failure: FailureAction.default("abandon")
  }).default({}),
  output: z.object({
    mode: OutputMode.default("git"),
    path: z.string().default("/workspace"),
    collect: z.array(z.string()).default([])
  }).default({}),
  review: z.object({
    enabled: z.boolean().default(false),
    system: z.string().default("")
  }).default({})
});
var ConfigSchema = z.object({
  agent: z.object({
    type: AgentType.default("claude-code"),
    model: z.string().default(""),
    max_turns: z.number().int().default(50),
    timeout: duration.default("30m"),
    flags: z.array(z.string()).default([])
  }).default({}),
  container: z.object({
    image: z.string().optional(),
    // Override workflow's default image
    dockerfile: z.string().optional(),
    // Build from custom Dockerfile
    network: z.object({
      mode: NetworkMode.optional(),
      // Override workflow's network mode
      allow: z.array(z.string()).optional()
    }).default({}),
    resources: z.object({
      memory: z.string().default("4g"),
      cpus: z.number().default(2)
    }).default({})
  }).default({}),
  repo: z.object({
    branch: z.object({
      template: z.string().default("forge/{{slug}}/{{ts}}"),
      base: z.string().default("main")
    }).default({}),
    exclude: z.array(z.string()).default([
      "node_modules/",
      "dist/",
      "build/",
      "*.log",
      ".env",
      ".env.*"
    ])
  }).default({}),
  orchestration: z.object({
    mode: OrchestrationMode.default("single"),
    review: z.object({
      max_rounds: z.number().int().default(3)
    }).default({})
  }).default({}),
  commit: z.object({
    message: z.object({
      prefix: z.string().default("[forge]"),
      template: z.string().default("{{prefix}} {{summary}}"),
      include_task: z.boolean().default(true)
    }).default({}),
    author: z.object({
      name: z.string().default("forgectl"),
      email: z.string().default("forge@localhost")
    }).default({}),
    sign: z.boolean().default(false)
  }).default({}),
  output: z.object({
    dir: z.string().default("./forge-output"),
    log_dir: z.string().default(".forgectl/runs")
  }).default({})
});

// src/config/loader.ts
var CONFIG_FILENAMES = [".forgectl/config.yaml", ".forgectl/config.yml"];
function findConfigFile(explicitPath) {
  if (explicitPath) {
    if (existsSync(explicitPath)) return resolve(explicitPath);
    throw new Error(`Config file not found: ${explicitPath}`);
  }
  let dir = process.cwd();
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(home, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function loadConfig(explicitPath) {
  const configPath = findConfigFile(explicitPath);
  if (!configPath) {
    return ConfigSchema.parse({});
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw);
  if (parsed == null || typeof parsed !== "object") {
    return ConfigSchema.parse({});
  }
  return ConfigSchema.parse(parsed);
}
function deepMerge(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const overrideVal = overrides[key];
    if (overrideVal === void 0) continue;
    const baseVal = base[key];
    if (baseVal != null && typeof baseVal === "object" && !Array.isArray(baseVal) && overrideVal != null && typeof overrideVal === "object" && !Array.isArray(overrideVal)) {
      result[key] = deepMerge(
        baseVal,
        overrideVal
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

export {
  WorkflowSchema,
  findConfigFile,
  loadConfig,
  deepMerge
};
//# sourceMappingURL=chunk-DMQRMT43.js.map