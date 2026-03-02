#!/usr/bin/env node
import {
  WorkflowSchema,
  deepMerge
} from "./chunk-DMQRMT43.js";
import {
  getCodexAuth,
  getCredential,
  setCredential
} from "./chunk-OH6J5HYU.js";

// src/workflow/resolver.ts
import { randomBytes } from "crypto";
import { resolve as resolve2 } from "path";
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
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
function loadCustomWorkflows(projectDir) {
  const dir = resolve(projectDir || process.cwd(), ".forgectl", "workflows");
  if (!existsSync(dir)) return {};
  const result = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = readFileSync(join(dir, file), "utf-8");
    const parsed = yaml.load(raw);
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
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
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
    inputSources.push(resolve2(options.repo || "."));
  }
  if (options.input) {
    inputSources.push(...options.input.map((p) => resolve2(p)));
  }
  const reviewEnabled = options.review === true ? true : options.review === false ? false : workflow.review.enabled;
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
      sources: inputSources.length > 0 ? inputSources : [resolve2(".")],
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
      hostDir: resolve2(options.outputDir ?? config.output.dir, runId)
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

// src/agent/claude-code.ts
var claudeCodeAdapter = {
  name: "claude-code",
  buildShellCommand(promptFile, options) {
    let cmd = `cat "${promptFile}" | claude -p - --output-format text`;
    if (options.maxTurns > 0) {
      cmd += ` --max-turns ${options.maxTurns}`;
    }
    if (options.model) {
      cmd += ` --model ${shellEscape(options.model)}`;
    }
    for (const flag of options.flags) {
      cmd += ` ${shellEscape(flag)}`;
    }
    return cmd;
  }
};
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// src/agent/codex.ts
var codexAdapter = {
  name: "codex",
  buildShellCommand(promptFile, options) {
    let cmd = `codex exec --yolo --skip-git-repo-check`;
    if (options.model) {
      cmd += ` --model ${shellEscape2(options.model)}`;
    }
    for (const flag of options.flags) {
      cmd += ` ${shellEscape2(flag)}`;
    }
    cmd += ` "$(cat "${promptFile}")"`;
    return cmd;
  }
};
function shellEscape2(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// src/agent/registry.ts
var ADAPTERS = {
  "claude-code": claudeCodeAdapter,
  "codex": codexAdapter
};
function getAgentAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}

// src/container/runner.ts
import Docker from "dockerode";
var docker = new Docker();
async function createContainer(plan, binds) {
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
      CapAdd: plan.container.network.mode === "allowlist" ? ["NET_ADMIN"] : []
    },
    Tty: false,
    OpenStdin: false
  });
  await container.start();
  return container;
}
async function execInContainer(container, cmd, options) {
  const start = Date.now();
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Env: options?.env,
    User: options?.user,
    WorkingDir: options?.workingDir
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve5, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    docker.modem.demuxStream(
      stream,
      { write: (chunk) => stdoutChunks.push(chunk) },
      { write: (chunk) => stderrChunks.push(chunk) }
    );
    let timeoutHandle;
    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
    stream.on("end", async () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const inspection = await exec.inspect();
      resolve5({
        exitCode: inspection.ExitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        durationMs: Date.now() - start
      });
    });
    stream.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}
async function destroyContainer(container) {
  try {
    await container.stop({ t: 5 });
  } catch {
  }
  try {
    await container.remove({ force: true });
  } catch {
  }
}
function parseMemory(mem) {
  const match = mem.match(/^(\d+)(g|m)$/i);
  if (!match) return 4 * 1024 * 1024 * 1024;
  const val = parseInt(match[1], 10);
  return match[2].toLowerCase() === "g" ? val * 1024 ** 3 : val * 1024 ** 2;
}

// src/agent/invoke.ts
var PROMPT_DIR = "/tmp/forgectl";
async function invokeAgent(container, adapter, prompt, options, env, promptId = "prompt") {
  const promptFile = `${PROMPT_DIR}/${promptId}.txt`;
  await execInContainer(container, ["mkdir", "-p", PROMPT_DIR], {
    workingDir: options.workingDir
  });
  const b64 = Buffer.from(prompt, "utf-8").toString("base64");
  const CHUNK_SIZE = 65536;
  for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
    const chunk = b64.slice(i, i + CHUNK_SIZE);
    const op = i === 0 ? ">" : ">>";
    await execInContainer(container, [
      "sh",
      "-c",
      `printf '%s' '${chunk}' ${op} "${promptFile}.b64"`
    ], { workingDir: options.workingDir });
  }
  await execInContainer(container, [
    "sh",
    "-c",
    `base64 -d "${promptFile}.b64" > "${promptFile}" && rm "${promptFile}.b64"`
  ], { workingDir: options.workingDir });
  const shellCmd = adapter.buildShellCommand(promptFile, options);
  return execInContainer(container, ["sh", "-c", shellCmd], {
    env,
    workingDir: options.workingDir,
    timeout: options.timeout
  });
}

