# BUILD SPECIFICATION: forgectl

## What This Is

forgectl is a local daemon + CLI that runs AI agents (Claude Code, Codex CLI) inside isolated Docker containers for **any workflow** — coding, research, content creation, data analysis, ops automation. Users bring their own AI subscriptions. forgectl provides the sandbox, tooling, orchestration, validation, and output collection.

```bash
# Code workflow
forgectl run --task "Add rate limiting to /api/upload" --workflow code

# Research workflow
forgectl run --task "Competitive analysis of observability platforms" --workflow research

# Content workflow  
forgectl run --task "Write a blog post about our v2 launch" --workflow content \
  --context ./docs/v2-changelog.md ./docs/brand-guide.md

# Data workflow
forgectl run --task "Clean the sales CSV, deduplicate, produce summary stats" --workflow data \
  --input ./data/sales-raw.csv

# Ops workflow
forgectl run --task "Write a Terraform module for our RDS setup" --workflow ops
```

Every run produces **validated output** — tested code on a git branch, a reviewed report in an output folder, a cleaned dataset, a set of infrastructure scripts — or nothing. No half-finished garbage.

---

## Core Concepts

### 1. Workflows

A **workflow** is a preset that configures what tools the agent has access to, what validation looks like, and how output is delivered. It's NOT a pipeline (no DAG, no step ordering). It's a **profile** that shapes the sandbox.

forgectl ships with built-in workflows. Users can create custom workflows.

```yaml
# Built-in workflows:
#
# code     — git repo mounted, code tools, lint/test/build validation, output = git branch
# research — web access allowed, search tools, fact-check validation, output = files (markdown/PDF)
# content  — context docs mounted, writing tools, review validation, output = files
# data     — data files mounted, Python/R data stack, schema validation, output = files
# ops      — infra tools (terraform, aws cli), dry-run validation, output = files or git branch
# general  — minimal preset, user configures everything
```

A workflow determines:

| | **code** | **research** | **content** | **data** | **ops** |
|---|---|---|---|---|---|
| Container image | node/python/go | python + browser | python + pandoc | python-data | infra-tools |
| Network | open (npm install, etc.) | open (full web for research) | open | open | open |
| Input | git repo | context files | context files | data files | git repo or files |
| Tools in container | git, rg, fd, compilers | curl, puppeteer, jq | pandoc, wkhtmltopdf | pandas, jupyter, matplotlib | terraform, aws, kubectl, ansible |
| Validation | lint, typecheck, test, build | fact-check (sources cited), word count, format check | spelling, grammar, brand voice check, reviewer agent | schema validation, row count check, no PII | dry-run (terraform plan), lint (shellcheck) |
| Output | git branch | files/ directory | files/ directory | files/ directory | git branch or files/ |
| Default review | code reviewer agent | fact-checker agent | editor agent | data quality agent | ops reviewer agent |

### 2. Sandbox

Every agent runs in a Docker container. The sandbox provides:
- **Isolation** — container filesystem, no access to host (except mounted inputs)
- **Network** — open by default (agents can reach the web, install packages, do research). Optionally restricted via allowlist or fully airgapped for paranoid use cases
- **Resource limits** — memory, CPU caps
- **Credential injection** — API keys mounted as read-only files, never in env

### 3. Validation

Validation is a list of **checks** that run against the agent's output. Each check is a shell command that exits 0 (pass) or non-zero (fail). On failure, the error is fed back to the agent for retry.

For code, this is `npm run lint`, `npm test`, etc.
For content, this could be `vale --output=line .` (prose linter) or a reviewer agent.
For data, this could be `python validate_schema.py output.csv`.

Validation is fully configurable. Workflows provide sensible defaults.

### 4. Output

Every run produces artifacts in one of two modes:

- **git** — changes committed to a new branch, branch extracted to host repo
- **files** — output files copied from container to a local directory

The workflow determines the default, but the user can override.

### 5. Multi-Agent

