# TASK: Build forgectl Phase 1 + Phase 2

Build the foundation and container engine for forgectl. After this task, the following must work:

1. `forgectl init --stack node` generates a starter `.forgectl/config.yaml`
2. `forgectl auth add claude-code` stores an API key in the system keychain
3. `forgectl auth list` shows stored credentials
4. `forgectl workflows list` shows all 6 built-in workflows
5. `forgectl workflows show code` prints the full code workflow definition
6. The config loader reads `.forgectl/config.yaml`, validates with zod, merges with defaults
7. The workflow resolver merges (workflow + config + CLI flags) into a `RunPlan`
8. Docker images can be built and pulled via `dockerode`
9. Containers can be created, started, exec'd into, stopped, and removed
10. Repo workspaces can be copied into containers (with glob exclusions)
11. File inputs can be mounted into containers at `/input`
12. Credentials can be mounted as read-only files in containers
13. Network isolation works in all three modes: open (default), allowlist (iptables), airgapped
14. All unit tests pass

Do NOT build: agent execution, validation loop, output collection, daemon, dashboard, multi-agent, or relay. Those are later phases. Focus on getting the foundation solid so everything else plugs in cleanly.

---

## Step 1: Project Scaffolding

Create the project with these files:

**package.json:**
```json
{
  "name": "forgectl",
  "version": "0.1.0",
  "description": "Run AI agents in isolated Docker containers for any workflow",
  "type": "module",
  "bin": {
    "forgectl": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:docker": "FORGECTL_SKIP_DOCKER=false vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write 'src/**/*.ts'"
  },
  "dependencies": {
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "dockerode": "^4.0.2",
    "js-yaml": "^4.1.0",
    "keytar": "^7.9.0",
    "picomatch": "^4.0.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.31",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.14.0",
    "@types/picomatch": "^3.0.1",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "tsup": "^8.1.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**tsup.config.ts:**
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

**vitest.config.ts:**
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
```

---

## Step 2: Utility Modules (`src/utils/`)

### `src/utils/template.ts`

Simple Mustache-style `{{variable}}` expansion. No library needed.

```typescript
/**
 * Expand {{variable}} placeholders in a template string.
 * Supports nested keys like {{commit.prefix}}.
 * Unresolved placeholders are left as-is.
 */
export function expandTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key: string) => {
    const parts = key.split(".");
    let value: unknown = vars;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return match;
      value = (value as Record<string, unknown>)[part];
    }
    return value != null ? String(value) : match;
  });
}
```

### `src/utils/slug.ts`

```typescript
/**
 * Generate a URL-safe slug from a task description.
 * "Add rate limiting to /api/upload" → "add-rate-limiting-to-api-upload"
 */
export function slugify(text: string, maxLength = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);
}
```

### `src/utils/duration.ts`

```typescript
/**
 * Parse a duration string like "30m", "1h", "90s" into milliseconds.
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: "${input}". Use format like 30s, 5m, 1h`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format milliseconds into human-readable string: "2m 47s"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
```

### `src/utils/timer.ts`

```typescript
export class Timer {
  private startTime: number;
  constructor() { this.startTime = Date.now(); }
  elapsed(): number { return Date.now() - this.startTime; }
  reset(): void { this.startTime = Date.now(); }
}
```

### `src/utils/hash.ts`

```typescript
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function hashFile(filePath: string): string {
  return hashString(readFileSync(filePath, "utf-8"));
}
```

### `src/utils/ports.ts`

```typescript
import { createServer } from "node:net";

export async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(preferred, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      // Preferred port taken, let OS assign
      const fallback = createServer();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        fallback.close(() => resolve(port));
      });
      fallback.on("error", reject);
    });
  });
}
```

Write tests for all utils at `test/unit/utils.test.ts`.

---

## Step 3: Config Schema + Loader (`src/config/`)

### `src/config/schema.ts`

Define all Zod schemas. These are the source of truth for the config shape.

```typescript
import { z } from "zod";

const duration = z.string().regex(/^\d+(s|m|h)$/, "Must be a duration like 30s, 5m, 1h");

export const AgentType = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof AgentType>;

export const NetworkMode = z.enum(["open", "allowlist", "airgapped"]);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const FailureAction = z.enum(["abandon", "output-wip", "pause"]);
export const OrchestrationMode = z.enum(["single", "review", "parallel"]);
export const InputMode = z.enum(["repo", "files", "both"]);
export const OutputMode = z.enum(["git", "files"]);

export const ValidationStepSchema = z.object({
  name: z.string(),
  command: z.string(),
  retries: z.number().int().min(0).default(3),
  timeout: duration.optional(),
  description: z.string().default(""),
});
export type ValidationStep = z.infer<typeof ValidationStepSchema>;

export const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  extends: z.string().optional(),   // Name of built-in workflow to inherit from
  container: z.object({
    image: z.string(),
    network: z.object({
      mode: NetworkMode.default("open"),
      allow: z.array(z.string()).default([]),
    }).default({}),
  }),
  input: z.object({
    mode: InputMode.default("repo"),
    mountPath: z.string().default("/workspace"),
  }).default({}),
  tools: z.array(z.string()).default([]),
  system: z.string().default(""),
  validation: z.object({
    steps: z.array(ValidationStepSchema).default([]),
    on_failure: FailureAction.default("abandon"),
  }).default({}),
  output: z.object({
    mode: OutputMode.default("git"),
    path: z.string().default("/workspace"),
    collect: z.array(z.string()).default([]),
  }).default({}),
  review: z.object({
    enabled: z.boolean().default(false),
    system: z.string().default(""),
  }).default({}),
});
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;