// src/context/prompt.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { resolve as resolve3, basename } from "path";
function buildPrompt(plan) {
  const parts = [];
  parts.push(plan.context.system || plan.workflow.system);
  for (const file of plan.context.files) {
    const absPath = resolve3(file);
    if (existsSync2(absPath)) {
      const content = readFileSync2(absPath, "utf-8");
      parts.push(`
--- Context: ${basename(file)} ---
${content}
`);
    }
  }
  if (plan.workflow.tools.length > 0) {
    parts.push(`
Available tools in this container: ${plan.workflow.tools.join(", ")}
`);
  }
  parts.push(`
--- Task ---
${plan.task}
`);
  if (plan.validation.steps.length > 0) {
    parts.push(`
After you finish, these validation checks will run:`);
    for (const step of plan.validation.steps) {
      parts.push(`- ${step.name}: \`${step.command}\` \u2014 ${step.description}`);
    }
    parts.push(`
If any check fails, you'll receive the error output and must fix it.
`);
  }
  if (plan.output.mode === "files") {
    parts.push(`
Save all output files to ${plan.output.path}
`);
  }
  return parts.join("\n");
}

// src/container/builder.ts
import Docker2 from "dockerode";
var docker2 = new Docker2();
async function imageExists(imageName) {
  try {
    await docker2.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}
async function pullImage(imageName) {
  return new Promise((resolve5, reject) => {
    docker2.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker2.modem.followProgress(stream, (err2) => {
        if (err2) return reject(err2);
        resolve5();
      });
    });
  });
}
async function buildImage(dockerfilePath, contextPath, tag) {
  const stream = await docker2.buildImage(
    { context: contextPath, src: [dockerfilePath] },
    { t: tag, dockerfile: dockerfilePath }
  );
  return new Promise((resolve5, reject) => {
    docker2.modem.followProgress(stream, (err) => {
      if (err) return reject(err);
      resolve5();
    });
  });
}
async function ensureImage(imageName, dockerfilePath, contextPath) {
  if (dockerfilePath && contextPath) {
    const tag = `forgectl-custom:latest`;
    await buildImage(dockerfilePath, contextPath, tag);
    return tag;
  }
  const name = imageName || "forgectl/code-node20";
  if (!await imageExists(name)) {
    await pullImage(name);
  }
  return name;
}

