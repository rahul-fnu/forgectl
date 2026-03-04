# TASK: Build forgectl v2 — DAG Pipeline Orchestration

You are adding DAG workflow orchestration to forgectl. The core engine (single-task execution) already works. You are building a pipeline layer on top that lets users define multi-step DAGs where each node is a forgectl run, outputs chain between nodes, and you can checkpoint/revert.

**Read SPEC.md first** — it has the full v2 specification, examples, and architecture.

**IMPORTANT: This is an unattended overnight run. Be thorough and self-verifying. After each phase, run tests and verify your work before moving on.**

---

## Phase 0: Cleanup

### 0A: Remove Ideon integration artifacts

The previous overnight run added Ideon-specific changes. Clean them up:

```bash
cd ~/forgectl

# Remove Ideon fork if it exists
rm -rf ~/ideon
rm -rf ~/ideon-forgectl

# Check if Ideon API extensions were pushed to main
git log --oneline -10
```

If commits like "Extend daemon API: inline context" or "Add AI Task block" exist on main, do NOT revert them — the inline context and /auth/status endpoints are useful for pipelines too. Just leave them.

Remove only Ideon-specific files that don't belong:
- Any FORGECTL_INTEGRATION_NOTES.md in the forgectl repo
- Any references to Ideon in README.md

### 0B: Verify v1 still works

```bash
npm run build
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
node dist/index.js --help
node dist/index.js workflows list
```

ALL tests must pass before proceeding. Fix any issues.

Commit:
```bash
git add -A && git commit -m "Cleanup: remove Ideon integration artifacts"
```

---

## Phase 1: Pipeline Types and Parser

### 1A: Pipeline types (`src/pipeline/types.ts`)

Define the core interfaces:

```typescript
// Pipeline definition (from YAML)
interface PipelineDefinition {
  name: string;
  description?: string;
  defaults?: {
    workflow?: string;
    agent?: string;
    repo?: string;
    review?: boolean;
    model?: string;
  };
  nodes: PipelineNode[];
}

interface PipelineNode {
  id: string;
  task: string;
  depends_on?: string[];
  workflow?: string;
  agent?: string;
  repo?: string;
  review?: boolean;
  model?: string;
  input?: string[];
  context?: string[];
  pipe?: {
    mode: "branch" | "files" | "context";
  };
}

// Pipeline execution state
interface PipelineRun {
  id: string;
  pipeline: PipelineDefinition;
  status: "running" | "completed" | "failed";
  nodes: Map<string, NodeExecution>;
  startedAt: string;
  completedAt?: string;
}

interface NodeExecution {
  nodeId: string;
  runId?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;  // From src/orchestration/single.ts
  checkpoint?: CheckpointRef;
  error?: string;
}

interface CheckpointRef {
  nodeId: string;
  pipelineRunId: string;
  timestamp: string;
  branch?: string;
  commitSha?: string;
  outputDir?: string;
}
```

### 1B: Pipeline parser (`src/pipeline/parser.ts`)

Load and validate pipeline YAML files using zod:

```typescript
import { z } from "zod";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

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
});

const PipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaults: z.object({
    workflow: z.string().optional(),
    agent: z.string().optional(),
    repo: z.string().optional(),
    review: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  nodes: z.array(PipelineNodeSchema).min(1),
});

export function parsePipeline(filePath: string): PipelineDefinition {
  const raw = readFileSync(filePath, "utf-8");
  const data = load(raw);
  return PipelineSchema.parse(data);
}
```

### 1C: DAG validation (`src/pipeline/dag.ts`)

```typescript
// Validate the DAG:
// 1. No duplicate node IDs
// 2. All depends_on references point to existing nodes
// 3. No cycles (use DFS-based cycle detection)
// 4. At least one root node (no dependencies)

// Topological sort:
// Return nodes in execution order (Kahn's algorithm)
// Nodes at the same "level" (same depth) can run in parallel

export function validateDAG(pipeline: PipelineDefinition): { valid: boolean; errors: string[] };
export function topologicalSort(pipeline: PipelineDefinition): string[];
export function getParallelGroups(pipeline: PipelineDefinition): string[][];
```

### Verification:
```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
```