export const ConfigSchema = z.object({
  agent: z.object({
    type: AgentType.default("claude-code"),
    model: z.string().default(""),
    max_turns: z.number().int().default(50),
    timeout: duration.default("30m"),
    flags: z.array(z.string()).default([]),
  }).default({}),

  container: z.object({
    image: z.string().optional(),       // Override workflow's default image
    dockerfile: z.string().optional(),  // Build from custom Dockerfile
    network: z.object({
      mode: NetworkMode.optional(),     // Override workflow's network mode
      allow: z.array(z.string()).optional(),
    }).default({}),
    resources: z.object({
      memory: z.string().default("4g"),
      cpus: z.number().default(2),
    }).default({}),
  }).default({}),

  repo: z.object({
    branch: z.object({
      template: z.string().default("forge/{{slug}}/{{ts}}"),
      base: z.string().default("main"),
    }).default({}),
    exclude: z.array(z.string()).default([
      "node_modules/", ".git/objects/", "dist/", "build/", "*.log", ".env", ".env.*",
    ]),
  }).default({}),

  orchestration: z.object({
    mode: OrchestrationMode.default("single"),
    review: z.object({
      max_rounds: z.number().int().default(3),
    }).default({}),
  }).default({}),

  commit: z.object({
    message: z.object({
      prefix: z.string().default("[forge]"),
      template: z.string().default("{{prefix}} {{summary}}"),
      include_task: z.boolean().default(true),
    }).default({}),
    author: z.object({
      name: z.string().default("forgectl"),
      email: z.string().default("forge@localhost"),
    }).default({}),
    sign: z.boolean().default(false),
  }).default({}),

  output: z.object({
    dir: z.string().default("./forge-output"),
    log_dir: z.string().default(".forgectl/runs"),
  }).default({}),
});

export type ForgectlConfig = z.infer<typeof ConfigSchema>;
```

### `src/config/loader.ts`

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema, type ForgectlConfig } from "./schema.js";

const CONFIG_FILENAMES = [".forgectl/config.yaml", ".forgectl/config.yml"];

/**
 * Find the config file by walking up directories.
 * Check: CLI path → cwd → parent dirs → ~/.forgectl/config.yaml
 */
export function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    if (existsSync(explicitPath)) return resolve(explicitPath);
    throw new Error(`Config file not found: ${explicitPath}`);
  }

  // Walk up from cwd
  let dir = process.cwd();
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  // Check home directory
  const home = process.env.HOME || process.env.USERPROFILE || "";
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(home, name);
    if (existsSync(candidate)) return candidate;
  }

  return null; // No config found — use defaults
}

/**
 * Load config from file, validate with zod, return typed config.
 * Returns defaults if no config file exists.
 */
export function loadConfig(explicitPath?: string): ForgectlConfig {
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

/**
 * Deep merge two objects. `overrides` values take precedence.
 * Arrays are replaced (not merged). Undefined values in overrides are skipped.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: Partial<T>
): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const overrideVal = overrides[key];
    if (overrideVal === undefined) continue;
    const baseVal = base[key];
    if (
      baseVal != null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      overrideVal != null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      ) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}
```

Write tests at `test/unit/config.test.ts`: test schema validation, test default values, test loading from YAML string, test deep merge.

---

## Step 4: Workflow System (`src/workflow/`)

### `src/workflow/types.ts`

Re-export the `WorkflowDefinition` type from schema.ts. Add the `RunPlan` interface:

```typescript
import type { WorkflowDefinition, AgentType, NetworkMode, ValidationStep, ForgectlConfig } from "../config/schema.js";

export type { WorkflowDefinition };

export interface NetworkConfig {
  mode: "open" | "allowlist" | "airgapped";
  dockerNetwork: string;       // "bridge" for open, "none" for airgapped, "forgectl-<runId>" for allowlist
  allow?: string[];            // Only for allowlist mode
}

export interface ResourceConfig {
  memory: string;
  cpus: number;
}

export interface InjectConfig {
  source: string;   // Host path
  target: string;   // Container path
}

export interface ReviewConfig {
  enabled: boolean;
  system: string;
  maxRounds: number;
  agent: AgentType;
  model: string;
}

export interface CommitConfig {
  message: { prefix: string; template: string; includeTask: boolean };
  author: { name: string; email: string };
  sign: boolean;
}

export interface RunPlan {
  runId: string;
  task: string;
  workflow: WorkflowDefinition;
  agent: {
    type: AgentType;
    model: string;
    maxTurns: number;
    timeout: number;   // in ms
    flags: string[];
  };
  container: {
    image: string;
    dockerfile?: string;
    network: NetworkConfig;
    resources: ResourceConfig;
  };
  input: {
    mode: "repo" | "files" | "both";
    sources: string[];       // Paths to repo or input files
    mountPath: string;
    exclude: string[];       // For repo mode
  };
  context: {
    system: string;
    files: string[];
    inject: InjectConfig[];
  };
  validation: {
    steps: ValidationStep[];
    onFailure: "abandon" | "output-wip" | "pause";
  };
  output: {
    mode: "git" | "files";
    path: string;            // Container path
    collect: string[];       // Globs for file mode
    hostDir: string;         // Where file output lands on host
  };
  orchestration: {
    mode: "single" | "review" | "parallel";
    review: ReviewConfig;
  };
  commit: CommitConfig;
}
```

### `src/workflow/builtins/`

Create one TypeScript file per built-in workflow. Each exports a `WorkflowDefinition` object.

Create these files with the exact content from the workflow YAML definitions in the spec:
- `src/workflow/builtins/code.ts`
- `src/workflow/builtins/research.ts`
- `src/workflow/builtins/content.ts`
- `src/workflow/builtins/data.ts`
- `src/workflow/builtins/ops.ts`
- `src/workflow/builtins/general.ts`