// src/container/workspace.ts
import { execSync as execSync2 } from "child_process";
import { mkdirSync, cpSync, existsSync as existsSync3 } from "fs";
import { join as join2, resolve as resolve4, basename as basename2 } from "path";
import { tmpdir } from "os";
import { randomBytes as randomBytes2 } from "crypto";
import picomatch from "picomatch";
function prepareRepoWorkspace(repoPath, exclude) {
  const tmpDir = join2(tmpdir(), `forgectl-workspace-${randomBytes2(4).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });
  const isExcluded = picomatch(exclude);
  try {
    const excludeFlags = exclude.map((e) => `--exclude='${e}'`).join(" ");
    execSync2(`rsync -a ${excludeFlags} '${resolve4(repoPath)}/' '${tmpDir}/'`, { stdio: "ignore" });
  } catch {
    cpSync(resolve4(repoPath), tmpDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(resolve4(repoPath), "").replace(/^\//, "");
        if (rel === "") return true;
        return !isExcluded(rel);
      }
    });
  }
  return tmpDir;
}
function prepareFilesWorkspace(inputPaths) {
  const base = join2(tmpdir(), `forgectl-files-${randomBytes2(4).toString("hex")}`);
  const inputDir = join2(base, "input");
  const outputDir = join2(base, "output");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  for (const p of inputPaths) {
    const resolved = resolve4(p);
    if (!existsSync3(resolved)) throw new Error(`Input file not found: ${p}`);
    cpSync(resolved, join2(inputDir, basename2(resolved)), { recursive: true });
  }
  return { inputDir, outputDir };
}

// src/container/network.ts
import Docker3 from "dockerode";
var docker3 = new Docker3();
async function createIsolatedNetwork(name) {
  return docker3.createNetwork({
    Name: name,
    Driver: "bridge",
    Internal: false
  });
}
async function applyFirewall(container, allowedDomains) {
  const domainsStr = allowedDomains.join(",");
  await execInContainer(container, [
    "/bin/bash",
    "/usr/local/bin/init-firewall.sh"
  ], {
    env: [`FORGECTL_ALLOWED_DOMAINS=${domainsStr}`],
    user: "root"
  });
}
async function removeNetwork(name) {
  try {
    const network = docker3.getNetwork(name);
    await network.remove();
  } catch {
  }
}

// src/auth/claude.ts
import { existsSync as existsSync4 } from "fs";
import { join as join3 } from "path";
var PROVIDER = "claude-code";
async function getClaudeAuth() {
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeDir = join3(home, ".claude");
  if (existsSync4(claudeDir)) return { type: "oauth_session", sessionDir: claudeDir };
  return null;
}
async function setClaudeApiKey(key) {
  await setCredential(PROVIDER, "api_key", key);
}

// src/auth/mount.ts
import { writeFileSync, readFileSync as readFileSync3, mkdirSync as mkdirSync2, rmSync, existsSync as existsSync5 } from "fs";
import { join as join4 } from "path";
import { tmpdir as tmpdir2 } from "os";
import { randomBytes as randomBytes3 } from "crypto";
function prepareClaudeMounts(auth, runId) {
  const secretsDir = join4(tmpdir2(), `forgectl-secrets-${runId}-${randomBytes3(4).toString("hex")}`);
  mkdirSync2(secretsDir, { recursive: true, mode: 448 });
  const binds = [];
  const env = {};
  if (auth.type === "api_key" && auth.apiKey) {
    const keyPath = join4(secretsDir, "anthropic_api_key");
    writeFileSync(keyPath, auth.apiKey, { mode: 256 });
    binds.push(`${secretsDir}:/run/secrets:ro`);
    env.ANTHROPIC_API_KEY_FILE = "/run/secrets/anthropic_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    binds.push(`${auth.sessionDir}:/home/node/.claude:ro`);
  }
  return {
    binds,
    env,
    cleanup: () => {
      try {
        rmSync(secretsDir, { recursive: true, force: true });
      } catch {
      }
    }
  };
}
function prepareCodexMounts(auth, runId) {
  const secretsDir = join4(tmpdir2(), `forgectl-secrets-${runId}-${randomBytes3(4).toString("hex")}`);
  mkdirSync2(secretsDir, { recursive: true, mode: 448 });
  const binds = [];
  const env = {};
  if (auth.type === "api_key" && auth.apiKey) {
    const keyPath = join4(secretsDir, "openai_api_key");
    writeFileSync(keyPath, auth.apiKey, { mode: 256 });
    binds.push(`${secretsDir}:/run/secrets:ro`);
    env.OPENAI_API_KEY_FILE = "/run/secrets/openai_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    const codexHome = join4(secretsDir, "codex-home");
    mkdirSync2(codexHome, { recursive: true, mode: 448 });
    const authJson = readFileSync3(join4(auth.sessionDir, "auth.json"), "utf-8");
    writeFileSync(join4(codexHome, "auth.json"), authJson, { mode: 384 });
    const configPath = join4(auth.sessionDir, "config.toml");
    if (existsSync5(configPath)) {
      const configToml = readFileSync3(configPath, "utf-8");
      writeFileSync(join4(codexHome, "config.toml"), configToml, { mode: 384 });
    }
    binds.push(`${codexHome}:/home/node/.codex`);
    env.CODEX_HOME = "/home/node/.codex";
  }
  return {
    binds,
    env,
    cleanup: () => {
      try {
        rmSync(secretsDir, { recursive: true, force: true });
      } catch {
      }
    }
  };
}

// src/validation/step.ts
async function runValidationStep(container, step, workingDir) {
  const timeout = step.timeout ? parseDuration(step.timeout) : 6e4;
  const result = await execInContainer(
    container,
    ["sh", "-c", step.command],
    { workingDir, timeout }
  );
  return {
    step,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs
  };
}

// src/validation/feedback.ts
var WORKFLOW_INSTRUCTIONS = {
  code: "Fix the code issues. Do NOT weaken linting rules or delete tests.",
  research: "Fix the report. Ensure sources are cited with URLs and claims are supported.",
  content: "Revise the content. Address the style and quality issues.",
  data: "Fix the data pipeline. Ensure output matches expected schema and no PII is present.",
  ops: "Fix the infrastructure code. Ensure it passes validation/dry-run.",
  general: "Fix the issues identified above."
};
function formatFeedback(failedSteps, workflowName) {
  const parts = [
    "VALIDATION FAILED. The following checks did not pass:\n"
  ];
  for (const { step, exitCode, stdout, stderr } of failedSteps) {
    parts.push(`--- ${step.name} (exit code ${exitCode}) ---`);
    parts.push(`Command: ${step.command}`);
    if (stdout.trim()) {
      parts.push(`STDOUT:
${truncate(stdout, 3e3)}`);
    }
    if (stderr.trim()) {
      parts.push(`STDERR:
${truncate(stderr, 3e3)}`);
    }
    parts.push("");
  }
  const instruction = WORKFLOW_INSTRUCTIONS[workflowName] || WORKFLOW_INSTRUCTIONS.general;
  parts.push(instruction);
  parts.push("\nFix the issues and the checks will run again.");
  return parts.join("\n");
}
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + "\n\n... (truncated) ...\n\n" + text.slice(-half);
}

// src/validation/runner.ts
async function runValidationLoop(container, plan, adapter, agentOptions, agentEnv, logger) {
  const steps = plan.validation.steps;
  if (steps.length === 0) {
    logger.info("validation", "No validation steps configured");
    return { passed: true, totalAttempts: 0, stepResults: [] };
  }
  const maxRetries = Math.max(...steps.map((s) => s.retries));
  const stepAttemptCounts = {};
  const stepLastPassed = {};
  for (const step of steps) {
    stepAttemptCounts[step.name] = 0;
    stepLastPassed[step.name] = false;
  }
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    logger.info("validation", `Validation round ${attempt}/${maxRetries + 1}`);
    const results = [];
    let allPassed = true;
    for (const step of steps) {
      logger.debug("validation", `Running: ${step.name} \u2014 ${step.command}`);
      const result = await runValidationStep(container, step, plan.input.mountPath);
      results.push(result);
      stepAttemptCounts[step.name]++;
      stepLastPassed[step.name] = result.passed;
      if (result.passed) {
        logger.info("validation", `\u2714 ${step.name} passed (${result.durationMs}ms)`);
      } else {
        logger.warn("validation", `\u2717 ${step.name} failed (exit ${result.exitCode})`);
        allPassed = false;
      }
    }
    if (allPassed) {
      logger.info("validation", "All validation steps passed");
      return {
        passed: true,
        totalAttempts: attempt,
        stepResults: steps.map((s) => ({
          name: s.name,
          passed: true,
          attempts: stepAttemptCounts[s.name]
        }))
      };
    }
    if (attempt > maxRetries) {
      break;
    }
    const failedSteps = results.filter((r) => !r.passed);
    const feedback = formatFeedback(failedSteps, plan.workflow.name);
    logger.info("validation", `${failedSteps.length} step(s) failed, sending feedback to agent`);
    logger.info("agent", "Agent fixing validation failures...");
    const fixResult = await invokeAgent(
      container,
      adapter,
      feedback,
      agentOptions,
      agentEnv,
      `fix-${attempt}`
    );
    if (fixResult.exitCode !== 0) {
      logger.warn("agent", `Agent fix attempt exited with code ${fixResult.exitCode}`);
    }
  }
  logger.error("validation", `Validation failed after ${attempt} attempts`);
  return {
    passed: false,
    totalAttempts: attempt,
    stepResults: steps.map((s) => ({
      name: s.name,
      passed: stepLastPassed[s.name],
      attempts: stepAttemptCounts[s.name]
    }))
  };
}

// src/output/git.ts
import { execSync as execSync3 } from "child_process";
import { spawn } from "child_process";
import { mkdtempSync, rmSync as rmSync2 } from "fs";
import { join as join5 } from "path";
import { tmpdir as tmpdir3 } from "os";

// src/utils/template.ts
function expandTemplate(template, vars) {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
    const parts = key.split(".");
    let value = vars;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return match;
      value = value[part];
    }
    return value != null ? String(value) : match;
  });
}

// src/utils/slug.ts
function slugify(text, maxLength = 50) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, maxLength);
}

// src/output/git.ts
async function collectGitOutput(container, plan, logger) {
  const slug = slugify(plan.task);
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T.]/g, "").slice(0, 15);
  const branch = expandTemplate("forge/{{slug}}/{{ts}}", { slug, ts });
  logger.info("output", `Creating branch: ${branch}`);
  await execInContainer(container, [
    "git",
    "config",
    "--global",
    "--add",
    "safe.directory",
    "/workspace"
  ], { workingDir: "/workspace" });
  await execInContainer(container, [
    "git",
    "config",
    "user.name",
    plan.commit.author.name
  ], { workingDir: "/workspace" });
  await execInContainer(container, [
    "git",
    "config",
    "user.email",
    plan.commit.author.email
  ], { workingDir: "/workspace" });
  const initialResult = await execInContainer(container, [
    "git",
    "rev-list",
    "--max-parents=0",
    "HEAD"
  ], { workingDir: "/workspace" });
  const initialSha = initialResult.stdout.trim().split("\n")[0];
  const logResult = await execInContainer(container, [
    "git",
    "log",
    "--oneline",
    `${initialSha}..HEAD`
  ], { workingDir: "/workspace" });
  const hasAgentCommits = logResult.stdout.trim().length > 0;
  await execInContainer(container, ["git", "add", "-A"], {
    workingDir: "/workspace"
  });
  const diffResult = await execInContainer(container, [
    "git",
    "diff",
    "--cached",
    "--stat"
  ], { workingDir: "/workspace" });
  const hasUnstagedChanges = diffResult.stdout.trim().length > 0;
  if (!hasAgentCommits && !hasUnstagedChanges) {
    logger.warn("output", "No changes detected in workspace");
    return { mode: "git", branch, sha: "", filesChanged: 0, insertions: 0, deletions: 0 };
  }
  if (hasUnstagedChanges) {
    const commitMsg = expandTemplate(plan.commit.message.template, {
      prefix: plan.commit.message.prefix,
      summary: plan.task.slice(0, 72)
    });
    await execInContainer(container, ["git", "commit", "-m", commitMsg], {
      workingDir: "/workspace"
    });
  }
  await execInContainer(container, ["git", "checkout", "-b", branch], {
    workingDir: "/workspace"
  });
  const shaResult = await execInContainer(container, ["git", "rev-parse", "HEAD"], {
    workingDir: "/workspace"
  });
  const sha = shaResult.stdout.trim();
  const statResult = await execInContainer(container, [
    "git",
    "diff",
    "--stat",
    `${initialSha}..HEAD`
  ], { workingDir: "/workspace" });
  const statLine = statResult.stdout.trim().split("\n").pop() || "";
  const filesChanged = parseInt(statLine.match(/(\d+) file/)?.[1] || "0", 10);
  const insertions = parseInt(statLine.match(/(\d+) insertion/)?.[1] || "0", 10);
  const deletions = parseInt(statLine.match(/(\d+) deletion/)?.[1] || "0", 10);
  const tmpGit = mkdtempSync(join5(tmpdir3(), "forgectl-git-"));
  try {
    const archive = await container.getArchive({ path: "/workspace/.git" });
    await new Promise((resolve5, reject) => {
      const extract = spawn("tar", ["xf", "-", "-C", tmpGit]);
      archive.pipe(extract.stdin);
      extract.on("close", (code) => code === 0 ? resolve5() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });
    const hostRepo = plan.input.sources[0];
    execSync3(`git fetch "${tmpGit}" "${branch}:${branch}"`, {
      cwd: hostRepo,
      stdio: "pipe"
    });
    logger.info("output", `Branch ${branch} fetched to host repo at ${hostRepo}`);
  } finally {
    rmSync2(tmpGit, { recursive: true, force: true });
  }
  return {
    mode: "git",
    branch,
    sha,
    filesChanged,
    insertions,
    deletions
  };
}

// src/output/files.ts
import { spawn as spawn2 } from "child_process";
import { execSync as execSync4 } from "child_process";
import { mkdirSync as mkdirSync3, statSync, readdirSync as readdirSync2, mkdtempSync as mkdtempSync2, rmSync as rmSync3 } from "fs";
import { join as join6 } from "path";
import { tmpdir as tmpdir4 } from "os";
async function collectFileOutput(container, plan, logger) {
  const outputDir = plan.output.hostDir;
  mkdirSync3(outputDir, { recursive: true });
  logger.info("output", `Collecting files from container ${plan.output.path} \u2192 ${outputDir}`);
  let archive;
  try {
    archive = await container.getArchive({ path: plan.output.path });
  } catch {
    logger.warn("output", `Output path ${plan.output.path} not found in container`);
    return { mode: "files", dir: outputDir, files: [], totalSize: 0 };
  }
  const tmpDir = mkdtempSync2(join6(tmpdir4(), "forgectl-output-"));
  try {
    await new Promise((resolve5, reject) => {
      const extract = spawn2("tar", ["xf", "-", "-C", tmpDir]);
      archive.pipe(extract.stdin);
      extract.on("close", (code) => code === 0 ? resolve5() : reject(new Error(`tar exit ${code}`)));
      extract.on("error", reject);
    });
    const containerPathBase = plan.output.path.split("/").filter(Boolean).pop() || "output";
    const extractedDir = join6(tmpDir, containerPathBase);
    try {
      execSync4(`cp -r "${extractedDir}/." "${outputDir}/"`, { stdio: "pipe" });
    } catch {
      execSync4(`cp -r "${tmpDir}/." "${outputDir}/"`, { stdio: "pipe" });
    }
  } finally {
    rmSync3(tmpDir, { recursive: true, force: true });
  }
  const files = listFilesRecursive(outputDir);
  const totalSize = files.reduce((sum, f) => {
    try {
      return sum + statSync(join6(outputDir, f)).size;
    } catch {
      return sum;
    }
  }, 0);
  logger.info("output", `Collected ${files.length} files (${formatBytes(totalSize)})`);
  return {
    mode: "files",
    dir: outputDir,
    files,
    totalSize
  };
}
function listFilesRecursive(dir, prefix = "") {
  const files = [];
  try {
    for (const entry of readdirSync2(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(join6(dir, entry.name), rel));
      } else {
        files.push(rel);
      }
    }
  } catch {
  }
  return files;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// src/output/collector.ts
async function collectOutput(container, plan, logger) {
  if (plan.output.mode === "git") {
    return collectGitOutput(container, plan, logger);
  }
  return collectFileOutput(container, plan, logger);
}

// src/container/cleanup.ts
import { rmSync as rmSync4 } from "fs";
async function cleanupRun(ctx) {
  if (ctx.container) {
    await destroyContainer(ctx.container);
  }
  if (ctx.networkName) {
    await removeNetwork(ctx.networkName);
  }
  for (const dir of ctx.tempDirs) {
    try {
      rmSync4(dir, { recursive: true, force: true });
    } catch {
    }
  }
  for (const fn of ctx.secretCleanups) {
    try {
      fn();
    } catch {
    }
  }
}

// src/utils/timer.ts
var Timer = class {
  startTime;
  constructor() {
    this.startTime = Date.now();
  }
  elapsed() {
    return Date.now() - this.startTime;
  }
  reset() {
    this.startTime = Date.now();
  }
};

// src/logging/events.ts
import { EventEmitter } from "events";
var runEvents = new EventEmitter();
function emitRunEvent(event) {
  runEvents.emit("run", event);
  runEvents.emit(`run:${event.runId}`, event);
}

// src/orchestration/single.ts
async function prepareExecution(plan, logger, cleanup) {
  emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "prepare" } });
  logger.info("prepare", `Ensuring image: ${plan.container.image}`);
  const resolvedImage = await ensureImage(plan.container.image, plan.container.dockerfile);
  const binds = [];
  if (plan.input.mode === "repo") {
    logger.info("prepare", "Preparing repo workspace...");
    const workspaceDir = prepareRepoWorkspace(plan.input.sources[0], plan.input.exclude);
    cleanup.tempDirs.push(workspaceDir);
    binds.push(`${workspaceDir}:${plan.input.mountPath}`);
  } else {
    logger.info("prepare", "Preparing file workspace...");
    const { inputDir, outputDir } = prepareFilesWorkspace(plan.input.sources);
    cleanup.tempDirs.push(inputDir, outputDir);
    binds.push(`${inputDir}:${plan.input.mountPath}:ro`);
    binds.push(`${outputDir}:${plan.output.path}`);
  }
  const agentEnv = [];
  if (plan.agent.type === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) throw new Error("No Claude Code credentials configured");
    const mounts = prepareClaudeMounts(auth, plan.runId);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`ANTHROPIC_API_KEY=${auth.apiKey}`);
    }
    agentEnv.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  } else {
    const auth = await getCodexAuth();
    if (!auth) throw new Error("No Codex credentials configured. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    const mounts = prepareCodexMounts(auth, plan.runId);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
    }
    if (mounts.env.CODEX_HOME) {
      agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
    }
  }
  if (plan.container.network.mode === "allowlist") {
    logger.info("prepare", "Creating isolated network...");
    await createIsolatedNetwork(plan.container.network.dockerNetwork);
    cleanup.networkName = plan.container.network.dockerNetwork;
  }
  logger.info("prepare", "Starting container...");
  const resolvedPlan = { ...plan, container: { ...plan.container, image: resolvedImage } };
  const container = await createContainer(resolvedPlan, binds);
  cleanup.container = container;
  if (plan.container.network.mode === "allowlist" && plan.container.network.allow) {
    logger.info("prepare", "Applying network firewall...");
    await applyFirewall(container, plan.container.network.allow);
  }
  const adapter = getAgentAdapter(plan.agent.type);
  const agentOptions = {
    model: plan.agent.model,
    maxTurns: plan.agent.maxTurns,
    timeout: plan.agent.timeout,
    flags: plan.agent.flags,
    workingDir: plan.input.mountPath
  };
  return { container, adapter, agentOptions, agentEnv, resolvedImage };
}
async function executeSingleAgent(plan, logger, noCleanup = false) {
  const timer = new Timer();
  const cleanup = { tempDirs: [], secretCleanups: [] };
  try {
    const { container, adapter, agentOptions, agentEnv } = await prepareExecution(plan, logger, cleanup);
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "execute" } });
    const prompt = buildPrompt(plan);
    logger.info("agent", `Running ${plan.agent.type}...`);
    const agentResult = await invokeAgent(
      container,
      adapter,
      prompt,
      agentOptions,
      agentEnv
    );
    logger.info("agent", `Agent finished (exit ${agentResult.exitCode}, ${agentResult.durationMs}ms)`);
    if (agentResult.stdout) logger.info("agent", `STDOUT: ${agentResult.stdout.slice(0, 2e3)}`);
    if (agentResult.stderr) logger.info("agent", `STDERR: ${agentResult.stderr.slice(0, 2e3)}`);
    if (agentResult.exitCode !== 0) {
      logger.warn("agent", `Agent exited with non-zero code: ${agentResult.exitCode}`);
      if (agentResult.stderr) {
        logger.debug("agent", `stderr: ${agentResult.stderr.slice(0, 500)}`);
      }
    }
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "validate" } });
    logger.info("validate", `Running ${plan.validation.steps.length} validation steps...`);
    const validationResult = await runValidationLoop(
      container,
      plan,
      adapter,
      agentOptions,
      agentEnv,
      logger
    );
    if (validationResult.passed || plan.validation.onFailure === "output-wip") {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "output" } });
      logger.info("output", `Collecting ${plan.output.mode} output...`);
      const output = await collectOutput(container, plan, logger);
      emitRunEvent({
        runId: plan.runId,
        type: "completed",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: { success: true, output }
      });
      return {
        success: validationResult.passed,
        output,
        validation: validationResult,
        durationMs: timer.elapsed()
      };
    }
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: { reason: "validation_failed" }
    });
    return {
      success: false,
      validation: validationResult,
      durationMs: timer.elapsed(),
      error: "Validation failed and on_failure is set to 'abandon'"
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("execution", message);
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: { error: message }
    });
    return {
      success: false,
      validation: { passed: false, totalAttempts: 0, stepResults: [] },
      durationMs: timer.elapsed(),
      error: message
    };
  } finally {
    if (!noCleanup) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup)");
    }
  }
}

// src/orchestration/review.ts
function buildReviewPrompt(plan, round) {
  const parts = [];
  parts.push(plan.orchestration.review.system);
  parts.push(`
--- Original Task ---
${plan.task}
`);
  if (plan.output.mode === "git") {
    parts.push(`The implementer's changes are in this workspace. Run \`git diff HEAD~1\` to see the changes.`);
  } else {
    parts.push(`The implementer's output files are in ${plan.output.path}. Review their contents.`);
  }
  parts.push(`
This is review round ${round}. If the output is acceptable, respond with exactly: LGTM`);
  parts.push(`If there are issues, list them numbered. Be specific and actionable.`);
  return parts.join("\n");
}
function parseReviewResult(stdout) {
  const trimmed = stdout.trim();
  const lastLines = trimmed.split("\n").slice(-5).join("\n").trim();
  const approved = /\b(LGTM|APPROVED)\b/i.test(lastLines);
  return {
    approved,
    feedback: approved ? "" : trimmed
  };
}
function buildFixPrompt(reviewFeedback, round) {
  return [
    `REVIEW FEEDBACK (round ${round}):`,
    "",
    reviewFeedback,
    "",
    "Fix all issues listed above. The reviewer will check again after you're done."
  ].join("\n");
}
async function snapshotWorkspace(sourceContainer, targetContainer, sourcePath) {
  const archive = await sourceContainer.getArchive({ path: sourcePath });
  await targetContainer.putArchive(archive, { path: "/" });
}
async function prepareReviewerCredentials(agentType, runId, round, cleanup) {
  const binds = [];
  const agentEnv = [];
  if (agentType === "claude-code") {
    const auth = await getClaudeAuth();
    if (!auth) throw new Error("No Claude Code credentials configured for reviewer");
    const mounts = prepareClaudeMounts(auth, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`ANTHROPIC_API_KEY=${auth.apiKey}`);
    }
    agentEnv.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  } else {
    const auth = await getCodexAuth();
    if (!auth) throw new Error("No Codex credentials configured for reviewer. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    const mounts = prepareCodexMounts(auth, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
    }
    if (mounts.env.CODEX_HOME) {
      agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
    }
  }
  return { binds, agentEnv };
}
async function executeReviewMode(plan, logger, noCleanup = false) {
  const timer = new Timer();
  const cleanup = { tempDirs: [], secretCleanups: [] };
  const reviewerCleanup = { tempDirs: [], secretCleanups: [] };
  try {
    const { container, adapter, agentOptions, agentEnv, resolvedImage } = await prepareExecution(plan, logger, cleanup);
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "execute" } });
    const prompt = buildPrompt(plan);
    logger.info("agent", `Running ${plan.agent.type}...`);
    const agentResult = await invokeAgent(container, adapter, prompt, agentOptions, agentEnv);
    logger.info("agent", `Agent finished (exit ${agentResult.exitCode}, ${agentResult.durationMs}ms)`);
    if (agentResult.exitCode !== 0) {
      logger.warn("agent", `Agent exited with non-zero code: ${agentResult.exitCode}`);
      if (agentResult.stderr) {
        logger.debug("agent", `stderr: ${agentResult.stderr.slice(0, 500)}`);
      }
    }
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "validate" } });
    logger.info("validate", `Running ${plan.validation.steps.length} validation steps...`);
    let validationResult = await runValidationLoop(
      container,
      plan,
      adapter,
      agentOptions,
      agentEnv,
      logger
    );
    if (!validationResult.passed && plan.validation.onFailure === "abandon") {
      emitRunEvent({ runId: plan.runId, type: "failed", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { reason: "validation_failed" } });
      return {
        success: false,
        validation: validationResult,
        durationMs: timer.elapsed(),
        error: "Validation failed and on_failure is set to 'abandon'"
      };
    }
    emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "review" } });
    const maxRounds = plan.orchestration.review.maxRounds;
    const reviewAgent = plan.orchestration.review.agent;
    const reviewModel = plan.orchestration.review.model;
    const reviewAdapter = getAgentAdapter(reviewAgent);
    const resolvedPlan = { ...plan, container: { ...plan.container, image: resolvedImage } };
    const reviewOptions = {
      model: reviewModel,
      maxTurns: plan.agent.maxTurns,
      timeout: plan.agent.timeout,
      flags: plan.agent.flags,
      workingDir: plan.input.mountPath
    };
    let approvedOnRound;
    for (let round = 1; round <= maxRounds; round++) {
      logger.info("review", `Starting review round ${round}/${maxRounds}...`);
      const reviewerCreds = await prepareReviewerCredentials(
        reviewAgent,
        plan.runId,
        round,
        reviewerCleanup
      );
      logger.info("review", "Launching reviewer container...");
      const reviewerContainer = await createContainer(resolvedPlan, reviewerCreds.binds);
      reviewerCleanup.container = reviewerContainer;
      await snapshotWorkspace(container, reviewerContainer, plan.input.mountPath);
      const reviewPrompt = buildReviewPrompt(plan, round);
      logger.info("review", "Reviewer running...");
      const reviewExecResult = await invokeAgent(
        reviewerContainer,
        reviewAdapter,
        reviewPrompt,
        reviewOptions,
        reviewerCreds.agentEnv,
        `review-${round}`
      );
      const parsed = parseReviewResult(reviewExecResult.stdout);
      await destroyContainer(reviewerContainer);
      reviewerCleanup.container = void 0;
      if (parsed.approved) {
        logger.info("review", `\u2714 Review round ${round}: APPROVED`);
        approvedOnRound = round;
        break;
      }
      logger.warn("review", `\u2717 Review round ${round}: issues found`);
      if (round < maxRounds) {
        logger.info("review", "Feeding issues to implementer...");
        const fixPrompt = buildFixPrompt(parsed.feedback, round);
        logger.info("agent", "Agent fixing review issues...");
        await invokeAgent(
          container,
          adapter,
          fixPrompt,
          agentOptions,
          agentEnv,
          `review-fix-${round}`
        );
        if (plan.validation.steps.length > 0) {
          logger.info("validate", "Re-validating after review fix...");
          validationResult = await runValidationLoop(
            container,
            plan,
            adapter,
            agentOptions,
            agentEnv,
            logger
          );
          if (!validationResult.passed && plan.validation.onFailure === "abandon") {
            emitRunEvent({
              runId: plan.runId,
              type: "failed",
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              data: { reason: "validation_failed_during_review" }
            });
            return {
              success: false,
              validation: validationResult,
              durationMs: timer.elapsed(),
              error: "Validation failed during review fix cycle",
              review: { totalRounds: round, approved: false }
            };
          }
        }
      }
    }
    const approved = approvedOnRound !== void 0;
    if (approved || validationResult.passed || plan.validation.onFailure === "output-wip") {
      emitRunEvent({ runId: plan.runId, type: "phase", timestamp: (/* @__PURE__ */ new Date()).toISOString(), data: { phase: "output" } });
      logger.info("output", `Collecting ${plan.output.mode} output...`);
      const output = await collectOutput(container, plan, logger);
      emitRunEvent({
        runId: plan.runId,
        type: "completed",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: { success: approved, output }
      });
      return {
        success: approved,
        output,
        validation: validationResult,
        durationMs: timer.elapsed(),
        review: {
          totalRounds: approvedOnRound ?? maxRounds,
          approved,
          approvedOnRound
        }
      };
    }
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: { reason: "review_not_approved" }
    });
    return {
      success: false,
      validation: validationResult,
      durationMs: timer.elapsed(),
      error: `Review not approved after ${maxRounds} rounds`,
      review: { totalRounds: maxRounds, approved: false }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("execution", message);
    emitRunEvent({
      runId: plan.runId,
      type: "failed",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: { error: message }
    });
    return {
      success: false,
      validation: { passed: false, totalAttempts: 0, stepResults: [] },
      durationMs: timer.elapsed(),
      error: message
    };
  } finally {
    await cleanupRun(reviewerCleanup);
    if (!noCleanup) {
      logger.info("cleanup", "Cleaning up...");
      await cleanupRun(cleanup);
    } else {
      logger.info("cleanup", "Skipping cleanup (--no-cleanup)");
    }
  }
}