Write tests in `test/unit/pipeline-dag.test.ts`:
- Valid linear DAG (A → B → C)
- Valid fan-out (A → B, A → C)
- Valid fan-in (A + B → C)
- Valid diamond (A → B, A → C, B + C → D)
- Invalid: cycle (A → B → A)
- Invalid: missing dependency reference
- Invalid: duplicate node IDs
- Topological sort produces valid order
- Parallel groups are correct

Commit:
```bash
git add -A && git commit -m "Add pipeline types, parser, and DAG validation"
```

---

## Phase 2: Pipeline Executor

### 2A: Node input resolver (`src/pipeline/resolver.ts`)

Determine what each node receives as input based on its upstream nodes:

```typescript
interface ResolvedNodeInput {
  repo?: string;           // For git mode: path to repo (possibly on a merged branch)
  branch?: string;         // For git mode: branch to checkout before running
  files?: string[];        // For files mode: paths to upstream output files
  contextFiles?: string[]; // Context to inject into prompt
}

export async function resolveNodeInput(
  node: PipelineNode,
  pipeline: PipelineDefinition,
  nodeStates: Map<string, NodeExecution>,
): Promise<ResolvedNodeInput>;
```

For git-mode upstream:
- Single dependency: checkout upstream's branch, run from there
- Multiple dependencies: merge upstream branches into a temp branch

For files-mode upstream:
- Collect output files from all upstream nodes into the new node's input

### 2B: Branch merge utility (`src/pipeline/merge.ts`)

```typescript
export async function mergeUpstreamBranches(
  repoPath: string,
  upstreamBranches: string[],
  targetBranch: string,
): Promise<{ success: boolean; conflicts?: string }>;
```

### 2C: Pipeline executor (`src/pipeline/executor.ts`)

The main orchestrator:

```typescript
export class PipelineExecutor {
  constructor(pipeline: PipelineDefinition, options?: {
    maxParallel?: number;
    fromNode?: string;       // Resume from this node
    verbose?: boolean;
  });
  
  async execute(): Promise<PipelineRun>;
}
```

The executor:
1. Validates the DAG
2. Computes topological order
3. Iterates through nodes in order
4. Waits for each node's dependencies to complete before starting it
5. Runs independent nodes in parallel (up to maxParallel)
6. For each node, calls the existing `executeRun()` from `src/orchestration/modes.ts`
7. Saves checkpoints after each successful node
8. Emits pipeline-level events via the existing event system
9. Handles failures: skip downstream nodes if upstream fails

### 2D: CLI command (`src/cli/pipeline.ts`)

Add the `forgectl pipeline` subcommands:

```bash
forgectl pipeline show --file pipeline.yaml      # Display DAG in terminal
forgectl pipeline run --file pipeline.yaml        # Execute the pipeline
forgectl pipeline run --file pipeline.yaml --dry-run  # Show execution plan
forgectl pipeline status --file pipeline.yaml     # Show last run status
```

Register in `src/index.ts`.

### Verification:

Write tests in `test/unit/pipeline-executor.test.ts`:
- Linear pipeline executes in order
- Parallel nodes run concurrently
- Failed node skips downstream
- Fan-in waits for all upstream
- Dry-run shows plan without executing
- Resume from node skips upstream

```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
npm run build
node dist/index.js pipeline --help
```

Commit:
```bash
git add -A && git commit -m "Add pipeline executor with parallel execution and branch piping"
```

---

## Phase 3: Checkpointing

### 3A: Checkpoint storage (`src/pipeline/checkpoint.ts`)

```typescript
export async function saveCheckpoint(
  pipelineRunId: string,
  nodeId: string,
  result: ExecutionResult,
): Promise<CheckpointRef>;

export async function loadCheckpoint(
  pipelineRunId: string,
  nodeId: string,
): Promise<CheckpointRef | null>;

export async function listCheckpoints(
  pipelineRunId: string,
): Promise<CheckpointRef[]>;
```

Checkpoints stored at `.forgectl/checkpoints/<pipeline-run-id>/<node-id>/`:
- `checkpoint.json` — metadata (timestamp, branch, sha, etc.)
- For git mode: `repo.bundle` — git bundle of the branch
- For files mode: `output/` — copy of the output files

### 3B: Rerun command

`forgectl pipeline rerun --file pipeline.yaml --from <node-id>`:
1. Load checkpoints for all nodes upstream of `<node-id>`
2. Skip those nodes (mark as "skipped", use checkpoint data)
3. Execute from `<node-id>` onwards
4. For the target node, resolve input from upstream checkpoints (not live execution)

### 3C: Revert command