The `general` workflow is:
```typescript
export const generalWorkflow: WorkflowDefinition = {
  name: "general",
  description: "General-purpose workflow. Configure via project config.",
  container: {
    image: "forgectl/code-node20",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["git", "curl", "jq", "python3"],
  system: `You are an AI assistant working in an isolated container.
Input files (if any) are in /input. Write output to /output.
Complete the task as instructed.`,
  validation: { steps: [], on_failure: "output-wip" },
  output: { mode: "files", path: "/output", collect: ["**/*"] },
  review: { enabled: false, system: "" },
};
```

### `src/workflow/registry.ts`

```typescript
import type { WorkflowDefinition } from "./types.js";
import { codeWorkflow } from "./builtins/code.js";
import { researchWorkflow } from "./builtins/research.js";
import { contentWorkflow } from "./builtins/content.js";
import { dataWorkflow } from "./builtins/data.js";
import { opsWorkflow } from "./builtins/ops.js";
import { generalWorkflow } from "./builtins/general.js";
import { loadCustomWorkflows } from "./custom.js";
import { deepMerge } from "../config/loader.js";

const BUILTINS: Record<string, WorkflowDefinition> = {
  code: codeWorkflow,
  research: researchWorkflow,
  content: contentWorkflow,
  data: dataWorkflow,
  ops: opsWorkflow,
  general: generalWorkflow,
};

/**
 * Get a workflow by name. Checks built-ins first, then custom workflows.
 * Custom workflows with `extends` inherit from the base and override.
 */
export function getWorkflow(name: string, projectDir?: string): WorkflowDefinition {
  // Check built-ins
  if (BUILTINS[name]) return BUILTINS[name];

  // Check custom workflows
  const customs = loadCustomWorkflows(projectDir);
  const custom = customs[name];
  if (!custom) {
    throw new Error(
      `Unknown workflow: "${name}". Available: ${listWorkflowNames(projectDir).join(", ")}`
    );
  }

  // If custom extends a built-in, merge
  if (custom.extends && BUILTINS[custom.extends]) {
    return deepMerge(BUILTINS[custom.extends], custom) as WorkflowDefinition;
  }

  return custom;
}

export function listWorkflowNames(projectDir?: string): string[] {
  const customNames = Object.keys(loadCustomWorkflows(projectDir));
  return [...Object.keys(BUILTINS), ...customNames];
}

export function listWorkflows(projectDir?: string): WorkflowDefinition[] {
  const customs = loadCustomWorkflows(projectDir);
  return [...Object.values(BUILTINS), ...Object.values(customs)];
}
```

### `src/workflow/custom.ts`

Load user-defined workflow YAML files from `.forgectl/workflows/`.

```typescript
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { WorkflowSchema, type WorkflowDefinition } from "../config/schema.js";

export function loadCustomWorkflows(
  projectDir?: string
): Record<string, WorkflowDefinition & { extends?: string }> {
  const dir = resolve(projectDir || process.cwd(), ".forgectl", "workflows");
  if (!existsSync(dir)) return {};

  const result: Record<string, WorkflowDefinition & { extends?: string }> = {};

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = readFileSync(join(dir, file), "utf-8");
    const parsed = yaml.load(raw);
    if (parsed == null || typeof parsed !== "object") continue;

    // Validate but allow `extends` field
    const workflow = WorkflowSchema.parse(parsed);
    const extendsField = (parsed as Record<string, unknown>).extends as string | undefined;
    result[workflow.name] = { ...workflow, extends: extendsField };
  }

  return result;
}
```

### `src/workflow/resolver.ts`

The resolver produces a `RunPlan` from (workflow + config + CLI options).