Agent Relay enables agents to collaborate within a run:
- **Review mode** — implementer + reviewer (default for code and content)
- **Parallel mode** — coordinator splits task, workers execute in parallel containers
- **Custom** — user defines agent roles and routing

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         User's Machine                            │
│                                                                   │
│  forgectl CLI                                                     │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                forgectl daemon (localhost)                 │    │
│  │                                                           │    │
│  │  REST API (:4856)            Web UI (:4857)              │    │
│  │                                                           │    │
│  │  ┌─────────────────────────────────────────────────┐     │    │
│  │  │              Workflow Engine                      │     │    │
│  │  │                                                   │     │    │
│  │  │  Workflow    Container     Validation    Output   │     │    │
│  │  │  Resolver    Manager      Runner        Collector│     │    │
│  │  └─────────────────────────────────────────────────┘     │    │
│  │                                                           │    │
│  │  ┌─────────────────────────────────────────────────┐     │    │
│  │  │              Agent Relay (embedded)               │     │    │
│  │  └────────┬──────────┬──────────┬──────────────────┘     │    │
│  │           │          │          │                         │    │
│  │  ┌────────▼──┐ ┌────▼─────┐ ┌─▼────────┐              │    │
│  │  │  Agent A  │ │ Agent B  │ │ Agent C  │   Docker     │    │
│  │  │  (any     │ │ (any     │ │ (any     │   containers │    │
│  │  │  workflow) │ │ workflow)│ │ workflow)│   (isolated  │    │
│  │  │  🌐 open  │ │ 🌐 open  │ │ 🌐 open  │    sandbox)  │    │
│  │  └───────────┘ └──────────┘ └──────────┘              │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  BYOK: ~/.forgectl/auth (keychain-stored credentials)            │
│  Config: .forgectl/config.yaml (per-project or global)            │
│  Workflows: .forgectl/workflows/ (custom workflow definitions)    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
forgectl/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
│
├── src/
│   ├── index.ts                      # CLI entry point
│   │
│   ├── cli/                          # CLI commands
│   │   ├── run.ts                    # forgectl run (synchronous)
│   │   ├── submit.ts                 # forgectl submit (async via daemon)
│   │   ├── daemon.ts                 # forgectl up / forgectl down
│   │   ├── auth.ts                   # forgectl auth add/remove/list
│   │   ├── init.ts                   # forgectl init (generate config)
│   │   ├── workflows.ts             # forgectl workflows list/show/create
│   │   ├── status.ts                 # forgectl status
│   │   └── logs.ts                   # forgectl logs <run-id>
│   │
│   ├── workflow/                     # Workflow system
│   │   ├── types.ts                  # WorkflowDefinition interface
│   │   ├── registry.ts              # Lookup workflow by name, merge user overrides
│   │   ├── resolver.ts             # Resolve workflow + config + CLI flags into a RunPlan
│   │   ├── builtins/                # Built-in workflow definitions
│   │   │   ├── code.ts
│   │   │   ├── research.ts
│   │   │   ├── content.ts
│   │   │   ├── data.ts
│   │   │   ├── ops.ts
│   │   │   └── general.ts
│   │   └── custom.ts               # Load user-defined workflows from .forgectl/workflows/
│   │
│   ├── daemon/                       # Long-running daemon
│   │   ├── server.ts                 # Fastify HTTP server
│   │   ├── routes.ts                 # REST API routes
│   │   ├── queue.ts                  # Run queue (sequential or parallel execution)
│   │   └── lifecycle.ts              # Start/stop, PID file, health checks
│   │
│   ├── config/                       # Configuration
│   │   ├── schema.ts                 # Zod schemas for config.yaml
│   │   ├── loader.ts                 # Load YAML, validate, merge defaults + overrides
│   │   └── defaults.ts              # Global defaults
│   │
│   ├── auth/                         # BYOK credential management
│   │   ├── store.ts                  # Keychain abstraction (macOS/Linux)
│   │   ├── claude.ts                 # Claude Code: OAuth session or API key
│   │   ├── codex.ts                  # Codex: OpenAI API key
│   │   └── mount.ts                  # Prepare credentials for container mounting
│   │
│   ├── container/                    # Docker sandbox management
│   │   ├── builder.ts               # Build/pull Docker images
│   │   ├── runner.ts                # Create, start, exec, stop, remove containers
│   │   ├── network.ts               # Network config (open by default, optional restriction via Docker network + iptables)
│   │   ├── workspace.ts             # Mount inputs: repo (code/ops) or files (research/data/content)
│   │   ├── secrets.ts               # Mount credentials as read-only files
│   │   └── cleanup.ts               # Tear down containers, networks, temp dirs
│   │
│   ├── agent/                        # Agent adapters
│   │   ├── types.ts                  # AgentAdapter interface
│   │   ├── claude-code.ts            # Claude Code adapter (claude -p)
│   │   ├── codex.ts                  # Codex CLI adapter
│   │   └── registry.ts              # Lookup adapter by name
│   │
│   ├── orchestration/                # Multi-agent coordination
│   │   ├── modes.ts                  # Dispatcher: single / review / parallel
│   │   ├── single.ts                # One agent, validate, output
│   │   ├── review.ts                # Implementer + reviewer loop
│   │   ├── parallel.ts              # Coordinator + N workers
│   │   └── relay.ts                 # Agent Relay integration
│   │
│   ├── validation/                   # Output validation
│   │   ├── runner.ts                # Run checks sequentially, manage retries
│   │   ├── step.ts                  # Execute single check command
│   │   ├── feedback.ts             # Format errors for agent retry
│   │   └── builtins.ts             # Built-in validation helpers (schema check, word count, etc.)
│   │
│   ├── output/                       # Output collection
│   │   ├── types.ts                  # OutputStrategy interface
│   │   ├── git.ts                   # Git mode: branch, commit, extract to host
│   │   ├── files.ts                 # Files mode: copy output dir from container to host
│   │   └── collector.ts            # Dispatcher: pick strategy based on workflow/config
│   │
│   ├── context/                      # What the agent sees
│   │   ├── prompt.ts                # Build prompt: system + context + tools + task + validation info
│   │   ├── inject.ts                # Copy context files into container
│   │   └── auto.ts                  # Auto-detect relevant files from task text
│   │
│   ├── logging/                      # Output and observability
│   │   ├── logger.ts                # Structured logger
│   │   ├── terminal.ts             # CLI terminal output (chalk)
│   │   ├── run-log.ts              # JSON run log
│   │   └── events.ts               # EventEmitter for SSE streaming to dashboard
│   │
│   ├── ui/                           # Web dashboard (React, served by daemon)
│   │   ├── index.html
│   │   ├── app.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx        # Active runs, recent history, quick submit
│   │   │   ├── RunView.tsx          # Live streaming output, validation progress
│   │   │   ├── History.tsx          # Filterable run list
│   │   │   ├── Workflows.tsx       # Browse/edit workflow definitions
│   │   │   └── Settings.tsx         # Auth status, global config
│   │   └── components/
│   │       ├── RunCard.tsx
│   │       ├── LiveLog.tsx          # SSE log stream
│   │       ├── ValidationProgress.tsx
│   │       ├── OutputPreview.tsx    # Preview output files (markdown render, code highlight, data table)
│   │       └── CostBadge.tsx
│   │
│   └── utils/
│       ├── template.ts              # {{variable}} expansion
│       ├── slug.ts                  # URL-safe slugs
│       ├── timer.ts                 # Duration tracking
│       ├── hash.ts                  # Content hashing
│       ├── duration.ts             # Parse "30m", "1h" into ms
│       └── ports.ts                 # Find available ports
│
├── workflows/                        # Built-in workflow definition files (YAML)
│   ├── code.yaml
│   ├── research.yaml
│   ├── content.yaml
│   ├── data.yaml
│   ├── ops.yaml
│   └── general.yaml
│
├── dockerfiles/
│   ├── Dockerfile.code-node20       # Node 20 + git + Claude Code + Codex + rg + fd
│   ├── Dockerfile.code-python312    # Python 3.12 + git + Claude Code + Codex
│   ├── Dockerfile.code-go122        # Go 1.22 + git + Claude Code + Codex
│   ├── Dockerfile.research          # Python + Puppeteer + curl + jq + pandoc
│   ├── Dockerfile.content           # Python + pandoc + vale (prose linter) + wkhtmltopdf
│   ├── Dockerfile.data              # Python + pandas + numpy + matplotlib + jupyter + duckdb
│   ├── Dockerfile.ops               # Terraform + AWS CLI + kubectl + ansible + shellcheck
│   ├── Dockerfile.multi             # Everything (large image, ~3GB)
│   └── init-firewall.sh             # iptables firewall script (only used when network mode = restricted/allowlist)
│
├── templates/
│   ├── config.yaml                   # Starter config
│   ├── workflow-custom.yaml         # Template for custom workflow
│   └── prompts/
│       ├── code-review.md           # Default code reviewer prompt
│       ├── content-editor.md        # Default content editor/reviewer prompt
│       ├── fact-checker.md          # Default research fact-checker prompt
│       ├── data-quality.md          # Default data quality reviewer prompt
│       └── ops-review.md            # Default ops reviewer prompt
│
├── test/
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── workflow-resolver.test.ts
│   │   ├── prompt.test.ts
│   │   ├── template.test.ts
│   │   ├── validation.test.ts
│   │   └── output.test.ts
│   ├── integration/
│   │   ├── container.test.ts
│   │   ├── network.test.ts
│   │   ├── auth.test.ts
│   │   ├── relay.test.ts
│   │   ├── git-output.test.ts
│   │   └── file-output.test.ts
│   └── e2e/
│       ├── code-workflow.test.ts
│       ├── research-workflow.test.ts
│       └── data-workflow.test.ts
│
└── .forgectl/
    └── config.yaml                   # Dogfood config