`forgectl pipeline revert --file pipeline.yaml --to <node-id>`:
1. Load the checkpoint for `<node-id>`
2. For git mode: checkout the checkpoint's branch in the repo
3. For files mode: copy checkpoint files to the output directory
4. Print what was reverted

### Verification:

Write tests in `test/unit/pipeline-checkpoint.test.ts`:
- Save and load checkpoint
- Rerun skips upstream nodes
- Rerun executes from target node
- Revert restores git branch
- Revert restores output files

```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
```

Commit:
```bash
git add -A && git commit -m "Add pipeline checkpointing with save/load/rerun/revert"
```

---

## Phase 4: Terminal Visualization

### 4A: DAG renderer (`src/pipeline/visualize.ts`)

Render the DAG in the terminal using chalk and box-drawing characters:

```
Pipeline: add-auth-system (6 nodes)

  ┌─────────────┐
  │ user-model   │
  │ ✅ 45s       │
  └──────┬───────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────────┐ ┌────────────────┐
│auth-routes│ │auth-middleware  │
│ ✅ 62s    │ │ ✅ 38s          │
└────┬──────┘ └───────┬────────┘
     └───────┬────────┘
             ▼
     ┌───────────────┐
     │protect-routes  │
     │ 🔄 running...  │
     └───────┬────────┘
             ▼
     ┌───────────────┐
     │auth-tests      │
     │ ⏳ pending      │
     └────────────────┘
```

Status indicators:
- ✅ completed (green)
- 🔄 running (blue)  
- ⏳ pending (gray)
- ❌ failed (red)
- ⏭️ skipped (dim)

For complex DAGs with many parallel branches, use a simpler list-based view as fallback:

```
Pipeline: add-auth-system

Level 0: user-model ✅ (45s)
Level 1: auth-routes ✅ (62s) | auth-middleware ✅ (38s)
Level 2: protect-routes 🔄 running...
Level 3: auth-tests ⏳ pending
```

### Verification:
```bash
npm run build

# Create a test pipeline file
cat > /tmp/test-pipeline.yaml << 'EOF'
name: test-pipeline
defaults:
  workflow: code
  agent: codex
  repo: /tmp/forge-test
nodes:
  - id: step-1
    task: "First step"
  - id: step-2a
    task: "Parallel step A"
    depends_on: [step-1]
  - id: step-2b
    task: "Parallel step B"
    depends_on: [step-1]
  - id: step-3
    task: "Final step"
    depends_on: [step-2a, step-2b]
EOF

node dist/index.js pipeline show --file /tmp/test-pipeline.yaml
```

Commit:
```bash
git add -A && git commit -m "Add terminal DAG visualization for pipelines"
```

---

## Phase 5: Daemon API + Dashboard

### 5A: Pipeline API routes

Add to `src/daemon/routes.ts`:

```typescript
// POST /pipelines — submit a pipeline
// GET /pipelines — list pipeline runs
// GET /pipelines/:id — get pipeline run status
// GET /pipelines/:id/events — SSE stream of pipeline events
// POST /pipelines/:id/rerun — rerun from a specific node
```

### 5B: Update dashboard

Update `src/ui/index.html` to show:
- Pipeline runs in addition to single runs
- A simple DAG visualization for each pipeline (nodes as boxes, edges as lines)
- Per-node status (color-coded)
- Click a node to see its run details
- Pipeline submit form (paste YAML)

### Verification:
```bash
npm run build
node dist/index.js up --foreground &
sleep 2

# Submit a pipeline
curl -s -X POST http://127.0.0.1:4856/pipelines \
  -H "Content-Type: application/json" \
  -d "{\"pipeline\":$(cat /tmp/test-pipeline.yaml | python3 -c 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)))')}"

# List pipelines
curl -s http://127.0.0.1:4856/pipelines

# Dashboard
curl -s http://127.0.0.1:4856/ | head -5

node dist/index.js down
```

Commit:
```bash
git add -A && git commit -m "Add pipeline API routes and update dashboard"
```

---

## Phase 6: Examples and Polish

### 6A: Example pipelines

Create `examples/` directory with the pipeline files from SPEC.md:
- `examples/auth-system.yaml`
- `examples/research-report.yaml`
- `examples/data-pipeline.yaml`

### 6B: Update README

Add pipeline documentation:
- What pipelines are
- Pipeline YAML format
- CLI commands (pipeline show/run/rerun/revert/status)
- Example pipelines
- Checkpointing and revert