```typescript
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { ForgectlConfig } from "../config/schema.js";
import type { WorkflowDefinition, RunPlan, NetworkConfig } from "./types.js";
import { getWorkflow } from "./registry.js";
import { parseDuration } from "../utils/duration.js";
import { slugify } from "../utils/slug.js";

export interface CLIOptions {
  task: string;
  workflow?: string;
  repo?: string;
  input?: string[];
  context?: string[];
  agent?: string;
  model?: string;
  review?: boolean;
  noReview?: boolean;
  outputDir?: string;
  timeout?: string;
  verbose?: boolean;
  noCleanup?: boolean;
  dryRun?: boolean;
}

/**
 * Auto-detect workflow from CLI inputs if not explicitly specified.
 */
function detectWorkflow(options: CLIOptions): string {
  if (options.workflow) return options.workflow;
  if (options.repo) return "code";
  if (options.input?.some(f => /\.(csv|tsv|json|parquet|xlsx)$/i.test(f))) return "data";
  if (options.input?.some(f => /\.(md|txt|docx|doc)$/i.test(f))) return "content";
  // Check if cwd is a git repo
  try {
    const { execSync } = require("node:child_process");
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return "code";
  } catch {
    return "general";
  }
}

/**
 * Resolve network configuration from workflow + config overrides.
 */
function resolveNetwork(
  workflow: WorkflowDefinition,
  config: ForgectlConfig,
  agentType: string,
  runId: string
): NetworkConfig {
  const mode = config.container.network.mode ?? workflow.container.network.mode;

  if (mode === "open") {
    return { mode: "open", dockerNetwork: "bridge" };
  }

  if (mode === "airgapped") {
    return { mode: "airgapped", dockerNetwork: "none" };
  }

  // Allowlist mode
  const allow = [
    ...workflow.container.network.allow,
    ...(config.container.network.allow ?? []),
  ];

  // Auto-add LLM API domain
  if (agentType === "claude-code" && !allow.includes("api.anthropic.com")) {
    allow.push("api.anthropic.com");
  }
  if (agentType === "codex" && !allow.includes("api.openai.com")) {
    allow.push("api.openai.com");
  }

  return {
    mode: "allowlist",
    dockerNetwork: `forgectl-${runId}`,
    allow,
  };
}

/**
 * Build a complete RunPlan from workflow definition + config + CLI options.
 */
export function resolveRunPlan(
  config: ForgectlConfig,
  options: CLIOptions
): RunPlan {
  const workflowName = detectWorkflow(options);
  const workflow = getWorkflow(workflowName);
  const runId = `forge-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
  const agentType = (options.agent ?? config.agent.type) as "claude-code" | "codex";
  const slug = slugify(options.task);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

  // Determine input sources
  const inputSources: string[] = [];
  if (workflow.input.mode === "repo" || workflow.input.mode === "both") {
    inputSources.push(resolve(options.repo || config.repo?.branch?.base ? "." : "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map(p => resolve(p)));
  }

  // Determine review config
  const reviewEnabled = options.review === true
    ? true
    : options.noReview === true
    ? false
    : workflow.review.enabled;

  return {
    runId,
    task: options.task,
    workflow,
    agent: {
      type: agentType,
      model: options.model ?? config.agent.model,
      maxTurns: config.agent.max_turns,
      timeout: parseDuration(options.timeout ?? config.agent.timeout),
      flags: config.agent.flags,
    },
    container: {
      image: config.container.image ?? workflow.container.image,
      dockerfile: config.container.dockerfile,
      network: resolveNetwork(workflow, config, agentType, runId),
      resources: {
        memory: config.container.resources.memory,
        cpus: config.container.resources.cpus,
      },
    },
    input: {
      mode: workflow.input.mode,
      sources: inputSources.length > 0 ? inputSources : [resolve(".")],
      mountPath: workflow.input.mountPath,
      exclude: config.repo.exclude,
    },
    context: {
      system: workflow.system,
      files: options.context ?? [],
      inject: [],
    },
    validation: {
      steps: workflow.validation.steps,
      onFailure: workflow.validation.on_failure,
    },
    output: {
      mode: workflow.output.mode,
      path: workflow.output.path,
      collect: workflow.output.collect,
      hostDir: resolve(options.outputDir ?? config.output.dir, runId),
    },
    orchestration: {
      mode: reviewEnabled && config.orchestration.mode === "single" ? "review" : config.orchestration.mode,
      review: {
        enabled: reviewEnabled,
        system: workflow.review.system,
        maxRounds: config.orchestration.review.max_rounds,
        agent: agentType,
        model: options.model ?? config.agent.model,
      },
    },
    commit: {
      message: {
        prefix: config.commit.message.prefix,
        template: config.commit.message.template,
        includeTask: config.commit.message.include_task,
      },
      author: config.commit.author,
      sign: config.commit.sign,
    },
  };
}
```

Write tests at `test/unit/workflow-resolver.test.ts`: test auto-detection, test merge priority, test review flag override, test network resolution for each mode.

---

## Step 5: Auth / BYOK (`src/auth/`)

### `src/auth/store.ts`

Abstract credential store. Uses `keytar` for system keychain access.

```typescript
import keytar from "keytar";

const SERVICE_NAME = "forgectl";

export async function setCredential(provider: string, key: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, `${provider}:${key}`, value);
}

export async function getCredential(provider: string, key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, `${provider}:${key}`);
}

export async function deleteCredential(provider: string, key: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE_NAME, `${provider}:${key}`);
}

export async function listCredentials(): Promise<Array<{ provider: string; key: string }>> {
  const all = await keytar.findCredentials(SERVICE_NAME);
  return all.map(cred => {
    const [provider, key] = cred.account.split(":", 2);
    return { provider, key };
  });
}
```

### `src/auth/claude.ts`

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCredential, setCredential } from "./store.js";

const PROVIDER = "claude-code";

export interface ClaudeAuth {
  type: "api_key" | "oauth_session";
  apiKey?: string;
  sessionDir?: string;
}

export async function getClaudeAuth(): Promise<ClaudeAuth | null> {
  // Check for API key first
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };

  // Check for OAuth session
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) return { type: "oauth_session", sessionDir: claudeDir };

  return null;
}

export async function setClaudeApiKey(key: string): Promise<void> {
  await setCredential(PROVIDER, "api_key", key);
}
```

### `src/auth/codex.ts`

```typescript
import { getCredential, setCredential } from "./store.js";

const PROVIDER = "codex";

export async function getCodexAuth(): Promise<string | null> {
  return getCredential(PROVIDER, "api_key");
}

export async function setCodexApiKey(key: string): Promise<void> {
  await setCredential(PROVIDER, "api_key", key);
}
```

### `src/auth/mount.ts`

Prepare credentials for container mounting.

```typescript
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ClaudeAuth } from "./claude.js";

export interface ContainerMounts {
  binds: string[];                   // Docker bind mount strings
  env: Record<string, string>;       // Env vars to set in agent process
  cleanup: () => void;               // Call after run to wipe temp files
}

export function prepareClaudeMounts(auth: ClaudeAuth, runId: string): ContainerMounts {
  const secretsDir = join(tmpdir(), `forgectl-secrets-${runId}-${randomBytes(4).toString("hex")}`);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const binds: string[] = [];
  const env: Record<string, string> = {};

  if (auth.type === "api_key" && auth.apiKey) {
    const keyPath = join(secretsDir, "anthropic_api_key");
    writeFileSync(keyPath, auth.apiKey, { mode: 0o400 });
    binds.push(`${secretsDir}:/run/secrets:ro`);
    // Env injection happens at exec time: ANTHROPIC_API_KEY=$(cat /run/secrets/anthropic_api_key)
    env.ANTHROPIC_API_KEY_FILE = "/run/secrets/anthropic_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    binds.push(`${auth.sessionDir}:/home/node/.claude:ro`);
  }

  return {
    binds,
    env,
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch {} },
  };
}

export function prepareCodexMounts(apiKey: string, runId: string): ContainerMounts {
  const secretsDir = join(tmpdir(), `forgectl-secrets-${runId}-${randomBytes(4).toString("hex")}`);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const keyPath = join(secretsDir, "openai_api_key");
  writeFileSync(keyPath, apiKey, { mode: 0o400 });

  return {
    binds: [`${secretsDir}:/run/secrets:ro`],
    env: { OPENAI_API_KEY_FILE: "/run/secrets/openai_api_key" },
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch {} },
  };
}
```