```

---

## Workflow Definition

This is the key abstraction. A workflow is a YAML file that defines the sandbox profile.

### Interface (`src/workflow/types.ts`)

```typescript
interface WorkflowDefinition {
  name: string;
  description: string;
  
  // What container to use
  container: {
    image: string;                    // Default Docker image
    network: {
      mode: "open" | "allowlist" | "airgapped";  // Default: open
      allow: string[];                // Only used in allowlist mode
    };
  };
  
  // How input is mounted into the container
  input: {
    mode: "repo" | "files" | "both";  // repo = git clone, files = copy into /input
    mountPath: string;                 // Where input appears in container (/workspace or /input)
  };
  
  // What tools / system packages are available (informational, baked into Dockerfile)
  tools: string[];
  
  // System prompt for the agent
  system: string;
  
  // Default validation checks
  validation: {
    steps: Array<{
      name: string;
      command: string;
      retries: number;
      description: string;            // Human-readable, shown in dashboard
    }>;
    on_failure: "abandon" | "output-wip" | "pause";
  };
  
  // How output is collected
  output: {
    mode: "git" | "files";
    path: string;                     // Container path to collect from ("/workspace" for git, "/output" for files)
    collect: string[];                // Glob patterns for file mode: ["**/*.md", "**/*.pdf", "**/*.csv"]
  };
  
  // Default review agent configuration (for multi-agent review mode)
  review: {
    system: string;                   // Reviewer system prompt
    enabled: boolean;                 // Whether review mode is on by default for this workflow
  };
}
```

### Built-in Workflow: `code`

```yaml
# workflows/code.yaml
name: code
description: Write, fix, or refactor code in a git repository

container:
  image: forgectl/code-node20
  network:
    mode: open        # Agents can npm install, fetch docs, etc.
    allow: []

input:
  mode: repo
  mountPath: /workspace

tools:
  - git
  - node/npm
  - ripgrep
  - fd

system: |
  You are an expert software engineer working in an isolated container.
  Your workspace is at /workspace containing the full project repository.
  
  Rules:
  - Make the minimal changes needed to complete the task
  - Write tests for any new functionality
  - Follow existing code style and conventions
  - Do not modify linting rules, test configs, or build scripts
  - Do not install new dependencies unless the task requires it

