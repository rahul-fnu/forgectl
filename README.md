# forgectl

A CLI + daemon that orchestrates AI agents (Claude Code and Codex) in isolated Docker containers.

## What this project does

This project lets you define a task in natural language, choose an agent, and run it safely inside a controlled environment. forgectl handles the operational pieces around AI execution so each task is reproducible:

- spins up ephemeral containers with workflow-specific images
- injects scoped repo/input/context into the agent
- validates outputs (tests, lint, builds, etc.) and applies structured retries
- collects results as Git commits or generated files
- records everything as runs that can be inspected, replayed, or reviewed

For a personal site, this is a good showcase of end-to-end engineering with:

- TypeScript + CLI architecture (`commander`, typed command modules)
- orchestration and scheduling (`Fastify` daemon, queue/runs, SSE logs)
- container lifecycle management (sandboxing, cleanup, network modes, secrets)
- pipeline/DAG execution for multi-step workflows
- validation + review loops and output collection

The tool is BYOK (bring your own keys); it does not host model weights or proxy agent APIs.

## Quick Start

### Prerequisites

- Node.js 20+
- Docker Engine running
- An AI agent subscription: [Claude Code](https://claude.ai) or [OpenAI Codex](https://platform.openai.com)

### Install

```bash
git clone https://github.com/rahul-fnu/forgectl.git
cd forgectl
npm install
npm run build
npm link  # makes `forgectl` available globally
```

### Configure Auth

```bash
# Option A: Use existing OAuth sessions (if you've already logged in via `claude` or `codex` CLI)
forgectl auth list   # Shows detected credentials

# Option B: Add API keys manually
forgectl auth add claude-code   # Prompts for ANTHROPIC_API_KEY
forgectl auth add codex         # Prompts for OPENAI_API_KEY
```

### First Run

```bash
# Create a test project
mkdir /tmp/my-project && cd /tmp/my-project
git init
echo '{"name":"my-project","scripts":{"test":"echo ok","lint":"echo ok","build":"echo ok"}}' > package.json
echo 'module.exports = { hello: "world" };' > index.js
git add -A && git commit -m "init"

# Run forgectl
forgectl run \
  --task "Add a GET /health endpoint that returns { status: 'ok' }" \
  --workflow code \
  --agent codex \
  --repo /tmp/my-project \
  --no-review

# Check the result
cd /tmp/my-project
git log --oneline --all   # Shows the forge/* branch with changes
```

## Usage Examples

### Code Workflow

Write, fix, or refactor code in a git repository. Validates with lint, typecheck, test, and build.

```bash
forgectl run \
  --task "Add rate limiting to /api/upload" \
  --workflow code \
  --repo ./my-app

forgectl run \
  --task "Refactor the auth middleware to use JWT" \
  --workflow code \
  --agent claude-code \
  --repo ./backend \
  --review   # Enable multi-agent review mode
```

### Research Workflow

Produce research reports with citations. Output collected as files.

```bash
forgectl run \
  --task "Competitive analysis of observability platforms" \
  --workflow research
```

### Content Workflow

Create blog posts, documentation, marketing copy.

```bash
forgectl run \
  --task "Write a blog post about our v2 launch" \
  --workflow content \
  --context ./docs/v2-changelog.md ./docs/brand-guide.md
```

### Data Workflow

Clean, transform, and analyze datasets.

```bash
forgectl run \
  --task "Clean the sales CSV, deduplicate, produce summary stats" \
  --workflow data \
  --input ./data/sales-raw.csv
```

### Ops Workflow

Write infrastructure scripts, Terraform modules, CI configs.

```bash
forgectl run \
  --task "Write a Terraform module for our RDS setup" \
  --workflow ops
```

## Pipelines (v2)

Pipelines let you define multi-step DAGs where each node is a forgectl run. Outputs chain between nodes, and you can checkpoint/revert to any point.

### Pipeline YAML Format

```yaml
name: add-auth-system
description: Add authentication to an Express app

defaults:
  workflow: code
  agent: codex
  repo: ./my-project

nodes:
  - id: user-model
    task: "Create a User model with Prisma ORM."

  - id: auth-routes
    task: "Add POST /auth/register and POST /auth/login."
    depends_on: [user-model]

  - id: auth-middleware
    task: "Create auth middleware that verifies JWT tokens."
    depends_on: [user-model]

  - id: protect-routes
    task: "Add auth middleware to all routes except /health."
    depends_on: [auth-routes, auth-middleware]

  - id: auth-tests
    task: "Write integration tests for the auth system."
    depends_on: [protect-routes]
```

### Pipeline Commands

```bash
# Visualize the DAG
forgectl pipeline show --file pipeline.yaml

# Execute the pipeline
forgectl pipeline run --file pipeline.yaml --repo ./my-project

# Dry-run (show execution plan)
forgectl pipeline run --file pipeline.yaml --dry-run

# Re-run from a specific node using checkpoints from a prior run
forgectl pipeline rerun --file pipeline.yaml --from auth-routes --pipeline-run <run-id>

# Revert to a checkpoint
forgectl pipeline revert --file pipeline.yaml --to user-model --pipeline-run <run-id>

# Show pipeline status
forgectl pipeline status --file pipeline.yaml
```

### How It Works

- **Git-mode workflows:** Downstream git nodes fan in upstream git branches on a temporary branch, then merge output back into the host repo.
- **Files-mode workflows:** Upstream file outputs are namespaced into `/input/upstream/<node-id>/...` to preserve paths and avoid collisions.
- **Mixed-mode context:** Text artifacts are inlined (size-limited); binary/large artifacts are passed as files with a context manifest.
- **Parallel execution:** Independent nodes run simultaneously (up to `--max-parallel`).
- **Checkpointing:** Each completed node saves checkpoint metadata (git branch+SHA or files output dir+file list). Reruns hydrate required ancestors from checkpoints.

See `examples/` for sample pipelines.

## CLI Reference

```
forgectl run [options]        Run a task synchronously
  -t, --task <string>         Task prompt (required)
  -w, --workflow <string>     Workflow: code|research|content|data|ops|general
  -r, --repo <path>           Repository path (for code/ops workflows)
  -i, --input <paths...>      Input files (for data/research/content workflows)
  --context <paths...>        Context files added to agent prompt
  -a, --agent <string>        Agent: claude-code|codex
  -m, --model <string>        Model override
  --review / --no-review      Enable/disable multi-agent review
  --dry-run                   Print run plan without executing
  --verbose                   Show full agent output
  --no-cleanup                Leave container running after run
  --timeout <duration>        Timeout (e.g. 30m, 1h)
  -o, --output-dir <path>     Output directory (files mode)

forgectl auth add <provider>  Add credentials
forgectl auth list            List configured credentials
forgectl auth remove <prov>   Remove credentials

forgectl workflows list       List built-in workflows
forgectl workflows show <n>   Show workflow definition

forgectl init                 Generate starter .forgectl/config.yaml

forgectl up [--port N]        Start the daemon (default port 4856)
forgectl down                 Stop the daemon
forgectl status               Show daemon status and recent runs
forgectl submit [options]     Submit a run to the daemon
forgectl logs <runId>         Show run logs (--follow for SSE stream)

forgectl pipeline show -f <path>     Visualize the DAG
forgectl pipeline run -f <path>      Execute a pipeline
  --dry-run                          Show plan without executing
  --max-parallel <n>                 Max concurrent nodes
  --from <node>                      Resume from node
forgectl pipeline status -f <path>   Show pipeline status
forgectl pipeline rerun -f <path>    Re-run from a node
  --from <node>                      Node to start from
  --pipeline-run <id>                Checkpoint source run ID (required)
forgectl pipeline revert -f <path>   Revert to checkpoint
  --to <node>                        Target node
```

## Configuration

Create `.forgectl/config.yaml` in your project root to customize behavior:

```yaml
agent:
  type: codex              # or claude-code
  model: ""                # model override
  max_turns: 50
  timeout: 30m

container:
  image: forgectl/code-node20   # custom Docker image
  network:
    mode: open             # open | allowlist | airgapped
    allow: []              # domains for allowlist mode
  resources:
    memory: 4g
    cpus: 2

repo:
  branch:
    template: "forge/{{slug}}/{{ts}}"
  exclude:
    - node_modules/
    - dist/
    - build/
    - "*.log"
    - .env
    - ".env.*"

commit:
  message:
    prefix: "[forge]"
  author:
    name: forgectl
    email: forge@localhost

orchestration:
  mode: single             # single | review
  review:
    max_rounds: 3
```

Generate a starter config:

```bash
forgectl init
forgectl init --stack node    # Node.js-specific defaults
```

## Custom Workflows

Extend built-in workflows or create your own in `.forgectl/config.yaml`:

```yaml
workflows:
  my-workflow:
    extends: code                # Inherit from built-in
    container:
      image: my-custom-image     # Custom Docker image
    validation:
      steps:
        - name: lint
          command: npm run lint
          retries: 3
        - name: test
          command: npm test
          retries: 2
    review:
      enabled: true              # Enable multi-agent review
```

## Web Dashboard

The daemon serves a web dashboard at `http://127.0.0.1:4856/`:

```bash
forgectl up           # Start daemon
open http://127.0.0.1:4856   # Open dashboard
```

Features:
- **Dashboard** — Active and recent runs, quick submit form
- **Run View** — Live SSE event stream, validation progress, output preview
- **History** — Filterable table of all runs
- **Settings** — Auth status, daemon info

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  CLI / Web  │────>│  forgectl daemon │────>│   Docker     │
│  Dashboard  │<────│  (Fastify :4856) │<────│  Container   │
└─────────────┘     │                  │     │              │
                    │  ┌─RunQueue────┐ │     │  Agent       │
                    │  │ sequential  │ │     │  (Claude/    │
                    │  │ processing  │ │     │   Codex)     │
                    │  └─────────────┘ │     │              │
                    │                  │     │  /workspace  │
                    │  ┌─Orchestrator─┐│     │  (bind mount)│
                    │  │ prepare      ││     └──────────────┘
                    │  │ execute      ││
                    │  │ validate     ││     ┌──────────────┐
                    │  │ collect      ││────>│  Host Repo   │
                    │  └──────────────┘│     │  (git fetch) │
                    └──────────────────┘     └──────────────┘
```

**Key design decisions:**

1. **Workflows are profiles, not pipelines.** A workflow configures the sandbox. The agent decides how to do the task.
2. **Two output modes:** `git` (branch with commits) and `files` (directory).
3. **Validation is universal.** Run command, check exit code, feed errors to agent, retry.
4. **Agent invocations are individual CLI calls.** `claude -p "..."` or `codex exec "..."` each time.
5. **Network is open by default.** Optionally restricted via allowlist or airgapped mode.

## REST API

When the daemon is running:

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /auth/status | Auth provider status |
| POST | /runs | Submit a run |
| GET | /runs | List all runs |
| GET | /runs/:id | Get run details |
| GET | /runs/:id/events | SSE event stream |
| POST | /pipelines | Submit a pipeline |
| GET | /pipelines | List pipeline runs |
| GET | /pipelines/:id | Get pipeline status |
| GET | /pipelines/:id/events | Pipeline SSE stream |
| POST | /pipelines/:id/rerun | Re-run from a node |

## Development

```bash
npm run dev          # Watch mode (rebuilds on change)
npm run build        # Production build
npm run typecheck    # TypeScript type checking
npm test             # Run all tests
npm run lint         # ESLint
npm run format       # Prettier
```

## License

MIT