---

## Step 6: Container Engine (`src/container/`)

### `src/container/builder.ts`

```typescript
import Docker from "dockerode";

const docker = new Docker();

export async function imageExists(imageName: string): Promise<boolean> {
  try {
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(imageName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

export async function buildImage(
  dockerfilePath: string,
  contextPath: string,
  tag: string
): Promise<void> {
  const stream = await docker.buildImage(
    { context: contextPath, src: [dockerfilePath] },
    { t: tag, dockerfile: dockerfilePath }
  );
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export async function ensureImage(
  imageName?: string,
  dockerfilePath?: string,
  contextPath?: string
): Promise<string> {
  if (dockerfilePath && contextPath) {
    const tag = `forgectl-custom:latest`;
    await buildImage(dockerfilePath, contextPath, tag);
    return tag;
  }

  const name = imageName || "forgectl/code-node20";
  if (!(await imageExists(name))) {
    await pullImage(name);
  }
  return name;
}
```

### `src/container/runner.ts`

The core container lifecycle manager.

```typescript
import Docker from "dockerode";
import type { RunPlan, NetworkConfig } from "../workflow/types.js";

const docker = new Docker();

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Create and start a container based on the RunPlan.
 */
export async function createContainer(
  plan: RunPlan,
  binds: string[]
): Promise<Docker.Container> {
  const networkMode = plan.container.network.dockerNetwork;

  const container = await docker.createContainer({
    Image: plan.container.image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: plan.input.mountPath,
    HostConfig: {
      NetworkMode: networkMode,
      Memory: parseMemory(plan.container.resources.memory),
      NanoCpus: plan.container.resources.cpus * 1e9,
      Binds: binds,
      CapAdd: plan.container.network.mode === "allowlist" ? ["NET_ADMIN"] : [],
    },
    Tty: false,
    OpenStdin: false,
  });

  await container.start();
  return container;
}

/**
 * Execute a command inside a running container.
 * Returns stdout, stderr, exit code, and duration.
 */
export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  options?: { env?: string[]; user?: string; workingDir?: string; timeout?: number }
): Promise<ExecResult> {
  const start = Date.now();

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Env: options?.env,
    User: options?.user,
    WorkingDir: options?.workingDir,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // dockerode multiplexes stdout/stderr on the same stream
    // We need to demux it
    docker.modem.demuxStream(stream, 
      { write: (chunk: Buffer) => stdoutChunks.push(chunk) } as NodeJS.WritableStream,
      { write: (chunk: Buffer) => stderrChunks.push(chunk) } as NodeJS.WritableStream
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }

    stream.on("end", async () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const inspection = await exec.inspect();
      resolve({
        exitCode: inspection.ExitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        durationMs: Date.now() - start,
      });
    });

    stream.on("error", (err: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}

/**
 * Stop and remove a container, handling errors gracefully.
 */
export async function destroyContainer(container: Docker.Container): Promise<void> {
  try { await container.stop({ t: 5 }); } catch {}
  try { await container.remove({ force: true }); } catch {}
}

function parseMemory(mem: string): number {
  const match = mem.match(/^(\d+)(g|m)$/i);
  if (!match) return 4 * 1024 * 1024 * 1024; // default 4GB
  const val = parseInt(match[1], 10);
  return match[2].toLowerCase() === "g" ? val * 1024 ** 3 : val * 1024 ** 2;
}
```

### `src/container/workspace.ts`

Copy repo or files into the container.

```typescript
import { execSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import picomatch from "picomatch";
import Docker from "dockerode";
import tar from "tar"; // Add "tar" to dependencies if needed, or use dockerode's putArchive

/**
 * Prepare a workspace directory by copying source with exclusions.
 * Returns the temp directory path.
 */
export function prepareRepoWorkspace(
  repoPath: string,
  exclude: string[]
): string {
  const tmpDir = join(tmpdir(), `forgectl-workspace-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  const isExcluded = picomatch(exclude);

  // Use rsync if available (faster, respects excludes natively)
  // Fallback to recursive copy with filtering
  try {
    const excludeFlags = exclude.map(e => `--exclude='${e}'`).join(" ");
    execSync(`rsync -a ${excludeFlags} '${resolve(repoPath)}/' '${tmpDir}/'`, { stdio: "ignore" });
  } catch {
    // Fallback: manual copy (slower but works everywhere)
    cpSync(resolve(repoPath), tmpDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(resolve(repoPath), "").replace(/^\//, "");
        if (rel === "") return true;
        return !isExcluded(rel);
      },
    });
  }

  return tmpDir;
}

/**
 * Prepare input files workspace for files mode.
 * Copies input files to a temp /input dir and creates empty /output dir.
 */