validation:
  steps:
    - name: lint
      command: npm run lint
      retries: 3
      description: Code style and quality checks
    - name: typecheck
      command: npm run typecheck
      retries: 2
      description: TypeScript type checking
    - name: test
      command: npm test
      retries: 3
      description: Unit and integration tests
    - name: build
      command: npm run build
      retries: 1
      description: Production build
  on_failure: abandon

output:
  mode: git
  path: /workspace
  collect: []

review:
  enabled: true
  system: |
    You are a senior code reviewer. Critically review the changes.
    Check for: security issues, error handling, resource leaks, logic errors, test coverage.
    If acceptable, respond with exactly: LGTM
    If issues exist, list them numbered. Only flag real problems, not style preferences.
```

### Built-in Workflow: `research`

```yaml
# workflows/research.yaml
name: research
description: Research a topic, synthesize findings, produce a report

container:
  image: forgectl/research
  network:
    mode: open        # Full web access for research
    allow: []

input:
  mode: files
  mountPath: /input

tools:
  - curl
  - puppeteer
  - jq
  - pandoc
  - python3

system: |
  You are an expert researcher working in an isolated container.
  
  You have access to the web via curl and a headless browser (Puppeteer).
  Context files (if any) are in /input.
  Write your output to /output.
  
  Rules:
  - Cite all sources with URLs
  - Distinguish facts from analysis/opinion
  - Use markdown for reports
  - Include an executive summary at the top
  - Save all output files to /output

validation:
  steps:
    - name: output-exists
      command: "test -f /output/*.md || test -f /output/*.pdf"
      retries: 2
      description: Report file exists
    - name: has-sources
      command: "grep -c 'http' /output/*.md | awk -F: '{s+=$2} END {if(s<3) exit 1}'"
      retries: 2
      description: Report includes at least 3 source URLs
    - name: min-length
      command: "wc -w /output/*.md | tail -1 | awk '{if($1<500) exit 1}'"
      retries: 1
      description: Report is at least 500 words
  on_failure: output-wip

output:
  mode: files
  path: /output
  collect: ["**/*.md", "**/*.pdf", "**/*.json"]

review:
  enabled: true
  system: |
    You are a fact-checker and editor. Review this research report.
    Check for: unsupported claims, missing citations, logical gaps, outdated information.
    If acceptable, respond with: APPROVED
    If issues exist, list them numbered.
```

### Built-in Workflow: `content`

```yaml
# workflows/content.yaml
name: content
description: Write blog posts, documentation, marketing copy, translations

container:
  image: forgectl/content
  network:
    mode: open
    allow: []

input:
  mode: files
  mountPath: /input

tools:
  - pandoc
  - vale  # Prose linter
  - wkhtmltopdf
  - python3

system: |
  You are an expert writer working in an isolated container.
  
  Context files (brand guides, source material, etc.) are in /input.
  Write your output to /output.
  
  Rules:
  - Match the tone and style specified in the task or brand guide
  - Use markdown unless another format is specified
  - Include appropriate headings and structure
  - Save all output files to /output

validation:
  steps:
    - name: output-exists
      command: "ls /output/*.md /output/*.html /output/*.pdf 2>/dev/null | head -1 | grep -q ."
      retries: 2
      description: Output file exists
    - name: prose-lint
      command: "vale --output=line /output/*.md 2>/dev/null || true"
      retries: 2
      description: Prose quality check (spelling, grammar, style)
  on_failure: output-wip

output:
  mode: files
  path: /output
  collect: ["**/*.md", "**/*.html", "**/*.pdf", "**/*.docx"]

review:
  enabled: true
  system: |
    You are a senior editor. Review this content for clarity, accuracy, and tone.
    Check for: factual errors, unclear writing, tone inconsistency, missing sections.
    If acceptable, respond with: APPROVED
    If issues exist, list them numbered.
```

### Built-in Workflow: `data`

```yaml
# workflows/data.yaml
name: data
description: ETL, analysis, cleaning, visualization, dataset transformation

container:
  image: forgectl/data
  network:
    mode: open
    allow: []

input:
  mode: files
  mountPath: /input

tools:
  - python3
  - pandas
  - numpy
  - matplotlib
  - duckdb
  - jq
  - csvkit

system: |
  You are a data engineer/analyst working in an isolated container.
  
  Input data files are in /input.
  Write all output to /output.
  
  Rules:
  - Validate data before and after transformations
  - Preserve original files in /input (read-only)
  - Document any assumptions or data quality issues
  - Save analysis scripts to /output/scripts/ so work is reproducible
  - Save data outputs to /output/data/
  - Save visualizations to /output/viz/

validation:
  steps:
    - name: output-exists
      command: "ls /output/data/* 2>/dev/null | head -1 | grep -q ."
      retries: 2
      description: Output data files exist
    - name: scripts-exist
      command: "ls /output/scripts/*.py 2>/dev/null | head -1 | grep -q ."
      retries: 1
      description: Processing scripts are saved (reproducibility)
    - name: no-pii
      command: "python3 -c \"
import re, sys, glob
patterns = [r'\\b\\d{3}-\\d{2}-\\d{4}\\b', r'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b']
for f in glob.glob('/output/data/*'):
  text = open(f).read()
  for p in patterns:
    if re.search(p, text):
      print(f'PII detected in {f}'); sys.exit(1)
\""
      retries: 1
      description: Check output for PII (SSN, email patterns)
  on_failure: abandon

