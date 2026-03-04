# BUILD SPECIFICATION: forgectl v2

## What This Is

forgectl is a local daemon + CLI that runs AI agents (Claude Code, Codex CLI) inside isolated Docker containers. v1 runs single tasks. v2 adds **DAG workflow orchestration** — multi-step pipelines where each node is an AI agent task, outputs chain between nodes, and you can checkpoint/revert to any point.

```
┌──────┐   ┌──────┐
│task1 │   │task2 │     ← independent, run in parallel
└──┬───┘   └──┬───┘
   │          │
   └────┬─────┘
        ▼
    ┌──────┐
    │task3 │             ← waits for task1 AND task2
    └──┬───┘
       │
   ┌───┼───────┐
   ▼   ▼       ▼
┌────┐┌────┐┌────┐
│tk4 ││tk5 ││tk6 │      ← fan-out, run in parallel
└──┬─┘└──┬─┘└────┘
   │     │
   └──┬──┘
      ▼
  ┌──────┐
  │task7 │               ← waits for task4 AND task5
  └──┬───┘
     ▼
  ┌──────┐
  │output│               ← final deliverable
  └──────┘
```

```bash
# Define a pipeline
forgectl pipeline create --file pipeline.yaml

# Run the whole DAG
forgectl pipeline run --file pipeline.yaml --repo ./my-project

# Revert task7 and re-run from task5's checkpoint
forgectl pipeline rerun --file pipeline.yaml --from task5

# Visualize the DAG in terminal
forgectl pipeline show --file pipeline.yaml
```

---

## Current Status (v1 — Complete)

| Phase | Status | What's Built |
|-------|--------|-------------|
| Phase 1: Foundation | ✅ | Config (zod), workflows, CLI (commander), auth, templates |
| Phase 2: Container Engine | ✅ | Docker lifecycle (dockerode), workspace, credentials, network, Dockerfiles |
| Phase 3: Single-Agent Execution | ✅ | Claude Code + Codex adapters, validation loop, git + file output |
| Phase 4: Daemon + API | ✅ | Fastify server, run queue, SSE streaming |
| Phase 5: Multi-Agent / Review | ✅ | Review mode with per-workflow reviewer prompts |
| Phase 6: Dashboard | ✅ | Single-file React UI served by daemon |
| Phase 7: Polish | ✅ | README, cleanup, 179/179 tests, E2E verified |

**E2E verified:** Codex runs in Docker, modifies files, validation passes, branch lands on host with real file changes.

---

## v2: DAG Workflow Orchestration

### Core Concepts

**Pipeline** — A YAML file defining a DAG of tasks. Each task is a node. Edges define dependencies. The pipeline executor runs tasks in topological order, parallelizing independent nodes.

**Node** — A single forgectl run (task + workflow + agent). A node can receive inputs from upstream nodes and produce outputs consumed by downstream nodes.

**Edge** — A dependency between nodes. Task B depends on task A means B won't start until A completes successfully. Edges also define how outputs flow: A's git branch or output files become B's input.

**Checkpoint** — A snapshot of a node's output after successful completion. Stored locally. Enables reverting the pipeline to any previous node and re-running from there without re-executing upstream tasks.

### Pipeline Definition Format

```yaml
# pipeline.yaml
name: add-auth-system
description: Add authentication to the Express app

# Global settings (apply to all nodes unless overridden)
defaults:
  workflow: code
  agent: codex
  repo: ./my-project

# The DAG
nodes:
  - id: user-model
    task: "Create a User model with email, password hash, and timestamps. Use Prisma ORM."
    
  - id: auth-routes
    task: "Add POST /auth/register and POST /auth/login endpoints using bcrypt and JWT."
    depends_on: [user-model]
    
  - id: auth-middleware
    task: "Create an auth middleware that verifies JWT tokens from the Authorization header."
    depends_on: [user-model]
    
  - id: protect-routes
    task: "Add the auth middleware to all existing API routes except /health and /auth/*."
    depends_on: [auth-routes, auth-middleware]
    
  - id: auth-tests
    task: "Write integration tests for the auth system: register, login, protected routes, invalid tokens."
    depends_on: [protect-routes]

  - id: auth-docs
    task: "Update README.md with authentication documentation: setup, API endpoints, examples."
    workflow: content
    depends_on: [auth-tests]
```