export function prepareFilesWorkspace(
  inputPaths: string[]
): { inputDir: string; outputDir: string } {
  const base = join(tmpdir(), `forgectl-files-${randomBytes(4).toString("hex")}`);
  const inputDir = join(base, "input");
  const outputDir = join(base, "output");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  for (const p of inputPaths) {
    const resolved = resolve(p);
    if (!existsSync(resolved)) throw new Error(`Input file not found: ${p}`);
    cpSync(resolved, join(inputDir, require("node:path").basename(resolved)), { recursive: true });
  }

  return { inputDir, outputDir };
}
```

### `src/container/network.ts`

Network isolation. Only applies iptables when mode is `allowlist`.

```typescript
import Docker from "dockerode";
import { execInContainer } from "./runner.js";

const docker = new Docker();

/**
 * Create a Docker network for a run (only for allowlist mode).
 */
export async function createIsolatedNetwork(name: string): Promise<Docker.Network> {
  return docker.createNetwork({
    Name: name,
    Driver: "bridge",
    Internal: false,
  });
}

/**
 * Apply iptables firewall inside a container (only for allowlist mode).
 * This restricts outbound traffic to only the allowed domains.
 */
export async function applyFirewall(
  container: Docker.Container,
  allowedDomains: string[]
): Promise<void> {
  const domainsStr = allowedDomains.join(",");
  await execInContainer(container, [
    "/bin/bash", "/usr/local/bin/init-firewall.sh",
  ], {
    env: [`FORGECTL_ALLOWED_DOMAINS=${domainsStr}`],
    user: "root",
  });
}

/**
 * Remove a Docker network.
 */
export async function removeNetwork(name: string): Promise<void> {
  try {
    const network = docker.getNetwork(name);
    await network.remove();
  } catch {}
}

/**
 * Verify firewall is working by testing a blocked domain.
 * Returns true if the domain is blocked (expected), false if it's reachable (unexpected).
 */
export async function verifyFirewall(container: Docker.Container): Promise<boolean> {
  const result = await execInContainer(container, [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", "https://example.com",
  ]);
  // If curl fails or times out, firewall is working
  return result.exitCode !== 0;
}
```

### `src/container/secrets.ts`

Re-export the mount preparation functions from `src/auth/mount.ts` and add the container-side injection helper:

```typescript
export { prepareClaudeMounts, prepareCodexMounts } from "../auth/mount.js";

/**
 * Build the env injection prefix for running an agent command.
 * This reads the secret from the mounted file and sets it as an env var
 * only in the agent's process.
 */
export function buildSecretEnvPrefix(envMapping: Record<string, string>): string {
  const parts: string[] = [];
  for (const [envVar, filePath] of Object.entries(envMapping)) {
    parts.push(`${envVar}=$(cat ${filePath})`);
  }
  return parts.join(" ");
}
```

### `src/container/cleanup.ts`

```typescript
import { rmSync } from "node:fs";
import Docker from "dockerode";
import { destroyContainer } from "./runner.js";
import { removeNetwork } from "./network.js";

export interface CleanupContext {
  container?: Docker.Container;
  networkName?: string;
  tempDirs: string[];
  secretCleanups: Array<() => void>;
}