output:
  mode: files
  path: /output
  collect: ["**/*"]

review:
  enabled: false
  system: ""
```

### Built-in Workflow: `ops`

```yaml
# workflows/ops.yaml
name: ops
description: Infrastructure scripts, Terraform modules, migration scripts, monitoring config

container:
  image: forgectl/ops
  network:
    mode: open
    allow: []

input:
  mode: repo
  mountPath: /workspace

tools:
  - terraform
  - aws-cli
  - kubectl
  - ansible
  - shellcheck
  - python3

system: |
  You are a senior infrastructure engineer working in an isolated container.
  
  Your workspace is at /workspace. You are writing infrastructure-as-code.
  You do NOT have access to any real cloud accounts or clusters.
  All validation is via dry-run / plan / lint — nothing is applied.
  
  Rules:
  - All Terraform must pass `terraform validate` and `terraform fmt`
  - All shell scripts must pass shellcheck
  - Include README or comments explaining what the code does
  - Use variables for anything environment-specific (no hardcoded values)

validation:
  steps:
    - name: shellcheck
      command: "find /workspace -name '*.sh' -exec shellcheck {} + 2>/dev/null || true"
      retries: 2
      description: Shell script linting
    - name: terraform-fmt
      command: "find /workspace -name '*.tf' -exec terraform fmt -check {} + 2>/dev/null || true"
      retries: 2
      description: Terraform formatting
    - name: terraform-validate
      command: "cd /workspace && terraform init -backend=false 2>/dev/null && terraform validate 2>/dev/null || true"
      retries: 2
      description: Terraform configuration validation
  on_failure: output-wip

output:
  mode: git
  path: /workspace
  collect: []

review:
  enabled: true
  system: |
    You are a senior infrastructure reviewer. Review these IaC changes.
    Check for: security misconfigs, missing encryption, overly permissive IAM, 
    hardcoded secrets, missing tagging, resource naming conventions.
    If acceptable, respond with: LGTM
    If issues exist, list them numbered.
```

### Custom Workflows

Users can create custom workflows in `.forgectl/workflows/`:

```yaml
# .forgectl/workflows/my-api-docs.yaml
name: my-api-docs
extends: content          # Inherit from built-in, override specific fields

container:
  image: forgectl/content  # Same container

system: |
  You are a technical writer specializing in API documentation.
  Write OpenAPI-style documentation with examples.
  Use our company's doc format (see /input/doc-template.md).

context:
  files:
    - ./docs/doc-template.md
    - ./src/routes/**/*.ts     # Auto-include API route files for reference

validation:
  steps:
    - name: output-exists
      command: "test -f /output/*.md"
      retries: 2
      description: Documentation file exists
    - name: has-examples
      command: "grep -c '```' /output/*.md | awk -F: '{s+=$2} END {if(s<3) exit 1}'"
      retries: 2
      description: Includes at least 3 code examples
```

---

## Configuration

The project-level config (`.forgectl/config.yaml`) sets defaults that apply across all runs. CLI flags and `--workflow` override these.

```yaml
# .forgectl/config.yaml

# Default agent for all workflows
agent:
  type: claude-code              # claude-code | codex
  model: ""                      # Empty = agent's default model
  max_turns: 50
  timeout: 30m

# Default container overrides (merged with workflow defaults)
container:
  resources:
    memory: 4g
    cpus: 2

# Default repo settings (for code/ops workflows)
repo:
  branch:
    template: "forge/{{slug}}/{{ts}}"
    base: main
  exclude:
    - node_modules/
    - .git/objects/
    - dist/
    - "*.log"
    - .env

# Orchestration defaults
orchestration:
  mode: single                    # single | review | parallel
  review:
    max_rounds: 3

# Commit defaults (for git output mode)
commit:
  message:
    prefix: "[forge]"
    template: "{{prefix}} {{summary}}"
  author:
    name: forgectl
    email: forge@localhost

# Output defaults (for files output mode)
output:
  dir: ./forge-output             # Where file outputs land on host
  log_dir: .forgectl/runs         # Run log location
```

---

## CLI Commands

```
forgectl run [options]
  Run a task synchronously. Blocks until complete.
  
  --task, -t <string>           Task prompt (required)
  --workflow, -w <string>       Workflow: code|research|content|data|ops|general|<custom>
                                (default: auto-detect from context, or "general")
  --repo, -r <path>             Repository path (for code/ops workflows)
  --input, -i <path...>         Input files/dirs (for research/content/data workflows)
  --context <path...>           Additional context files (included in agent prompt)
  --agent, -a <string>          Agent: claude-code | codex
  --model, -m <string>          Model override
  --config, -c <path>           Config file path
  --review                      Enable review mode (overrides workflow default)
  --no-review                   Disable review mode
  --output-dir, -o <path>       Output directory for file mode
  --timeout <duration>          Override timeout
  --verbose                     Show full agent output
  --no-cleanup                  Leave container running
  --dry-run                     Show run plan without executing

forgectl submit [options]
  Submit to daemon queue (async). Same options as run. Returns run ID.

forgectl up [--port N] [--ui-port N]
  Start daemon.

forgectl down
  Stop daemon.

forgectl status
  Daemon status + active/queued runs.

forgectl auth add <provider>
  Add credentials (claude-code | codex).

forgectl auth list
  Show configured providers.

forgectl auth remove <provider>
  Remove credentials.