### Pipeline Definition Schema

```typescript
interface PipelineDefinition {
  name: string;
  description?: string;
  
  defaults?: {
    workflow?: string;       // Default workflow for all nodes
    agent?: string;          // Default agent for all nodes
    repo?: string;           // Default repo path
    review?: boolean;        // Default review mode
    model?: string;          // Default model
  };
  
  nodes: PipelineNode[];
}

interface PipelineNode {
  id: string;                // Unique node identifier (used in depends_on)
  task: string;              // The prompt for this node
  depends_on?: string[];     // IDs of upstream nodes (must complete before this runs)
  
  // Per-node overrides (inherit from defaults if not set)
  workflow?: string;
  agent?: string;
  repo?: string;
  review?: boolean;
  model?: string;
  input?: string[];          // Additional input files
  context?: string[];        // Additional context files
  
  // Output piping config
  pipe?: {
    mode: "branch" | "files" | "context";
    // branch: downstream node starts from this node's branch (git mode)
    // files: downstream node gets this node's output files as input
    // context: downstream node gets this node's output inlined in its prompt
  };
}
```

### How Outputs Chain Between Nodes

The key question: when task3 depends on task1 and task2, what does task3 see?

**For git-mode workflows (code, ops):**

Each node starts from the previous node's branch. The pipeline executor manages this:

1. task1 runs against the base repo → produces `forge/user-model/...` branch
2. task2 runs against the base repo → produces `forge/auth-routes/...` branch  
3. task3 depends on both → executor merges task1 and task2 branches into a temporary branch, then task3 runs against that merged state

For linear chains (A → B → C), each node simply starts from the previous node's branch. No merging needed.

For fan-in (A + B → C), the executor merges upstream branches before starting C. If merge conflicts occur, a special "merge resolution" agent run is triggered.

```typescript
interface NodeExecution {
  nodeId: string;
  runId: string;              // forgectl run ID
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;
  checkpoint?: CheckpointRef;  // Reference to saved output state
  
  // The resolved input for this node
  inputBranch?: string;       // For git mode: branch to start from
  inputFiles?: string[];      // For files mode: files from upstream
  inputContext?: string[];    // Context injected from upstream outputs
}
```

**For files-mode workflows (research, content, data):**

Upstream output files become downstream input files:

1. task1 (research) → produces `/output/market-analysis.md`
2. task2 (research) → produces `/output/competitor-list.md`
3. task3 (content, depends on both) → gets both files in `/input/`

### Checkpointing and Revert

Every completed node saves a checkpoint:

```typescript
interface Checkpoint {
  nodeId: string;
  pipelineRun: string;        // Pipeline execution ID
  timestamp: string;
  
  // For git mode
  branch?: string;            // The branch this node produced
  commitSha?: string;
  
  // For files mode
  outputDir?: string;         // Directory with output files (copied to checkpoint store)
  
  // Metadata
  filesChanged?: number;
  duration?: number;
}
```

Checkpoints are stored at `.forgectl/checkpoints/<pipeline-run>/<node-id>/`.

**Revert flow:**
```bash
# Re-run pipeline from task5, using task4's checkpoint as input
forgectl pipeline rerun --file pipeline.yaml --from task5
```

This:
1. Loads task4's checkpoint (the branch or files it produced)
2. Skips task1, task2, task3, task4 (already done)
3. Runs task5 starting from task4's output
4. Continues downstream from task5

### DAG Executor

