#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";

// src/cli/run.ts
import chalk from "chalk";

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
      ".git/objects/",
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

// src/workflow/resolver.ts
import { randomBytes } from "crypto";
import { resolve as resolve3 } from "path";
import { execSync } from "child_process";

// src/workflow/builtins/code.ts
var codeWorkflow = {
  name: "code",
  description: "Write, fix, or refactor code in a git repository",
  container: {
    image: "forgectl/code-node20",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["git", "node/npm", "ripgrep", "fd"],
  system: `You are an expert software engineer working in an isolated container.
Your workspace is at /workspace containing the full project repository.

Rules:
- Make the minimal changes needed to complete the task
- Write tests for any new functionality
- Follow existing code style and conventions
- Do not modify linting rules, test configs, or build scripts
- Do not install new dependencies unless the task requires it`,
  validation: {
    steps: [
      { name: "lint", command: "npm run lint", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "npm run typecheck", retries: 2, description: "TypeScript type checking" },
      { name: "test", command: "npm test", retries: 3, description: "Unit and integration tests" },
      { name: "build", command: "npm run build", retries: 1, description: "Production build" }
    ],
    on_failure: "abandon"
  },
  output: { mode: "git", path: "/workspace", collect: [] },
  review: {
    enabled: true,
    system: `You are a senior code reviewer. Critically review the changes.
Check for: security issues, error handling, resource leaks, logic errors, test coverage.
If acceptable, respond with exactly: LGTM
If issues exist, list them numbered. Only flag real problems, not style preferences.`
  }
};

// src/workflow/builtins/research.ts
var researchWorkflow = {
  name: "research",
  description: "Research a topic, synthesize findings, produce a report",
  container: {
    image: "forgectl/research",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["curl", "puppeteer", "jq", "pandoc", "python3"],
  system: `You are an expert researcher working in an isolated container.

You have access to the web via curl and a headless browser (Puppeteer).
Context files (if any) are in /input.
Write your output to /output.

Rules:
- Cite all sources with URLs
- Distinguish facts from analysis/opinion
- Use markdown for reports
- Include an executive summary at the top
- Save all output files to /output`,
  validation: {
    steps: [
      { name: "output-exists", command: "test -f /output/*.md || test -f /output/*.pdf", retries: 2, description: "Report file exists" },
      { name: "has-sources", command: "grep -c 'http' /output/*.md | awk -F: '{s+=$2} END {if(s<3) exit 1}'", retries: 2, description: "Report includes at least 3 source URLs" },
      { name: "min-length", command: "wc -w /output/*.md | tail -1 | awk '{if($1<500) exit 1}'", retries: 1, description: "Report is at least 500 words" }
    ],
    on_failure: "output-wip"
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.pdf", "**/*.json"] },
  review: {
    enabled: true,
    system: `You are a fact-checker and editor. Review this research report.
Check for: unsupported claims, missing citations, logical gaps, outdated information.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`
  }
};

// src/workflow/builtins/content.ts
var contentWorkflow = {
  name: "content",
  description: "Write blog posts, documentation, marketing copy, translations",
  container: {
    image: "forgectl/content",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["pandoc", "vale", "wkhtmltopdf", "python3"],
  system: `You are an expert writer working in an isolated container.

Context files (brand guides, source material, etc.) are in /input.
Write your output to /output.

Rules:
- Match the tone and style specified in the task or brand guide
- Use markdown unless another format is specified
- Include appropriate headings and structure
- Save all output files to /output`,
  validation: {
    steps: [
      { name: "output-exists", command: "ls /output/*.md /output/*.html /output/*.pdf 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output file exists" },
      { name: "prose-lint", command: "vale --output=line /output/*.md 2>/dev/null || true", retries: 2, description: "Prose quality check (spelling, grammar, style)" }
    ],
    on_failure: "output-wip"
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.html", "**/*.pdf", "**/*.docx"] },
  review: {
    enabled: true,
    system: `You are a senior editor. Review this content for clarity, accuracy, and tone.
Check for: factual errors, unclear writing, tone inconsistency, missing sections.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`
  }
};

// src/workflow/builtins/data.ts
var dataWorkflow = {
  name: "data",
  description: "ETL, analysis, cleaning, visualization, dataset transformation",
  container: {
    image: "forgectl/data",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["python3", "pandas", "numpy", "matplotlib", "duckdb", "jq", "csvkit"],
  system: `You are a data engineer/analyst working in an isolated container.

Input data files are in /input.
Write all output to /output.

Rules:
- Validate data before and after transformations
- Preserve original files in /input (read-only)
- Document any assumptions or data quality issues
- Save analysis scripts to /output/scripts/ so work is reproducible
- Save data outputs to /output/data/
- Save visualizations to /output/viz/`,
  validation: {
    steps: [
      { name: "output-exists", command: "ls /output/data/* 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output data files exist" },
      { name: "scripts-exist", command: "ls /output/scripts/*.py 2>/dev/null | head -1 | grep -q .", retries: 1, description: "Processing scripts are saved (reproducibility)" },
      {
        name: "no-pii",
        command: `python3 -c "
import re, sys, glob
patterns = [r'\\b\\d{3}-\\d{2}-\\d{4}\\b', r'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b']
for f in glob.glob('/output/data/*'):
  text = open(f).read()
  for p in patterns:
    if re.search(p, text):
      print(f'PII detected in {f}'); sys.exit(1)
"`,
        retries: 1,
        description: "Check output for PII (SSN, email patterns)"
      }
    ],
    on_failure: "abandon"
  },
  output: { mode: "files", path: "/output", collect: ["**/*"] },
  review: { enabled: false, system: "" }
};

// src/workflow/builtins/ops.ts
var opsWorkflow = {
  name: "ops",
  description: "Infrastructure scripts, Terraform modules, migration scripts, monitoring config",
  container: {
    image: "forgectl/ops",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["terraform", "aws-cli", "kubectl", "ansible", "shellcheck", "python3"],
  system: `You are a senior infrastructure engineer working in an isolated container.

Your workspace is at /workspace. You are writing infrastructure-as-code.
You do NOT have access to any real cloud accounts or clusters.
All validation is via dry-run / plan / lint \u2014 nothing is applied.

Rules:
- All Terraform must pass \`terraform validate\` and \`terraform fmt\`
- All shell scripts must pass shellcheck
- Include README or comments explaining what the code does
- Use variables for anything environment-specific (no hardcoded values)`,
  validation: {
    steps: [
      { name: "shellcheck", command: "find /workspace -name '*.sh' -exec shellcheck {} + 2>/dev/null || true", retries: 2, description: "Shell script linting" },
      { name: "terraform-fmt", command: "find /workspace -name '*.tf' -exec terraform fmt -check {} + 2>/dev/null || true", retries: 2, description: "Terraform formatting" },
      { name: "terraform-validate", command: "cd /workspace && terraform init -backend=false 2>/dev/null && terraform validate 2>/dev/null || true", retries: 2, description: "Terraform configuration validation" }
    ],
    on_failure: "output-wip"
  },
  output: { mode: "git", path: "/workspace", collect: [] },
  review: {
    enabled: true,
    system: `You are a senior infrastructure reviewer. Review these IaC changes.
Check for: security misconfigs, missing encryption, overly permissive IAM,
hardcoded secrets, missing tagging, resource naming conventions.
If acceptable, respond with: LGTM
If issues exist, list them numbered.`
  }
};

// src/workflow/builtins/general.ts
var generalWorkflow = {
  name: "general",
  description: "General-purpose workflow. Configure via project config.",
  container: {
    image: "forgectl/code-node20",
    network: { mode: "open", allow: [] }
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["git", "curl", "jq", "python3"],
  system: `You are an AI assistant working in an isolated container.
Input files (if any) are in /input. Write output to /output.
Complete the task as instructed.`,
  validation: { steps: [], on_failure: "output-wip" },
  output: { mode: "files", path: "/output", collect: ["**/*"] },
  review: { enabled: false, system: "" }
};

// src/workflow/custom.ts
import { readdirSync, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { join as join2, resolve as resolve2 } from "path";
import yaml2 from "js-yaml";
function loadCustomWorkflows(projectDir) {
  const dir = resolve2(projectDir || process.cwd(), ".forgectl", "workflows");
  if (!existsSync2(dir)) return {};
  const result = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = readFileSync2(join2(dir, file), "utf-8");
    const parsed = yaml2.load(raw);
    if (parsed == null || typeof parsed !== "object") continue;
    const workflow = WorkflowSchema.parse(parsed);
    const extendsField = parsed.extends;
    result[workflow.name] = { ...workflow, extends: extendsField };
  }
  return result;
}

// src/workflow/registry.ts
var BUILTINS = {
  code: codeWorkflow,
  research: researchWorkflow,
  content: contentWorkflow,
  data: dataWorkflow,
  ops: opsWorkflow,
  general: generalWorkflow
};
function getWorkflow(name, projectDir) {
  if (BUILTINS[name]) return BUILTINS[name];
  const customs = loadCustomWorkflows(projectDir);
  const custom = customs[name];
  if (!custom) {
    throw new Error(
      `Unknown workflow: "${name}". Available: ${listWorkflowNames(projectDir).join(", ")}`
    );
  }
  if (custom.extends && BUILTINS[custom.extends]) {
    return deepMerge(BUILTINS[custom.extends], custom);
  }
  return custom;
}
function listWorkflowNames(projectDir) {
  const customNames = Object.keys(loadCustomWorkflows(projectDir));
  return [...Object.keys(BUILTINS), ...customNames];
}
function listWorkflows(projectDir) {
  const customs = loadCustomWorkflows(projectDir);
  return [...Object.values(BUILTINS), ...Object.values(customs)];
}

// src/utils/duration.ts
function parseDuration(input) {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: "${input}". Use format like 30s, 5m, 1h`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1e3;
    case "m":
      return value * 60 * 1e3;
    case "h":
      return value * 60 * 60 * 1e3;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

// src/workflow/resolver.ts
function detectWorkflow(options) {
  if (options.workflow) return options.workflow;
  if (options.repo) return "code";
  if (options.input?.some((f) => /\.(csv|tsv|json|parquet|xlsx)$/i.test(f))) return "data";
  if (options.input?.some((f) => /\.(md|txt|docx|doc)$/i.test(f))) return "content";
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return "code";
  } catch {
    return "general";
  }
}
function resolveNetwork(workflow, config, agentType, runId) {
  const mode = config.container.network.mode ?? workflow.container.network.mode;
  if (mode === "open") {
    return { mode: "open", dockerNetwork: "bridge" };
  }
  if (mode === "airgapped") {
    return { mode: "airgapped", dockerNetwork: "none" };
  }
  const allow = [
    ...workflow.container.network.allow,
    ...config.container.network.allow ?? []
  ];
  if (agentType === "claude-code" && !allow.includes("api.anthropic.com")) {
    allow.push("api.anthropic.com");
  }
  if (agentType === "codex" && !allow.includes("api.openai.com")) {
    allow.push("api.openai.com");
  }
  return {
    mode: "allowlist",
    dockerNetwork: `forgectl-${runId}`,
    allow
  };
}
function resolveRunPlan(config, options) {
  const workflowName = detectWorkflow(options);
  const workflow = getWorkflow(workflowName);
  const runId = `forge-${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
  const agentType = options.agent ?? config.agent.type;
  const inputSources = [];
  if (workflow.input.mode === "repo" || workflow.input.mode === "both") {
    inputSources.push(resolve3(options.repo || "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map((p) => resolve3(p)));
  }
  const reviewEnabled = options.review === true ? true : options.noReview === true ? false : workflow.review.enabled;
  return {
    runId,
    task: options.task,
    workflow,
    agent: {
      type: agentType,
      model: options.model ?? config.agent.model,
      maxTurns: config.agent.max_turns,
      timeout: parseDuration(options.timeout ?? config.agent.timeout),
      flags: config.agent.flags
    },
    container: {
      image: config.container.image ?? workflow.container.image,
      dockerfile: config.container.dockerfile,
      network: resolveNetwork(workflow, config, agentType, runId),
      resources: {
        memory: config.container.resources.memory,
        cpus: config.container.resources.cpus
      }
    },
    input: {
      mode: workflow.input.mode,
      sources: inputSources.length > 0 ? inputSources : [resolve3(".")],
      mountPath: workflow.input.mountPath,
      exclude: config.repo.exclude
    },
    context: {
      system: workflow.system,
      files: options.context ?? [],
      inject: []
    },
    validation: {
      steps: workflow.validation.steps,
      onFailure: workflow.validation.on_failure
    },
    output: {
      mode: workflow.output.mode,
      path: workflow.output.path,
      collect: workflow.output.collect,
      hostDir: resolve3(options.outputDir ?? config.output.dir, runId)
    },
    orchestration: {
      mode: reviewEnabled && config.orchestration.mode === "single" ? "review" : config.orchestration.mode,
      review: {
        enabled: reviewEnabled,
        system: workflow.review.system,
        maxRounds: config.orchestration.review.max_rounds,
        agent: agentType,
        model: options.model ?? config.agent.model
      }
    },
    commit: {
      message: {
        prefix: config.commit.message.prefix,
        template: config.commit.message.template,
        includeTask: config.commit.message.include_task
      },
      author: config.commit.author,
      sign: config.commit.sign
    }
  };
}

// src/cli/run.ts
async function runCommand(options) {
  const config = loadConfig(options.config);
  const plan = resolveRunPlan(config, options);
  if (options.dryRun) {
    console.log(chalk.bold("\n\u{1F4CB} Run Plan (dry run)\n"));
    console.log(`  Run ID:     ${plan.runId}`);
    console.log(`  Task:       ${plan.task}`);
    console.log(`  Workflow:   ${plan.workflow.name}`);
    console.log(`  Agent:      ${plan.agent.type}${plan.agent.model ? ` (${plan.agent.model})` : ""}`);
    console.log(`  Image:      ${plan.container.image}`);
    console.log(`  Network:    ${plan.container.network.mode}`);
    console.log(`  Input:      ${plan.input.mode} \u2192 ${plan.input.mountPath}`);
    console.log(`  Output:     ${plan.output.mode}${plan.output.mode === "git" ? "" : ` \u2192 ${plan.output.hostDir}`}`);
    console.log(`  Validation: ${plan.validation.steps.length} steps`);
    for (const step of plan.validation.steps) {
      console.log(`    - ${step.name}: \`${step.command}\` (${step.retries} retries)`);
    }
    console.log(`  Review:     ${plan.orchestration.review.enabled ? "enabled" : "disabled"}`);
    console.log(`  Timeout:    ${plan.agent.timeout}ms`);
    console.log();
    return;
  }
  console.log(chalk.yellow("\nAgent execution not yet implemented. Use --dry-run to see the resolved plan.\n"));
}

// src/cli/auth.ts
import chalk2 from "chalk";
import { createInterface } from "readline";

// src/auth/claude.ts
import { existsSync as existsSync4 } from "fs";
import { join as join4 } from "path";

// src/auth/store.ts
import { readFileSync as readFileSync3, writeFileSync, existsSync as existsSync3, mkdirSync } from "fs";
import { join as join3 } from "path";
var SERVICE_NAME = "forgectl";
var FileStore = class {
  filePath;
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const dir = join3(home, ".forgectl");
    mkdirSync(dir, { recursive: true });
    this.filePath = join3(dir, "credentials.json");
  }
  load() {
    if (!existsSync3(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync3(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }
  save(data) {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 384 });
  }
  async setPassword(service, account, password) {
    const data = this.load();
    if (!data[service]) data[service] = {};
    data[service][account] = password;
    this.save(data);
  }
  async getPassword(service, account) {
    const data = this.load();
    return data[service]?.[account] ?? null;
  }
  async deletePassword(service, account) {
    const data = this.load();
    if (!data[service]?.[account]) return false;
    delete data[service][account];
    this.save(data);
    return true;
  }
  async findCredentials(service) {
    const data = this.load();
    const serviceData = data[service] ?? {};
    return Object.entries(serviceData).map(([account, password]) => ({ account, password }));
  }
};
async function loadStore() {
  try {
    const keytar = await import("keytar");
    return keytar.default;
  } catch {
    return new FileStore();
  }
}
var storePromise = loadStore();
async function setCredential(provider, key, value) {
  const store = await storePromise;
  await store.setPassword(SERVICE_NAME, `${provider}:${key}`, value);
}
async function getCredential(provider, key) {
  const store = await storePromise;
  return store.getPassword(SERVICE_NAME, `${provider}:${key}`);
}
async function deleteCredential(provider, key) {
  const store = await storePromise;
  return store.deletePassword(SERVICE_NAME, `${provider}:${key}`);
}
async function listCredentials() {
  const store = await storePromise;
  const all = await store.findCredentials(SERVICE_NAME);
  return all.map((cred) => {
    const [provider, key] = cred.account.split(":", 2);
    return { provider, key };
  });
}

// src/auth/claude.ts
var PROVIDER = "claude-code";
async function getClaudeAuth() {
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeDir = join4(home, ".claude");
  if (existsSync4(claudeDir)) return { type: "oauth_session", sessionDir: claudeDir };
  return null;
}
async function setClaudeApiKey(key) {
  await setCredential(PROVIDER, "api_key", key);
}

// src/auth/codex.ts
var PROVIDER2 = "codex";
async function setCodexApiKey(key) {
  await setCredential(PROVIDER2, "api_key", key);
}

// src/cli/auth.ts
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve4) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve4(answer.trim());
    });
  });
}
async function authCommand(action, provider) {
  if (action === "list") {
    const creds = await listCredentials();
    if (creds.length === 0) {
      console.log(chalk2.yellow("No credentials configured. Run `forgectl auth add <provider>`."));
      return;
    }
    console.log(chalk2.bold("\nConfigured credentials:\n"));
    for (const { provider: p, key } of creds) {
      console.log(`  ${chalk2.green("\u2714")} ${p} (${key})`);
    }
    console.log();
    return;
  }
  if (action === "add") {
    if (provider === "claude-code") {
      const existing = await getClaudeAuth();
      if (existing?.type === "oauth_session") {
        console.log(chalk2.green("\u2714 Found existing Claude Code OAuth session at ~/.claude/"));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your Anthropic API key: ");
      if (!key.startsWith("sk-ant-")) {
        console.log(chalk2.yellow("Warning: Key doesn't look like an Anthropic API key (expected sk-ant-...)"));
      }
      await setClaudeApiKey(key);
      console.log(chalk2.green("\u2714 Claude Code API key saved."));
    } else if (provider === "codex") {
      const key = await prompt("Enter your OpenAI API key: ");
      await setCodexApiKey(key);
      console.log(chalk2.green("\u2714 Codex (OpenAI) API key saved."));
    } else {
      console.error(chalk2.red(`Unknown provider: ${provider}. Use: claude-code | codex`));
      process.exit(1);
    }
    return;
  }
  if (action === "remove") {
    if (!provider) {
      console.error("Provider required.");
      process.exit(1);
    }
    await deleteCredential(provider, "api_key");
    console.log(chalk2.green(`\u2714 Removed credentials for ${provider}.`));
    return;
  }
}

// src/cli/init.ts
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, existsSync as existsSync5 } from "fs";
import { join as join5 } from "path";
import chalk3 from "chalk";
var STARTER_CONFIGS = {
  node: `# forgectl config \u2014 Node.js project
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
  python: `# forgectl config \u2014 Python project
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
  go: `# forgectl config \u2014 Go project
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
  research: `# forgectl config \u2014 Research workflow
agent:
  type: claude-code

orchestration:
  mode: review

output:
  dir: ./research-output
`,
  data: `# forgectl config \u2014 Data workflow
agent:
  type: claude-code

output:
  dir: ./data-output
`,
  ops: `# forgectl config \u2014 Ops/Infrastructure workflow
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
`
};
async function initCommand(options) {
  const configDir = join5(process.cwd(), ".forgectl");
  const configPath = join5(configDir, "config.yaml");
  if (existsSync5(configPath)) {
    console.log(chalk3.yellow(`Config already exists at ${configPath}`));
    return;
  }
  mkdirSync2(configDir, { recursive: true });
  const stack = options.stack || "node";
  const content = STARTER_CONFIGS[stack] || STARTER_CONFIGS.node;
  writeFileSync2(configPath, content);
  console.log(chalk3.green(`\u2714 Created ${configPath} (stack: ${stack})`));
  console.log(`
Next steps:`);
  console.log(`  1. Edit .forgectl/config.yaml to match your project`);
  console.log(`  2. Run: forgectl auth add claude-code`);
  console.log(`  3. Run: forgectl run --task "your task" --dry-run`);
}

// src/cli/workflows.ts
import chalk4 from "chalk";
import yaml3 from "js-yaml";
function workflowsCommand(action, name) {
  if (action === "list") {
    const workflows2 = listWorkflows();
    console.log(chalk4.bold("\nAvailable workflows:\n"));
    for (const w of workflows2) {
      console.log(`  ${chalk4.cyan(w.name.padEnd(12))} ${w.description}`);
    }
    console.log(`
Use ${chalk4.cyan("forgectl workflows show <name>")} to see full definition.
`);
    return;
  }
  if (action === "show" && name) {
    const workflow = getWorkflow(name);
    console.log(chalk4.bold(`
Workflow: ${workflow.name}
`));
    console.log(yaml3.dump(workflow, { lineWidth: 120, noRefs: true }));
    return;
  }
}

// src/index.ts
var program = new Command();
program.name("forgectl").description("Run AI agents in isolated Docker containers for any workflow").version("0.1.0");
program.command("run").description("Run a task synchronously").requiredOption("-t, --task <string>", "Task prompt").option("-w, --workflow <string>", "Workflow type").option("-r, --repo <path>", "Repository path").option("-i, --input <paths...>", "Input files/directories").option("--context <paths...>", "Context files for agent prompt").option("-a, --agent <string>", "Agent type: claude-code | codex").option("-m, --model <string>", "Model override").option("-c, --config <path>", "Config file path").option("--review", "Enable review mode").option("--no-review", "Disable review mode").option("-o, --output-dir <path>", "Output directory for file mode").option("--timeout <duration>", "Timeout override (e.g. 30m)").option("--verbose", "Show full agent output").option("--no-cleanup", "Leave container running after run").option("--dry-run", "Show run plan without executing").action(runCommand);
var auth = program.command("auth").description("Manage BYOK credentials");
auth.command("add <provider>").description("Add credentials (claude-code | codex)").action(async (provider) => {
  await authCommand("add", provider);
});
auth.command("list").description("List configured credentials").action(async () => {
  await authCommand("list");
});
auth.command("remove <provider>").description("Remove credentials").action(async (provider) => {
  await authCommand("remove", provider);
});
program.command("init").description("Generate starter config").option("--stack <string>", "Stack template: node|python|go|research|data|ops").action(initCommand);
var workflows = program.command("workflows").description("Manage workflows");
workflows.command("list").description("List available workflows").action(() => {
  workflowsCommand("list");
});
workflows.command("show <name>").description("Show workflow definition").action((name) => {
  workflowsCommand("show", name);
});
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
//# sourceMappingURL=index.js.map