### 6C: browser-use Dockerfile

Create `dockerfiles/Dockerfile.research-browser`:
```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates nodejs npm && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages browser-use langchain-openai langchain-anthropic \
    beautifulsoup4 trafilatura markdownify playwright
RUN playwright install --with-deps chromium
RUN npm install -g @anthropic-ai/claude-code @openai/codex
RUN mkdir -p /input /output
WORKDIR /workspace
```

Try to build it:
```bash
docker build -f dockerfiles/Dockerfile.research-browser -t forgectl/research-browser dockerfiles/
```

If it fails due to network restrictions, that's OK — commit the Dockerfile anyway.

Commit:
```bash
git add -A && git commit -m "Add example pipelines, browser-use Dockerfile, update README"
```

---

## Phase 7: Full E2E Verification (DO NOT SKIP)

### 7A: All tests pass
```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
npm run build
```

### 7B: v1 still works
```bash
node dist/index.js --help
node dist/index.js workflows list
node dist/index.js auth list

# Dry run
rm -rf /tmp/forge-test && mkdir /tmp/forge-test && cd /tmp/forge-test
git init && cat > package.json << 'EOF'
{"name":"forge-test","scripts":{"lint":"echo ok","typecheck":"echo ok","test":"echo ok","build":"echo ok"}}
EOF
cat > index.js << 'EOF'
const express = require("express");
const app = express();
app.get("/", (req, res) => res.json({ message: "hello" }));
module.exports = app;
EOF
git add -A && git commit -m "init"
cd ~/forgectl
node dist/index.js run --task "Add a health endpoint" --workflow code --agent codex --repo /tmp/forge-test --dry-run
```

### 7C: Pipeline commands work
```bash
# Show DAG
node dist/index.js pipeline show --file examples/auth-system.yaml

# Dry-run pipeline
node dist/index.js pipeline run --file examples/auth-system.yaml --dry-run

# Validate a bad pipeline (should show errors)
cat > /tmp/bad-pipeline.yaml << 'EOF'
name: bad
nodes:
  - id: a
    task: "do something"
    depends_on: [b]
  - id: b
    task: "do something"
    depends_on: [a]
EOF
node dist/index.js pipeline show --file /tmp/bad-pipeline.yaml 2>&1 | grep -i "cycle\|error"
```

### 7D: Daemon + API
```bash
node dist/index.js up --foreground &
sleep 2
curl -s http://127.0.0.1:4856/health
curl -s http://127.0.0.1:4856/pipelines
curl -s http://127.0.0.1:4856/ | head -5
node dist/index.js down
```

### 7E: Live E2E test (if Codex auth available)
```bash
cd ~/forgectl
node dist/index.js run \
  --task "Add a GET /health endpoint that returns { status: 'ok' }" \
  --workflow code --agent codex --repo /tmp/forge-test --no-review --verbose
```

Expected: `N files changed, +N -N` (not 0).

### 7F: Final state
```bash
npm run typecheck    # Zero errors
FORGECTL_SKIP_DOCKER=true npm test  # All pass
npm run build        # Clean
git status           # Note uncommitted changes
```

Push:
```bash
git push origin main
```

---

## Final Checklist

- [ ] Pipeline YAML parser with zod validation
- [ ] DAG validation: cycles, missing refs, duplicates
- [ ] Topological sort
- [ ] Pipeline executor with parallel node execution
- [ ] Node input resolver (branch piping for git, file piping for files)
- [ ] Branch merging for fan-in nodes
- [ ] Checkpoint save/load
- [ ] `forgectl pipeline show` — terminal DAG visualization
- [ ] `forgectl pipeline run` — execute DAG
- [ ] `forgectl pipeline run --dry-run` — show execution plan
- [ ] `forgectl pipeline rerun --from <node>` — resume from checkpoint
- [ ] `forgectl pipeline revert --to <node>` — restore checkpoint state
- [ ] `forgectl pipeline status` — show run status
- [ ] Pipeline API routes in daemon
- [ ] Dashboard updated with pipeline DAG view
- [ ] Example pipeline files
- [ ] browser-use Dockerfile
- [ ] README updated
- [ ] All existing v1 tests still pass
- [ ] New pipeline tests pass
- [ ] v1 `forgectl run` still works
- [ ] All changes committed and pushed