```typescript
class PipelineExecutor {
  private pipeline: PipelineDefinition;
  private nodeStates: Map<string, NodeExecution>;
  private checkpoints: Map<string, Checkpoint>;
  
  async execute(options: {
    fromNode?: string;         // Resume from this node (skip upstream)
    dryRun?: boolean;
  }): Promise<PipelineResult> {
    
    // 1. Validate the DAG (no cycles, all depends_on reference valid nodes)
    this.validateDAG();
    
    // 2. Topological sort
    const order = this.topologicalSort();
    
    // 3. Execute nodes in order, parallelizing independent ones
    const inFlight = new Map<string, Promise<NodeExecution>>();
    
    for (const nodeId of order) {
      const node = this.getNode(nodeId);
      
      // Skip if resuming and this node has a checkpoint
      if (options.fromNode && this.hasCheckpoint(nodeId) && 
          !this.isDownstreamOf(nodeId, options.fromNode)) {
        this.nodeStates.set(nodeId, { ...existingState, status: "skipped" });
        continue;
      }
      
      // Wait for dependencies
      await this.waitForDependencies(node.depends_on || []);
      
      // Check if any dependency failed
      if (this.anyDependencyFailed(node.depends_on || [])) {
        this.nodeStates.set(nodeId, { nodeId, status: "failed", 
          error: "Upstream dependency failed" });
        continue;
      }
      
      // Prepare input from upstream outputs
      const input = await this.resolveNodeInput(node);
      
      // Execute the node (this calls forgectl's existing run engine)
      const promise = this.executeNode(node, input);
      inFlight.set(nodeId, promise);
      
      // Don't await — let independent nodes run in parallel
      // Only await when a downstream node needs this one
    }
    
    // Wait for all remaining in-flight nodes
    await Promise.all(inFlight.values());
    
    return this.buildResult();
  }
  
  private async executeNode(
    node: PipelineNode, 
    input: ResolvedInput
  ): Promise<NodeExecution> {
    // Build CLIOptions from node + defaults
    const options: CLIOptions = {
      task: node.task,
      workflow: node.workflow || this.pipeline.defaults?.workflow || "code",
      agent: node.agent || this.pipeline.defaults?.agent || "codex",
      repo: input.repo || node.repo || this.pipeline.defaults?.repo,
      input: input.files,
      context: input.contextFiles,
      review: node.review ?? this.pipeline.defaults?.review ?? false,
    };
    
    // Use the existing forgectl execution engine
    const config = loadConfig();
    const plan = resolveRunPlan(config, options);
    const logger = new Logger(false);
    const result = await executeRun(plan, logger);
    
    // Save checkpoint
    if (result.success) {
      await this.saveCheckpoint(node.id, result);
    }
    
    return { nodeId: node.id, status: result.success ? "completed" : "failed", result };
  }
}
```

### Branch Merging for Fan-In

When multiple git-mode nodes feed into a single downstream node:

```typescript
async function mergeUpstreamBranches(
  repo: string,
  upstreamBranches: string[],
  targetBranch: string
): Promise<{ success: boolean; conflicts?: string }> {
  // Create a new branch from the first upstream
  execSync(`git checkout -b ${targetBranch} ${upstreamBranches[0]}`, { cwd: repo });
  
  // Merge remaining upstreams
  for (const branch of upstreamBranches.slice(1)) {
    try {
      execSync(`git merge ${branch} --no-edit`, { cwd: repo });
    } catch {
      // Merge conflict — return the conflicts for resolution
      const conflicts = execSync(`git diff --name-only --diff-filter=U`, { cwd: repo }).toString();
      execSync(`git merge --abort`, { cwd: repo });
      return { success: false, conflicts };
    }
  }
  
  return { success: true };
}
```

If merge fails, the pipeline can either:
- **Fail** the downstream node with the conflict info
- **Auto-resolve** by running an agent with the conflict as its task (stretch goal)

---

## CLI Commands (v2 additions)