forgectl init [--stack node|python|go|research|data|ops]
  Generate .forgectl/config.yaml with workflow-appropriate defaults.

forgectl workflows list
  List available workflows (built-in + custom).

forgectl workflows show <name>
  Show full workflow definition.

forgectl workflows create <name> [--extends <base>]
  Create custom workflow from template in .forgectl/workflows/.

forgectl logs <run-id> [--follow]
  View or stream run logs.
```

**Workflow auto-detection:** If `--workflow` is not specified:
- If `--repo` is provided or current dir is a git repo → `code`
- If `--input` has `.csv`, `.tsv`, `.json`, `.parquet` files → `data`
- If `--input` has `.md`, `.txt`, `.docx` files → `content`
- Otherwise → `general`

---

## Implementation Details

### Workflow Resolver (`src/workflow/resolver.ts`)

The resolver takes (workflow definition + project config + CLI flags) and produces a `RunPlan`:

```typescript
interface RunPlan {
  // Resolved from workflow + overrides
  runId: string;
  task: string;
  workflow: WorkflowDefinition;
  agent: { type: AgentType; model: string; maxTurns: number; timeout: number; flags: string[] };
  container: { image: string; network: NetworkConfig; resources: ResourceConfig };
  input: { mode: "repo" | "files"; sources: string[]; mountPath: string; exclude: string[] };
  context: { system: string; files: string[]; inject: InjectConfig[] };
  validation: { steps: ValidationStep[]; onFailure: FailureAction };
  output: { mode: "git" | "files"; path: string; collect: string[]; hostDir: string };
  orchestration: { mode: OrchMode; review: ReviewConfig };
  commit: CommitConfig;          // Only used if output.mode === "git"
}
```

Merge priority: CLI flags > project config > workflow definition > global defaults.

### Container Workspace (`src/container/workspace.ts`)

Depending on input mode:

**`repo` mode** (code, ops):
1. Copy git repo into container at `/workspace` (respecting exclude globs)
2. Include `.git` metadata (for branch creation)
3. Mount read-only

**`files` mode** (research, content, data):
1. Copy input files into container at `/input` (read-only)
2. Create empty `/output` directory (writable)
3. Agent reads from `/input`, writes to `/output`

**`both` mode** (available if user overrides):
1. Repo at `/workspace` + files at `/input`

### Output Collector (`src/output/`)

**`git.ts`** — Git output strategy:
```typescript
async function collectGitOutput(container: Container, config: GitOutputConfig): Promise<GitResult> {
  // Inside container:
  await execInContainer(container, ["git", "add", "-A"]);
  await execInContainer(container, [
    "git", "commit",
    "-m", expandTemplate(config.commit.message.template, vars),
    `--author=${config.commit.author.name} <${config.commit.author.email}>`,
  ]);
  
  // Copy .git back to host
  const tmpGit = path.join(tmpdir(), `forgectl-git-${runId}`);
  await copyFromContainer(container, "/workspace/.git", tmpGit);
  
  // Fetch the branch into the host repo
  execSync(`git fetch ${tmpGit} ${branchName}:${branchName}`, { cwd: hostRepoPath });
  
  return { branch: branchName, sha: commitSha, filesChanged, insertions, deletions };
}
```

**`files.ts`** — Files output strategy:
```typescript
async function collectFileOutput(container: Container, config: FileOutputConfig): Promise<FileResult> {
  const outputDir = config.hostDir; // e.g., ./forge-output/run-20260228-143022/
  await fs.mkdir(outputDir, { recursive: true });
  
  // Copy matching files from container /output to host
  const archive = await container.getArchive({ path: config.path });
  await extractTar(archive, outputDir, config.collect); // Filter by glob patterns
  
  const files = await listFiles(outputDir);
  return { dir: outputDir, files, totalSize: sumSize(files) };
}
```

### Network Profiles Per Workflow

Network is open by default. Containers use Docker's default bridge network and have full internet access. This lets agents `npm install`, `pip install`, `curl` APIs, browse the web for research, download datasets, etc.

For security-sensitive environments, users can opt into network restriction:

```typescript
function resolveNetworkConfig(workflow: WorkflowDefinition, agentType: AgentType): NetworkConfig {
  const config = { ...workflow.container.network };
  
  // Default: open mode — standard Docker bridge, full internet
  if (config.mode === "open") {
    return { mode: "open", dockerNetwork: "bridge" };
  }
  
  // Airgapped: Docker --network=none, zero connectivity
  if (config.mode === "airgapped") {
    return { mode: "airgapped", dockerNetwork: "none" };
  }
  
  // Allowlist: create isolated bridge + iptables rules
  // Only used when user explicitly opts in for hardened environments
  // Always auto-include the LLM API domain
  if (agentType === "claude-code") config.allow.push("api.anthropic.com");
  if (agentType === "codex") config.allow.push("api.openai.com");
  
  return { mode: "allowlist", dockerNetwork: `forgectl-${runId}`, allow: config.allow };
}
```

The iptables firewall script (`init-firewall.sh`) is only used in `allowlist` mode. For `open` mode (the default), no firewall setup is needed — standard Docker networking handles everything.

### Review Mode Per Workflow

Each workflow has a different reviewer persona:

| Workflow | Reviewer role | What they check |
|----------|--------------|-----------------|
| code | Code reviewer | Security, error handling, test coverage, logic |
| research | Fact-checker | Source validity, unsupported claims, logical gaps |
| content | Editor | Clarity, tone, accuracy, completeness |
| data | Data quality reviewer | Schema validity, data integrity, PII |
| ops | Infra reviewer | Security misconfigs, hardcoded secrets, best practices |

Review mode uses two containers. The reviewer container gets a **read-only snapshot** of the primary agent's output. Reviewer produces text only (LGTM/APPROVED or issues). Issues are fed back to the primary agent.

### Agent Prompt Assembly

The prompt is workflow-aware:

```typescript
function buildPrompt(plan: RunPlan): string {
  const parts: string[] = [];
  
  // 1. Workflow system prompt
  parts.push(plan.context.system || plan.workflow.system);
  
  // 2. Context files (contents inlined with filename headers)
  for (const file of plan.context.files) {
    parts.push(`\n--- Context: ${file} ---\n${readFile(file)}\n`);
  }
  
  // 3. Available tools description
  parts.push(`\nAvailable tools in this container: ${plan.workflow.tools.join(", ")}\n`);
  
  // 4. Agent Relay protocol (if multi-agent)
  if (plan.orchestration.mode !== "single") {
    parts.push(RELAY_PROTOCOL_SNIPPET);
  }
  
  // 5. The task
  parts.push(`\n--- Task ---\n${plan.task}\n`);
  
  // 6. Validation instructions
  if (plan.validation.steps.length > 0) {
    parts.push(`\nAfter you finish, these validation checks will run:\n`);
    for (const step of plan.validation.steps) {
      parts.push(`- ${step.name}: \`${step.command}\` — ${step.description}`);
    }
    parts.push(`\nIf any check fails, you'll receive the error and must fix it.\n`);
  }
  
  // 7. Output instructions
  if (plan.output.mode === "files") {
    parts.push(`\nSave all output files to ${plan.output.path}\n`);
  }
  
  return parts.join("\n");
}
```

### Validation Feedback Per Workflow

Feedback is the same mechanism regardless of workflow — run command, capture output, feed errors to agent — but the framing changes:

```typescript
function formatFeedback(step: ValidationStep, result: ExecResult, workflow: string): string {
  const base = `Validation step "${step.name}" failed.\nCommand: ${step.command}\nExit code: ${result.exitCode}`;
  
  const output = [
    result.stdout.length > 0 ? `STDOUT:\n${result.stdout.slice(-5000)}` : "",
    result.stderr.length > 0 ? `STDERR:\n${result.stderr.slice(-5000)}` : "",
  ].filter(Boolean).join("\n\n");
  
  const instructions: Record<string, string> = {
    code: "Fix the code issues. Do NOT weaken linting rules or delete tests.",
    research: "Fix the report. Ensure sources are cited and claims are supported.",
    content: "Revise the content. Address the style and quality issues.",
    data: "Fix the data pipeline. Ensure output matches expected schema.",
    ops: "Fix the infrastructure code. Ensure it passes validation/dry-run.",
    general: "Fix the issues identified above.",
  };
  
  return `${base}\n\n${output}\n\n${instructions[workflow] || instructions.general}`;
}
```

---

## Dockerfiles

### Research Container

```dockerfile
# dockerfiles/Dockerfile.research
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq iptables dnsutils ca-certificates \
    python3 python3-pip \
    pandoc wkhtmltopdf \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer uses system Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g @anthropic-ai/claude-code puppeteer