export async function cleanupRun(ctx: CleanupContext): Promise<void> {
  if (ctx.container) {
    await destroyContainer(ctx.container);
  }
  if (ctx.networkName) {
    await removeNetwork(ctx.networkName);
  }
  for (const dir of ctx.tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  for (const fn of ctx.secretCleanups) {
    try { fn(); } catch {}
  }
}
```

---

## Step 7: CLI Skeleton (`src/cli/` + `src/index.ts`)

### `src/index.ts`

```typescript
import { Command } from "commander";
import { runCommand } from "./cli/run.js";
import { authCommand } from "./cli/auth.js";
import { initCommand } from "./cli/init.js";
import { workflowsCommand } from "./cli/workflows.js";

const program = new Command();

program
  .name("forgectl")
  .description("Run AI agents in isolated Docker containers for any workflow")
  .version("0.1.0");

// forgectl run
program
  .command("run")
  .description("Run a task synchronously")
  .requiredOption("-t, --task <string>", "Task prompt")
  .option("-w, --workflow <string>", "Workflow type")
  .option("-r, --repo <path>", "Repository path")
  .option("-i, --input <paths...>", "Input files/directories")
  .option("--context <paths...>", "Context files for agent prompt")
  .option("-a, --agent <string>", "Agent type: claude-code | codex")
  .option("-m, --model <string>", "Model override")
  .option("-c, --config <path>", "Config file path")
  .option("--review", "Enable review mode")
  .option("--no-review", "Disable review mode")
  .option("-o, --output-dir <path>", "Output directory for file mode")
  .option("--timeout <duration>", "Timeout override (e.g. 30m)")
  .option("--verbose", "Show full agent output")
  .option("--no-cleanup", "Leave container running after run")
  .option("--dry-run", "Show run plan without executing")
  .action(runCommand);

// forgectl auth
const auth = program
  .command("auth")
  .description("Manage BYOK credentials");

auth
  .command("add <provider>")
  .description("Add credentials (claude-code | codex)")
  .action(async (provider: string) => { await authCommand("add", provider); });

auth
  .command("list")
  .description("List configured credentials")
  .action(async () => { await authCommand("list"); });

auth
  .command("remove <provider>")
  .description("Remove credentials")
  .action(async (provider: string) => { await authCommand("remove", provider); });

// forgectl init
program
  .command("init")
  .description("Generate starter config")
  .option("--stack <string>", "Stack template: node|python|go|research|data|ops")
  .action(initCommand);

// forgectl workflows
const workflows = program
  .command("workflows")
  .description("Manage workflows");

workflows
  .command("list")
  .description("List available workflows")
  .action(() => { workflowsCommand("list"); });

workflows
  .command("show <name>")
  .description("Show workflow definition")
  .action((name: string) => { workflowsCommand("show", name); });

// Stub commands for later phases
program.command("submit").description("Submit task to daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented. Use `forgectl run` for synchronous execution.");
});
program.command("up").description("Start daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("down").description("Stop daemon (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("status").description("Show status (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});
program.command("logs").description("Show run logs (not yet implemented)").action(() => {
  console.log("Not yet implemented.");
});

program.parse();
```

### `src/cli/run.ts`

For Phase 1+2, the run command resolves the RunPlan and either does a dry-run (prints the plan) or prints a "not yet implemented" message (agent execution is Phase 3):

```typescript
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { resolveRunPlan, type CLIOptions } from "../workflow/resolver.js";

export async function runCommand(options: CLIOptions): Promise<void> {
  const config = loadConfig(options.config);
  const plan = resolveRunPlan(config, options);

  if (options.dryRun) {
    console.log(chalk.bold("\n📋 Run Plan (dry run)\n"));
    console.log(`  Run ID:     ${plan.runId}`);
    console.log(`  Task:       ${plan.task}`);
    console.log(`  Workflow:   ${plan.workflow.name}`);
    console.log(`  Agent:      ${plan.agent.type}${plan.agent.model ? ` (${plan.agent.model})` : ""}`);
    console.log(`  Image:      ${plan.container.image}`);
    console.log(`  Network:    ${plan.container.network.mode}`);
    console.log(`  Input:      ${plan.input.mode} → ${plan.input.mountPath}`);
    console.log(`  Output:     ${plan.output.mode}${plan.output.mode === "git" ? "" : ` → ${plan.output.hostDir}`}`);
    console.log(`  Validation: ${plan.validation.steps.length} steps`);
    for (const step of plan.validation.steps) {
      console.log(`    - ${step.name}: \`${step.command}\` (${step.retries} retries)`);
    }
    console.log(`  Review:     ${plan.orchestration.review.enabled ? "enabled" : "disabled"}`);
    console.log(`  Timeout:    ${plan.agent.timeout}ms`);
    console.log();
    return;
  }

  // Phase 3 will implement actual execution here
  console.log(chalk.yellow("\nAgent execution not yet implemented. Use --dry-run to see the resolved plan.\n"));
}
```

### `src/cli/auth.ts`

```typescript
import chalk from "chalk";
import { createInterface } from "node:readline";
import { getClaudeAuth, setClaudeApiKey } from "../auth/claude.js";
import { getCodexAuth, setCodexApiKey } from "../auth/codex.js";
import { listCredentials, deleteCredential } from "../auth/store.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export async function authCommand(action: string, provider?: string): Promise<void> {
  if (action === "list") {
    const creds = await listCredentials();
    if (creds.length === 0) {
      console.log(chalk.yellow("No credentials configured. Run `forgectl auth add <provider>`."));
      return;
    }
    console.log(chalk.bold("\nConfigured credentials:\n"));
    for (const { provider, key } of creds) {
      console.log(`  ${chalk.green("✔")} ${provider} (${key})`);
    }
    console.log();
    return;
  }

  if (action === "add") {
    if (provider === "claude-code") {
      const existing = await getClaudeAuth();
      if (existing?.type === "oauth_session") {
        console.log(chalk.green("✔ Found existing Claude Code OAuth session at ~/.claude/"));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your Anthropic API key: ");
      if (!key.startsWith("sk-ant-")) {
        console.log(chalk.yellow("Warning: Key doesn't look like an Anthropic API key (expected sk-ant-...)"));
      }
      await setClaudeApiKey(key);
      console.log(chalk.green("✔ Claude Code API key saved."));
    } else if (provider === "codex") {
      const key = await prompt("Enter your OpenAI API key: ");
      await setCodexApiKey(key);
      console.log(chalk.green("✔ Codex (OpenAI) API key saved."));
    } else {
      console.error(chalk.red(`Unknown provider: ${provider}. Use: claude-code | codex`));
      process.exit(1);
    }
    return;
  }

  if (action === "remove") {
    if (!provider) { console.error("Provider required."); process.exit(1); }
    await deleteCredential(provider, "api_key");
    console.log(chalk.green(`✔ Removed credentials for ${provider}.`));
    return;
  }
}
```

### `src/cli/init.ts`

```typescript
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

const STARTER_CONFIGS: Record<string, string> = {
  node: `# forgectl config — Node.js project
agent:
  type: claude-code

container:
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: npm run lint
      retries: 3
    - name: test
      command: npm test
      retries: 3
    - name: build
      command: npm run build
      retries: 1
`,
  python: `# forgectl config — Python project
agent:
  type: claude-code

container:
  image: forgectl/code-python312
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: ruff check .
      retries: 3
    - name: typecheck
      command: mypy .
      retries: 2
    - name: test
      command: pytest
      retries: 3
`,
  go: `# forgectl config — Go project
agent:
  type: claude-code

container:
  image: forgectl/code-go122
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: golangci-lint run
      retries: 3
    - name: test
      command: go test ./...
      retries: 3
    - name: build
      command: go build ./...
      retries: 1
`,
  research: `# forgectl config — Research workflow
agent:
  type: claude-code

orchestration:
  mode: review

output:
  dir: ./research-output
`,
  data: `# forgectl config — Data workflow
agent:
  type: claude-code

output:
  dir: ./data-output
`,
  ops: `# forgectl config — Ops/Infrastructure workflow
agent:
  type: claude-code

validation:
  steps:
    - name: shellcheck
      command: find . -name '*.sh' -exec shellcheck {} +
      retries: 2
    - name: terraform-validate
      command: terraform validate
      retries: 2
`,
};

export async function initCommand(options: { stack?: string }): Promise<void> {
  const configDir = join(process.cwd(), ".forgectl");
  const configPath = join(configDir, "config.yaml");

  if (existsSync(configPath)) {
    console.log(chalk.yellow(`Config already exists at ${configPath}`));
    return;
  }

  mkdirSync(configDir, { recursive: true });

  const stack = options.stack || "node";
  const content = STARTER_CONFIGS[stack] || STARTER_CONFIGS.node;

  writeFileSync(configPath, content);
  console.log(chalk.green(`✔ Created ${configPath} (stack: ${stack})`));
  console.log(`\nNext steps:`);
  console.log(`  1. Edit .forgectl/config.yaml to match your project`);
  console.log(`  2. Run: forgectl auth add claude-code`);
  console.log(`  3. Run: forgectl run --task "your task" --dry-run`);
}
```

### `src/cli/workflows.ts`

```typescript
import chalk from "chalk";
import yaml from "js-yaml";
import { listWorkflows, getWorkflow } from "../workflow/registry.js";

export function workflowsCommand(action: string, name?: string): void {
  if (action === "list") {
    const workflows = listWorkflows();
    console.log(chalk.bold("\nAvailable workflows:\n"));
    for (const w of workflows) {
      console.log(`  ${chalk.cyan(w.name.padEnd(12))} ${w.description}`);
    }
    console.log(`\nUse ${chalk.cyan("forgectl workflows show <name>")} to see full definition.\n`);
    return;
  }

  if (action === "show" && name) {
    const workflow = getWorkflow(name);
    console.log(chalk.bold(`\nWorkflow: ${workflow.name}\n`));
    console.log(yaml.dump(workflow, { lineWidth: 120, noRefs: true }));
    return;
  }
}
```

---

## Step 8: Dockerfiles + Firewall Script

### `dockerfiles/init-firewall.sh`

```bash
#!/bin/bash
set -euo pipefail

# Only used when network mode = allowlist
# For open mode (default), this script is never called

ALLOWED_DOMAINS="${FORGECTL_ALLOWED_DOMAINS:-}"

iptables -F OUTPUT
iptables -P OUTPUT DROP

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

IFS=',' read -ra DOMAINS <<< "$ALLOWED_DOMAINS"
for domain in "${DOMAINS[@]}"; do
    domain=$(echo "$domain" | xargs)
    [ -z "$domain" ] && continue
    for ip in $(dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true); do
        iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
    done
done

echo "Firewall applied. Allowed: $ALLOWED_DOMAINS"
```

### `dockerfiles/Dockerfile.code-node20`

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq iptables dnsutils ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LO https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep_14.1.0-1_amd64.deb \
    && dpkg -i ripgrep_14.1.0-1_amd64.deb && rm ripgrep_14.1.0-1_amd64.deb
RUN curl -LO https://github.com/sharkdp/fd/releases/download/v10.1.0/fd_10.1.0_amd64.deb \
    && dpkg -i fd_10.1.0_amd64.deb && rm fd_10.1.0_amd64.deb

RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

RUN mkdir -p /input /output
WORKDIR /workspace
```

Create all the other Dockerfiles from the spec (research, content, data, ops).

---

## Step 9: Tests

Create the following test files:

### `test/unit/utils.test.ts`
- Test `expandTemplate` with simple vars, nested vars, missing vars
- Test `slugify` with various strings, edge cases, max length
- Test `parseDuration` for s/m/h, invalid input
- Test `formatDuration` for various ms values

### `test/unit/config.test.ts`
- Test `ConfigSchema.parse({})` returns all defaults
- Test loading a YAML string with overrides
- Test validation errors for bad input
- Test `deepMerge` — nested objects, array replacement, undefined skipping

### `test/unit/workflow-resolver.test.ts`
- Test auto-detection: git repo → code, .csv input → data, .md input → content
- Test explicit workflow override
- Test merge priority: CLI agent flag overrides config overrides workflow default
- Test review flag: `--review` enables review even if workflow default is false
- Test network resolution for open, allowlist, airgapped modes
- Test RunPlan has correct image, mount path, output mode for each built-in workflow

### `test/unit/workflows.test.ts`
- Test all 6 built-in workflows load correctly
- Test `getWorkflow("code")` returns valid definition
- Test `getWorkflow("nonexistent")` throws
- Test `listWorkflowNames()` returns all 6

### `test/integration/container.test.ts` (skip if FORGECTL_SKIP_DOCKER=true)
- Test `createContainer` + `execInContainer` + `destroyContainer`
- Test `exec` captures stdout and stderr separately
- Test `exec` returns correct exit code
- Test workspace copy into container

---

## Summary of What Must Work After This Phase

```bash
# Config
forgectl init --stack node          # Creates .forgectl/config.yaml
forgectl init --stack python        # Python variant
forgectl init --stack research      # Research variant

# Auth
forgectl auth add claude-code       # Stores API key in keychain
forgectl auth list                  # Shows stored creds
forgectl auth remove claude-code    # Removes creds

# Workflows
forgectl workflows list             # Shows 6 built-in workflows
forgectl workflows show code        # Prints full code workflow YAML
forgectl workflows show research    # Prints full research workflow YAML

# Run (dry run only — actual execution is Phase 3)
forgectl run --task "Add tests" --dry-run
# Shows: run ID, task, workflow (auto-detected), agent, image, network mode,
# input mode, output mode, validation steps, review status, timeout

forgectl run --task "Research competitors" --workflow research --dry-run
# Shows research workflow plan with files output mode

forgectl run --task "Clean data" --workflow data --input data.csv --dry-run
# Shows data workflow plan with /input mount

# Tests
npm test                            # All unit tests pass
FORGECTL_SKIP_DOCKER=false npm test # Integration tests with Docker
```