```
forgectl pipeline create --file <path>
  Validate and create a pipeline definition file.
  Interactive mode if no file given.

forgectl pipeline show --file <path>
  Display the DAG visually in the terminal.
  Shows nodes, edges, and current status if a run exists.

forgectl pipeline run --file <path> [--repo <path>] [--verbose] [--dry-run]
  Execute the full pipeline. Runs nodes in topological order.
  Parallelizes independent nodes. Saves checkpoints.

forgectl pipeline rerun --file <path> --from <node-id>
  Resume from a specific node. Uses checkpoints for upstream nodes.
  Re-executes the target node and all downstream.

forgectl pipeline status --file <path>
  Show status of the most recent pipeline run.
  Per-node: status, duration, output summary.

forgectl pipeline revert --file <path> --to <node-id>
  Revert the repo to the state after <node-id> completed.
  Uses the checkpoint to restore the branch/files.

# Existing v1 commands still work unchanged:
forgectl run --task "..." --workflow code --agent codex --repo ./project
forgectl up / down / status / auth / workflows / init / logs
```

### Terminal DAG Visualization

`forgectl pipeline show` renders the DAG in the terminal:

```
Pipeline: add-auth-system
  
  ┌─────────────┐   ┌───────────────┐
  │ user-model   │   │ (independent) │
  │ ✅ 45s       │   │               │
  └──────┬───────┘   └───────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────────┐ ┌────────────────┐
│auth-routes│ │auth-middleware  │
│ ✅ 62s    │ │ ✅ 38s          │
└────┬──────┘ └───────┬────────┘
     │                │
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
     └───────┬────────┘
             ▼
     ┌───────────────┐
     │auth-docs       │
     │ ⏳ pending      │
     └────────────────┘
```

---

## Project Structure (v2)

New/modified files marked with `[NEW]` or `[MOD]`:

```
forgectl/
├── src/
│   ├── index.ts                      # CLI entry point [MOD: add pipeline commands]
│   │
│   ├── cli/
│   │   ├── run.ts                    # forgectl run (unchanged)
│   │   ├── pipeline.ts              # forgectl pipeline create/run/rerun/show/status/revert [NEW]
│   │   ├── auth.ts
│   │   ├── init.ts
│   │   └── workflows.ts
│   │
│   ├── pipeline/                    # [NEW] DAG orchestration
│   │   ├── types.ts                 # PipelineDefinition, PipelineNode, NodeExecution interfaces
│   │   ├── parser.ts               # Load + validate pipeline YAML (zod schema)
│   │   ├── dag.ts                  # DAG validation, topological sort, cycle detection
│   │   ├── executor.ts            # PipelineExecutor: run DAG, manage parallelism
│   │   ├── resolver.ts            # Resolve node inputs from upstream outputs
│   │   ├── checkpoint.ts          # Save/load/revert checkpoints
│   │   ├── merge.ts               # Merge upstream git branches for fan-in nodes
│   │   └── visualize.ts           # Terminal DAG renderer
│   │
│   ├── daemon/
│   │   ├── server.ts               # [MOD: add pipeline routes, remove Ideon UI serving]
│   │   ├── routes.ts               # [MOD: add pipeline API endpoints]
│   │   ├── queue.ts                # [MOD: support pipeline runs in queue]
│   │   └── lifecycle.ts
│   │
│   ├── workflow/                     # Unchanged
│   ├── config/                       # [MOD: add pipeline config to schema]
│   ├── auth/                         # Unchanged
│   ├── container/                    # Unchanged
│   ├── agent/                        # Unchanged
│   ├── orchestration/                # Unchanged (single-node execution)
│   ├── validation/                   # Unchanged
│   ├── output/                       # Unchanged
│   ├── context/                      # Unchanged
│   ├── logging/
│   │   ├── events.ts               # [MOD: add pipeline-level events]
│   │   ├── logger.ts
│   │   └── run-log.ts
│   │
│   ├── ui/
│   │   └── index.html              # [MOD: replace with pipeline-aware dashboard]
│   │
│   └── utils/                        # Unchanged
│
├── dockerfiles/                      # [MOD: add research-browser]
│   ├── Dockerfile.code-node20
│   ├── Dockerfile.research
│   ├── Dockerfile.research-browser  # [NEW] Python + browser-use + Playwright
│   ├── Dockerfile.content
│   ├── Dockerfile.data
│   ├── Dockerfile.ops
│   └── init-firewall.sh
│
├── test/
│   ├── unit/
│   │   ├── pipeline-dag.test.ts    # [NEW] DAG validation, topo sort, cycle detection
│   │   ├── pipeline-parser.test.ts # [NEW] YAML parsing and schema validation
│   │   ├── pipeline-executor.test.ts # [NEW] Execution flow, parallelism, checkpoints
│   │   ├── pipeline-merge.test.ts  # [NEW] Branch merging for fan-in
│   │   └── ... (existing tests unchanged)
│   └── integration/
│       └── pipeline-e2e.test.ts    # [NEW] Full pipeline execution test
│
├── examples/                        # [NEW] Example pipeline files
│   ├── auth-system.yaml
│   ├── api-migration.yaml
│   ├── research-report.yaml
│   └── data-pipeline.yaml
│
└── .forgectl/
    ├── config.yaml
    └── checkpoints/                 # [NEW] Pipeline checkpoint storage
        └── <pipeline-run-id>/
            └── <node-id>/
                ├── checkpoint.json
                └── output/          # Saved output files or git bundle
```