# Claude Code and Codex CLIs
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

# Python tools for data extraction
RUN pip install --break-system-packages beautifulsoup4 requests trafilatura

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

RUN mkdir -p /input /output
WORKDIR /workspace
```

### Data Container

```dockerfile
# dockerfiles/Dockerfile.data
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq iptables dnsutils ca-certificates \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Data science stack
RUN pip install --break-system-packages \
    pandas numpy scipy matplotlib seaborn plotly \
    scikit-learn duckdb pyarrow polars \
    openpyxl xlsxwriter csvkit \
    jupyter nbconvert

# Agent CLIs
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

RUN mkdir -p /input /output/data /output/scripts /output/viz
WORKDIR /workspace
```

### Ops Container

```dockerfile
# dockerfiles/Dockerfile.ops
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq iptables dnsutils ca-certificates \
    python3 python3-pip \
    shellcheck \
    nodejs npm \
    unzip gnupg software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Terraform
RUN curl -fsSL https://releases.hashicorp.com/terraform/1.9.0/terraform_1.9.0_linux_amd64.zip -o tf.zip \
    && unzip tf.zip -d /usr/local/bin && rm tf.zip

# AWS CLI
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscli.zip \
    && unzip awscli.zip && ./aws/install && rm -rf aws awscli.zip

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/v1.30.0/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Ansible
RUN pip install --break-system-packages ansible ansible-lint

# Agent CLIs
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