// src/orchestration/modes.ts
async function executeRun(plan, logger, noCleanup = false) {
  switch (plan.orchestration.mode) {
    case "single":
      return executeSingleAgent(plan, logger, noCleanup);
    case "review":
      return executeReviewMode(plan, logger, noCleanup);
    case "parallel":
      logger.warn("orchestration", "Parallel mode not yet implemented, running as single agent");
      return executeSingleAgent(plan, logger, noCleanup);
    default:
      return executeSingleAgent(plan, logger, noCleanup);
  }
}

// src/logging/logger.ts
import chalk from "chalk";
var Logger = class {
  entries = [];
  verbose;
  listeners = [];
  constructor(verbose = false) {
    this.verbose = verbose;
  }
  emit(level, phase, message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      phase,
      message,
      data
    };
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
  }
  debug(phase, message, data) {
    this.emit("debug", phase, message, data);
    if (this.verbose) console.log(chalk.gray(`  [${phase}] ${message}`));
  }
  info(phase, message, data) {
    this.emit("info", phase, message, data);
    console.log(chalk.cyan(`  [${phase}]`) + ` ${message}`);
  }
  warn(phase, message, data) {
    this.emit("warn", phase, message, data);
    console.log(chalk.yellow(`  \u26A0 [${phase}]`) + ` ${message}`);
  }
  error(phase, message, data) {
    this.emit("error", phase, message, data);
    console.error(chalk.red(`  \u2717 [${phase}]`) + ` ${message}`);
  }
  /** Subscribe to log events (for SSE streaming) */
  onEntry(fn) {
    this.listeners.push(fn);
  }
  /** Get all entries (for JSON run log) */
  getEntries() {
    return [...this.entries];
  }
};

// src/daemon/lifecycle.ts
import { writeFileSync as writeFileSync2, readFileSync as readFileSync4, existsSync as existsSync6, unlinkSync, mkdirSync as mkdirSync4 } from "fs";
import { join as join7 } from "path";
var FORGECTL_DIR = join7(process.env.HOME || "/tmp", ".forgectl");
var PID_FILE = join7(FORGECTL_DIR, "daemon.pid");
function savePid(pid) {
  mkdirSync4(FORGECTL_DIR, { recursive: true });
  writeFileSync2(PID_FILE, String(pid));
}
function readPid() {
  if (!existsSync6(PID_FILE)) return null;
  const raw = readFileSync4(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    unlinkSync(PID_FILE);
    return null;
  }
}
function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {
  }
}
function isDaemonRunning() {
  return readPid() !== null;
}

export {
  getWorkflow,
  listWorkflows,
  formatDuration,
  resolveRunPlan,
  getClaudeAuth,
  setClaudeApiKey,
  runEvents,
  emitRunEvent,
  executeRun,
  Logger,
  savePid,
  readPid,
  removePid,
  isDaemonRunning
};
//# sourceMappingURL=chunk-OJKWABHL.js.map