---

## Cleanup: Remove Ideon Integration

The overnight run added Ideon-specific code. Remove it:

1. **Delete `~/ideon` directory** — the fork is not needed for v2
2. **Remove from forgectl** any Ideon-specific API changes (inline context on POST /runs, /auth/status endpoint). These may have been pushed to main — check and revert if so.
3. **Keep the dashboard** (`src/ui/index.html`) but update it to show pipeline DAGs instead of just single runs.
4. **Keep the browser-use Dockerfile** — it's still useful for research workflows in pipelines.

```bash
# Clean up Ideon fork
rm -rf ~/ideon
rm -rf ~/ideon-forgectl

# Check if Ideon API changes were pushed to forgectl
cd ~/forgectl
git log --oneline -10
# If the Ideon API extensions are on main, they're harmless — keep them
# The inline context support and /auth/status are useful for pipelines too
```

---

## Daemon API (v2 additions)

```
# Existing (unchanged)
GET  /health
POST /runs                    → Submit a single run
GET  /runs                    → List runs
GET  /runs/:id                → Get run details
GET  /runs/:id/events         → SSE stream

# New pipeline endpoints
POST /pipelines               → Submit a pipeline for execution
  Body: { 
    pipeline: PipelineDefinition,  // The full YAML content parsed to JSON
    repo?: string,                 // Override default repo
    fromNode?: string,             // Resume from this node
  }
  Response: { id: string, status: "running", nodes: NodeStatus[] }

GET  /pipelines                → List pipeline executions
GET  /pipelines/:id            → Get pipeline execution status
  Response: {
    id: string,
    status: "running" | "completed" | "failed",
    pipeline: PipelineDefinition,
    nodes: NodeExecution[],
    startedAt: string,
    completedAt?: string,
  }

GET  /pipelines/:id/events     → SSE stream of pipeline events
  Events include per-node status updates:
  { type: "node:started", nodeId: "auth-routes", ... }
  { type: "node:phase", nodeId: "auth-routes", data: { phase: "validate" } }
  { type: "node:completed", nodeId: "auth-routes", data: { filesChanged: 3 } }
  { type: "pipeline:completed", ... }

POST /pipelines/:id/rerun      → Re-run from a specific node
  Body: { fromNode: string }
```

---

## Dashboard (Updated for Pipelines)

The dashboard at `http://127.0.0.1:4856/` shows:

1. **Active Pipelines** — DAG visualization with per-node status (color-coded: green=done, blue=running, gray=pending, red=failed)
2. **Active Single Runs** — same as v1
3. **Submit** — two tabs: "Single Task" (existing) and "Pipeline" (upload YAML or paste)
4. **Pipeline View** — click a pipeline to see full DAG with live updates via SSE. Click a node to see its run details (agent output, validation, etc.)

---

## Configuration (v2 additions)