WORKDIR /workspace
```

---

## Technology Stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript (Node.js 20+) |
| CLI | commander |
| Config | js-yaml + zod |
| Docker | dockerode |
| HTTP server (daemon) | fastify |
| Agent messaging | agent-relay (npm) |
| Dashboard | React + Vite (bundled static) |
| Terminal output | chalk |
| Globs | picomatch |
| Credential storage | keytar |
| Testing | vitest |
| Build / bundle | tsup |

---

## Build Phases

### Phase 1: Foundation (week 1-2)
1. Project scaffolding: package.json, tsconfig, eslint, vitest, tsup
2. Config schema (zod) + loader (YAML → validate → merge)
3. Workflow type definitions + built-in workflow YAML files (code, research, content, data, ops, general)
4. Workflow registry (load built-in + custom workflows)
5. Workflow resolver (merge workflow + config + CLI flags → RunPlan)
6. Template expansion utils
7. CLI skeleton (all commands stubbed with commander)
8. Auth store (keychain abstraction)
9. `forgectl auth add/list/remove` working
10. `forgectl init` generating starter config
11. `forgectl workflows list/show` working
12. Tests for config, workflow resolution, templates

### Phase 2: Container Engine (week 3-4)
13. Docker image builder/puller (dockerode)
14. Container lifecycle: create, start, exec, stop, remove
15. Workspace setup: `repo` mode (git clone into container) + `files` mode (copy to /input)
16. Credential mounting (secrets as read-only files)
17. Network config (open by default; optional allowlist/airgapped modes with iptables for hardened setups)
18. Write all Dockerfiles (code-node20, research, content, data, ops)
19. init-firewall.sh with wildcard domain support
20. Tests: verify firewall, verify workspace isolation

### Phase 3: Single-Agent Execution (week 5-6)
21. Agent adapter interface + Claude Code adapter + Codex adapter
22. Prompt builder (workflow-aware: system + context + tools + task + validation info + output instructions)
23. Context injection (mount files into container)
24. Exec agent in container, capture stdout/stderr/exit
25. Validation step runner (single step, capture output)
26. Validation retry loop (run all steps, feed errors back, re-invoke agent)
27. Feedback formatter (workflow-aware messaging)
28. Git output collector (branch, commit, extract to host)
29. File output collector (copy /output from container to host dir)
30. `forgectl run --workflow code` end-to-end
31. `forgectl run --workflow research` end-to-end
32. `forgectl run --workflow data --input data.csv` end-to-end
33. Terminal output (phases, progress, summary)
34. JSON run log
35. Tests

### Phase 4: Daemon + API (week 7-8)
36. Daemon lifecycle (start/stop, PID file)
37. Fastify server with REST routes
38. Run queue (submit, execute, track)
39. SSE streaming for live events
40. `forgectl up/down/status/submit/logs` commands
41. Tests

### Phase 5: Multi-Agent / Relay (week 9-10)
42. Agent Relay integration (setup per-run relay context)
43. Relay mount preparation (outbox/inbox dirs per container)
44. Protocol snippet injection into agent prompts
45. Review mode: implementer + reviewer (each workflow uses its own reviewer prompt)
46. Workspace snapshot sync (primary → reviewer container, read-only)
47. Review result parsing (LGTM/APPROVED vs issues)
48. Fix loop (feedback → agent → re-validate → re-review)
49. Tests for review mode across workflows

### Phase 6: Dashboard (week 11-12)
50. Vite + React setup
51. Dashboard page (active runs, history, workflow breakdown)
52. Run view (live SSE log, validation progress, output preview)
53. Output preview component (render markdown, highlight code, show data tables, display images)
54. History page (filter by workflow type, status, date)
55. Workflows page (browse definitions, create custom)
56. Settings page (auth, config)
57. Build: Vite → dist/ui/ → served by daemon
58. License key gating

### Phase 7: Polish + Launch (week 13-14)
59. README with examples for each workflow type
60. npm package publishing
61. Homebrew formula
62. Starter templates for each stack
63. E2E tests for each workflow
64. Landing page / docs site
65. GitHub Actions CI

---

## Key Design Decisions

1. **Workflows are profiles, not pipelines.** A workflow configures the sandbox (image, network, tools, validation, output mode). It does NOT define a sequence of steps. The agent decides how to accomplish the task. This keeps V1 simple while being extensible.

2. **Validation is universal but workflow-specific.** The mechanism (run command → check exit code → feed errors → retry) is identical for all workflows. What changes is the commands themselves: `npm test` for code, `grep -c 'http'` for research sources, schema checks for data.

3. **Two output modes, not one.** Code/ops workflows produce git branches. Research/content/data produce files in a local directory. The user can override, but the defaults make sense per workflow.

4. **Network is open by default.** All workflows get full internet access — agents can install packages, browse for research, fetch APIs. Container isolation (filesystem, process) is the security boundary, not network lockdown. Users can opt into `allowlist` or `airgapped` mode for hardened environments, but this is the exception, not the default.

5. **Custom workflows extend built-ins.** `extends: content` inherits everything from the content workflow and lets the user override specific fields. This avoids copy-pasting entire workflow definitions.

6. **Auto-detection keeps zero-config viable.** `forgectl run --task "..."` without `--workflow` still works — we detect from the input type and task content.

7. **File output mode creates timestamped directories.** Each run's output lands in `./forge-output/<run-id>/` so previous runs aren't overwritten. The dashboard shows output previews (rendered markdown, data tables, images).

8. **Reviewer persona matches the workflow.** A code reviewer checks for bugs and security. A fact-checker checks for citations and claims. An editor checks for clarity and tone. Same mechanism, different prompts.

9. **Agent Relay is still a direct dependency.** Multi-agent works the same regardless of workflow type. Review mode pairs any workflow's primary agent with its reviewer.

10. **Pre-flight checks before burning tokens.** Verify Docker, image, credentials, inputs, git status (for repo mode). Fail fast with clear error messages.