```yaml
# .forgectl/config.yaml

# Existing config unchanged...

# New pipeline config
pipeline:
  max_parallel: 3              # Max nodes running simultaneously
  checkpoint_dir: .forgectl/checkpoints
  merge_strategy: fail         # fail | auto-resolve (what to do on git merge conflicts)
  timeout_per_node: 30m        # Default timeout for each node
```

---

## Build Phases (v2)

### Phase 8: Pipeline Core (week 1-2)

1. Pipeline YAML schema (zod) + parser
2. DAG validation: cycle detection, missing references, duplicate IDs
3. Topological sort
4. Pipeline types (PipelineDefinition, PipelineNode, NodeExecution, Checkpoint)
5. `forgectl pipeline show` — terminal DAG visualization
6. `forgectl pipeline create` — interactive pipeline builder (optional, can just write YAML)
7. Tests: DAG validation, topo sort, cycle detection, parser

### Phase 9: Pipeline Executor (week 3-4)

8. PipelineExecutor: execute DAG in topological order
9. Parallel execution of independent nodes (respect max_parallel)
10. Node input resolver: build each node's input from upstream outputs
11. Git branch piping: downstream node starts from upstream's branch
12. Git branch merging for fan-in nodes
13. File output piping: upstream output files become downstream input
14. Context piping: upstream output content inlined in downstream prompt
15. `forgectl pipeline run` command
16. Pipeline-level events (SSE)
17. Tests: executor, parallelism, input resolution, branch piping

### Phase 10: Checkpointing (week 5-6)

18. Checkpoint save: snapshot node output after successful completion
19. Checkpoint load: restore node output for rerun
20. `forgectl pipeline rerun --from <node>` command
21. `forgectl pipeline revert --to <node>` command
22. `forgectl pipeline status` command
23. Checkpoint storage management (cleanup old checkpoints)
24. Tests: checkpoint save/load/revert

### Phase 11: Daemon + Dashboard (week 7-8)

25. Pipeline API routes (POST /pipelines, GET /pipelines/:id, SSE events, rerun)
26. Pipeline queue integration (run pipelines via daemon)
27. Update dashboard: DAG visualization, pipeline submit form, node detail view
28. Pipeline-level SSE streaming to dashboard
29. Tests: API routes, queue integration

### Phase 12: browser-use + Polish (week 9-10)

30. `Dockerfile.research-browser` with browser-use + Playwright
31. Update research workflow to use browser image
32. Example pipeline files (auth-system, api-migration, research-report, data-pipeline)
33. Update README with pipeline documentation
34. E2E test: full pipeline execution with multiple nodes
35. Cleanup: remove dead code, ensure all tests pass

---

## Example Pipelines

### Code: Add Auth System (Linear + Fan-out + Fan-in)

```yaml
name: add-auth-system
defaults:
  workflow: code
  agent: codex
  repo: ./my-api

nodes:
  - id: user-model
    task: |
      Create a User model with Prisma ORM.
      Fields: id (uuid), email (unique), passwordHash, createdAt, updatedAt.
      Create and run the migration.

  - id: auth-routes
    task: |
      Add POST /auth/register and POST /auth/login.
      Use bcrypt for password hashing, JWT for tokens.
      Register: validate email/password, hash password, create user, return JWT.
      Login: find user by email, verify password, return JWT.
    depends_on: [user-model]

  - id: auth-middleware
    task: |
      Create requireAuth middleware.
      Extract JWT from Authorization: Bearer <token> header.
      Verify token, attach user to request.
      Return 401 if missing/invalid.
    depends_on: [user-model]

  - id: protect-routes
    task: |
      Add requireAuth middleware to all existing routes except:
      - GET /health
      - POST /auth/register  
      - POST /auth/login
    depends_on: [auth-routes, auth-middleware]

  - id: auth-tests
    task: |
      Write integration tests for the auth system:
      - Register with valid data → 201 + JWT
      - Register with duplicate email → 409
      - Login with valid creds → 200 + JWT
      - Login with wrong password → 401
      - Access protected route with valid JWT → 200
      - Access protected route without JWT → 401
      - Access protected route with expired JWT → 401
    depends_on: [protect-routes]
```

### Research: Competitive Analysis (Fan-out + Merge)

```yaml
name: competitive-analysis
defaults:
  workflow: research
  agent: codex

nodes:
  - id: datadog-research
    task: "Research Datadog: pricing, features, market position, recent changes, customer sentiment."

  - id: grafana-research
    task: "Research Grafana Cloud: pricing, features, market position, recent changes, customer sentiment."

  - id: newrelic-research
    task: "Research New Relic: pricing, features, market position, recent changes, customer sentiment."

  - id: synthesis
    task: |
      Synthesize the three research reports into a competitive analysis.
      Include: feature comparison table, pricing comparison, strengths/weaknesses,
      recommendation for a startup with 50 engineers.
    workflow: content
    depends_on: [datadog-research, grafana-research, newrelic-research]
```

### Data: ETL Pipeline

```yaml
name: sales-etl
defaults:
  workflow: data
  agent: codex

nodes:
  - id: clean
    task: "Clean sales-raw.csv: remove duplicates, fix date formats, handle nulls."
    input: [./data/sales-raw.csv]

  - id: enrich
    task: "Enrich the cleaned data: add region from zip code, calculate total per order."
    depends_on: [clean]

  - id: aggregate
    task: "Produce summary stats: revenue by region, top 10 products, monthly trend."
    depends_on: [enrich]

  - id: visualize
    task: "Create matplotlib charts: revenue trend, regional breakdown pie, top products bar."
    depends_on: [aggregate]

  - id: report
    task: "Write a markdown executive summary with embedded chart references."
    workflow: content
    depends_on: [aggregate, visualize]
```

---

## Key Design Decisions

1. **Pipelines are YAML, not UI-first.** Developers define DAGs in version-controlled YAML files. The dashboard visualizes them, but the source of truth is the file. This keeps it composable, diffable, and automatable.

2. **Each node is a full forgectl run.** No new execution model. The pipeline executor calls the same `executeRun()` that `forgectl run` uses. All validation, output collection, and review modes work unchanged per-node.

3. **Git branches are the piping mechanism for code workflows.** Downstream nodes start from upstream branches. Fan-in merges branches. This is natural for code — it's how real teams work with git.

4. **Checkpoints enable revert without re-execution.** If task7 fails, you don't re-run tasks 1-6. You resume from the last good checkpoint. This saves time and API costs.

5. **Independent nodes run in parallel.** If task4, task5, task6 have no dependencies on each other, they run simultaneously (up to `max_parallel`). This is the main speed advantage of DAGs over sequential execution.

6. **Merge conflicts are failures, not magic.** When fan-in branches conflict, the default is to fail with a clear error. Auto-resolution by an agent is a stretch goal, not a v2 requirement.

7. **The pipeline executor is the only new major component.** Everything else (workflows, containers, agents, validation, output) is reused from v1. The pipeline layer is an orchestration wrapper, not a rewrite.

8. **Single runs still work.** `forgectl run --task "..."` is unchanged. Pipelines are additive. You don't need a pipeline for a one-off task.

9. **Dashboard shows DAGs.** The existing dashboard is updated to visualize pipeline DAGs with per-node status. Click a node to see its run details. This replaces the simple run list for pipeline executions.

10. **No external UI framework.** The dashboard remains a single HTML file with React CDN. No Ideon, no Vite, no external canvas library. Terminal visualization via `forgectl pipeline show` is the primary interface.

---

## Technology Stack (v2)

| Concern | Choice |
|---------|--------|
| Language | TypeScript (Node.js 20+) |
| CLI | commander |
| Config + Pipeline schema | js-yaml + zod |
| Docker | dockerode |
| HTTP server | fastify |
| DAG execution | Custom (topological sort + Promise-based parallelism) |
| Dashboard | Single-file React + Tailwind CDN |
| Terminal DAG viz | Custom (chalk + box-drawing chars) |
| Checkpoints | Local filesystem (JSON + git bundles) |
| Browser automation | browser-use (Python, in research Dockerfile) |
| Testing | vitest |
| Build | tsup |
