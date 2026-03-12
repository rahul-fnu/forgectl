# Architecture Research

**Domain:** Multi-agent delegation, conditional/loop pipeline execution, pipeline self-correction
**Researched:** 2026-03-12
**Confidence:** HIGH (based on direct codebase analysis of v2.0 source)

---

## Standard Architecture

### System Overview: Existing v2.0 Baseline

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLI / Daemon Layer                            │
│  ┌──────────┐  ┌───────────────┐  ┌─────────────┐  ┌────────────┐   │
│  │ forgectl │  │ forgectl      │  │ forgectl    │  │ Fastify    │   │
│  │ run      │  │ pipeline      │  │ orchestrate │  │ /api/v1/   │   │
│  └────┬─────┘  └──────┬────────┘  └──────┬──────┘  └─────┬──────┘   │
├───────┴───────────────┴──────────────────┴───────────────┴───────────┤
│                      Execution Layer                                  │
│  ┌─────────────────┐          ┌──────────────────────────────────┐    │
│  │ PipelineExecutor│          │ Orchestrator (scheduler+dispatch) │    │
│  │ static DAG only │          │ claim→run→validate→comment→retry │    │
│  └────────┬────────┘          └────────────────┬─────────────────┘    │
│           └────────────────┬───────────────────┘                      │
│                            ▼                                          │
│              ┌────────────────────────┐                               │
│              │     executeWorker()    │                               │
│              │  (orchestrator/worker) │                               │
│              └────────────┬───────────┘                               │
├───────────────────────────┴───────────────────────────────────────────┤
│                      Agent / Container Layer                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────┐   │
│  │ OneShotSess│  │AppServerSess │  │BrowserUseSe │  │ Validation │   │
│  │ (claude/   │  │(codex        │  │(python http │  │ retry loop │   │
│  │  codex)    │  │ persistent)  │  │ sidecar)    │  │ (existing) │   │
│  └────────────┘  └──────────────┘  └─────────────┘  └────────────┘   │
├───────────────────────────────────────────────────────────────────────┤
│                      Persistence Layer (SQLite)                       │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │ runs     │  │pipeline_   │  │ run_events   │  │ execution_    │   │
│  │ table    │  │ runs table │  │ (flight rec) │  │ locks table   │   │
│  └──────────┘  └────────────┘  └──────────────┘  └───────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities (Existing v2.0)

| Component | Responsibility | Key File |
|-----------|---------------|----------|
| PipelineExecutor | Static DAG scheduling, parallel execution, fan-in merge, checkpoint/resume | `src/pipeline/executor.ts` |
| Orchestrator | Polling loop, candidate selection, concurrency slots, stall detection | `src/orchestrator/index.ts` |
| Dispatcher | Issue claim, pre-approval gate, GitHubDeps construction, retry scheduling | `src/orchestrator/dispatcher.ts` |
| executeWorker | Agent invocation, validation loop, git output, post-approval gate | `src/orchestrator/worker.ts` |
| SlotManager | Concurrency cap for simultaneous workers | `src/orchestrator/state.ts` |
| ValidationRunner | Step execution, error feedback, agent re-invocation loop | `src/validation/runner.ts` |
| OrchestratorState | In-memory claimed/running/retry maps | `src/orchestrator/state.ts` |
| RunRepository | SQLite runs table: status, pause, approval, github comment id | `src/storage/repositories/runs.ts` |
| FlightRecorder | Append-only event log, state snapshots | `src/flight-recorder/` |
| GovernanceSystem | Autonomy levels, pre/post approval gates, auto-approve rules | `src/governance/` |

---

## Target Architecture: v2.1 Autonomous Factory

### System Overview with New Features

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLI / Daemon Layer (unchanged)                │
├──────────────────────────────────────────────────────────────────────┤
│                      Execution Layer                                  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                 PipelineExecutor (EXTENDED)                   │    │
│  │  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐  │    │
│  │  │ Conditional  │  │  Loop Node     │  │ Self-Correction  │  │    │
│  │  │ Node Handler │  │  Handler       │  │ (composes loop + │  │    │
│  │  │ (if/else)    │  │ (loop-until)   │  │  existing valid) │  │    │
│  │  └──────────────┘  └────────────────┘  └──────────────────┘  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                  Orchestrator (EXTENDED)                      │    │
│  │  ┌───────────────────────────────────────────────────────┐   │    │
│  │  │              DelegationManager (NEW)                  │   │    │
│  │  │  lead agent → manifest parse → child budget check     │   │    │
│  │  │  → child dispatch (depth=1) → result aggregation      │   │    │
│  │  └───────────────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│              ┌────────────────────────────────────────┐              │
│              │     executeWorker() (EXTENDED)          │              │
│              │  + delegation output parsing            │              │
│              │  + child dispatch trigger               │              │
│              └────────────────────────────────────────┘              │
├──────────────────────────────────────────────────────────────────────┤
│                      Persistence Layer (EXTENDED)                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐   │
│  │ runs         │  │ delegations      │  │ pipeline_runs         │   │
│  │ (+ parentId, │  │ (NEW table:      │  │ (node states extended │   │
│  │  role, depth)│  │  parent/child    │  │  with type/condition/ │   │
│  │              │  │  relationships)  │  │  loop fields)         │   │
│  └──────────────┘  └──────────────────┘  └───────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## New Components and Integration Points

### 1. Multi-Agent Delegation

**New component:** `src/orchestrator/delegation.ts`

The lead agent completes its run and produces a structured delegation manifest embedded in its output (a JSON block in stdout). The delegation manager parses this, validates the child budget, and dispatches child workers via the existing `dispatchIssue()` path with a depth parameter.

**Data flow:**

```
Parent issue dispatched (depth=0)
    ↓
executeWorkerAndHandle()
    ↓ lead agent runs, produces structured output
executeWorker() returns WorkerResult
    ↓ stdout parsed for delegation manifest JSON
DelegationManager.parseDelegationManifest(stdout)
    ↓ validates structure with Zod
DelegationManager.delegateSubtasks(manifest, {parentRunId, maxChildren, depth=0})
    ↓ for each subtask (up to maxChildren budget):
    │   dispatchIssue(syntheticIssue, depth=1)
    │   child runs in isolation (depth cap blocks further delegation)
    │   each child: executeWorker() -> validate -> output
    ↓
DelegationManager.waitForChildren(parentRunId)
    ↓ polls delegations table for child run completion
Aggregated result posted to parent issue as GitHub comment
```

**New SQLite table: `delegations`**

```
id          text PRIMARY KEY
parent_run  text REFERENCES runs(id)
child_run   text REFERENCES runs(id)
depth       integer NOT NULL
status      text NOT NULL  -- pending | running | completed | failed
subtask     text NOT NULL  -- the delegated task description
created_at  text NOT NULL
```

**Columns added to existing `runs` table:**

```
parent_run_id  text     -- NULL for top-level runs
role           text     -- "lead" | "worker" | NULL for non-delegation runs
depth          integer  -- 0 for lead, 1 for direct children
```

**Integration points — code that changes:**

| File | Type | Change |
|------|------|--------|
| `src/orchestrator/delegation.ts` | NEW | `DelegationManifest` type, `parseDelegationManifest()`, `delegateSubtasks()`, `waitForChildren()` |
| `src/orchestrator/worker.ts` | MODIFIED | `executeWorker()` gains optional `delegationOpts?: DelegationOpts` param; after agent completes, calls `parseDelegationManifest` on stdout before returning |
| `src/orchestrator/dispatcher.ts` | MODIFIED | `dispatchIssue()` gains `depth?: number` param; if `depth >= 2`, throws rather than dispatching |
| `src/orchestrator/state.ts` | MODIFIED | `WorkerInfo` gains `delegatedChildren?: string[]` |
| `src/storage/schema.ts` | MODIFIED | Add `delegations` table; add `parentRunId`, `role`, `depth` columns to `runs` |
| `src/storage/repositories/runs.ts` | MODIFIED | Add `setParent(runId, parentId, depth)`, `getChildren(parentId)` methods |
| `src/storage/repositories/delegations.ts` | NEW | CRUD for delegations table |
| `src/workflow/types.ts` | MODIFIED | Add `delegation` section to `WorkflowFileConfig` |
| `src/config/schema.ts` | MODIFIED | Add `delegation` Zod schema block |
| `src/storage/migrator.ts` | MODIFIED | Migration for delegations table and runs columns |

**New WORKFLOW.md `delegation:` block:**

```yaml
delegation:
  enabled: true
  max_children: 5       # budget per issue (hard cap)
  child_workflow: code  # which workflow subtasks use
  child_agent: claude-code
```

**Delegation manifest format (produced by lead agent in stdout):**

```json
---DELEGATE---
{
  "subtasks": [
    {
      "task": "Write unit tests for the auth module",
      "workflow": "code",
      "context": "Focus on edge cases in token expiry"
    },
    {
      "task": "Update the README with new API endpoints",
      "workflow": "content"
    }
  ]
}
---END-DELEGATE---
```

The manifest parser looks for this sentinel-delimited block in agent stdout. If parsing fails (invalid JSON, schema mismatch), delegation is skipped and the parent completes normally.

**Depth enforcement:** `dispatchIssue()` checks `depth >= 2` before proceeding. Children at depth=1 receive a system prompt addendum: "You are a worker agent. Do not delegate further." The `DelegationOpts.currentDepth` field blocks `parseDelegationManifest` from being called inside child `executeWorker()` calls.

**Child isolation:** Children are dispatched as synthetic `TrackerIssue` objects constructed in memory — not fetched from GitHub or Notion. They share the parent's workspace commit (cloned branch) but each gets its own Docker container. The `delegations` table is the authoritative parent/child relationship store.

---

### 2. Conditional Pipeline Nodes

**Extended component:** `src/pipeline/types.ts`, `src/pipeline/executor.ts`

The DAG currently handles only `task` nodes with static `depends_on`. Conditional nodes add a `node_type` discriminant and two new optional field groups: `condition` for if/else branching and `loop` for loop-until iteration.

**Extended `PipelineNode` interface (additions to existing):**

```typescript
interface PipelineNode {
  id: string;
  node_type?: "task" | "condition" | "loop";  // NEW — default "task"
  task: string;
  depends_on?: string[];
  // ... all existing fields unchanged ...

  // NEW: conditional branching (only for node_type: "condition")
  condition?: {
    expression: string;      // evaluated against upstream NodeExecution state
    if_branch: string;       // node ID to execute when expression is true
    else_branch?: string;    // node ID to execute when false (optional)
  };

  // NEW: loop-until (only for node_type: "loop")
  loop?: {
    body: string;            // node ID to loop
    until: string;           // expression evaluated against body NodeExecution result
    max_iterations: number;  // safety cap (required, no default)
  };
}
```

**Condition expression language:** Deliberately minimal. Supported forms only:

- `"{{node_id.validation.passed}}"` — boolean field from upstream NodeExecution.result.validation
- `"{{node_id.output.files_changed}} > 0"` — numeric comparison against output field
- `"{{node_id.status}} == 'completed'"` — string equality against node status

No arithmetic, no logic operators (`&&`, `||`), no function calls. Implemented in `src/pipeline/condition.ts` using simple regex-based extraction, not an expression parser library. This keeps the evaluator auditable in under 100 lines.

**Executor dispatch in `executeNode()` (existing method, new dispatch logic):**

```typescript
private async executeNode(node: PipelineNode): Promise<void> {
  switch (node.node_type ?? "task") {
    case "condition": return this.executeConditionalNode(node);
    case "loop":      return this.executeLoopNode(node);
    default:          return this.executeTaskNode(node);  // existing logic
  }
}
```

**`executeConditionalNode` behavior:**

1. Reads upstream `NodeExecution` state for nodes referenced in `condition.expression`
2. Evaluates the expression via `condition.ts`
3. If true: executes `condition.if_branch`, marks `condition.else_branch` as `skipped`
4. If false: executes `condition.else_branch` (if defined), marks `condition.if_branch` as `skipped`
5. The conditional node itself is marked `completed` after the taken branch finishes

**`executeLoopNode` behavior:**

1. Runs the body node (resets body node state to `pending` each iteration)
2. After each body execution, evaluates `loop.until` expression against body result
3. If until is true: exits loop, loop node result = last body result
4. If until is false and `iteration < max_iterations`: resets body state, repeats
5. If `max_iterations` reached: loop node marked `failed`, error logged

**DAG validity with conditional nodes:** Conditional and loop body nodes are regular nodes in the YAML. They `depends_on` the conditional/loop node that governs them. The DAG is still acyclic — `validateDAG` validates branch node references exist. `topologicalSort` includes all nodes in the static order; the executor skips non-taken branches.

**Integration points — code that changes:**

| File | Type | Change |
|------|------|--------|
| `src/pipeline/condition.ts` | NEW | Expression evaluator for `{{node.field}} op value` patterns |
| `src/pipeline/types.ts` | MODIFIED | Add `node_type`, `condition`, `loop` to `PipelineNode` |
| `src/pipeline/dag.ts` | MODIFIED | `validateDAG` checks that `condition.if_branch`, `condition.else_branch`, `loop.body` reference valid node IDs |
| `src/pipeline/executor.ts` | MODIFIED | Add `executeConditionalNode()`, `executeLoopNode()`, dispatch in `executeNode()` |
| `src/pipeline/parser.ts` | MODIFIED | Add Zod schema for new node fields |

---

### 3. Pipeline Self-Correction

Self-correction is a composition pattern — it requires no new subsystems. It combines the extended loop node (Feature 2) with the existing context pipe mechanism and existing `ValidationResult` fields on `NodeExecution.result`.

**Pattern: test-fail → fix-agent → retest**

```yaml
nodes:
  - id: implement
    task: "Implement the feature per the spec"

  - id: test_run
    task: "Run the test suite and capture output"
    depends_on: [implement]

  - id: self_correct
    node_type: loop
    task: "Fix failing tests"
    depends_on: [test_run]
    loop:
      body: fix_agent
      until: "{{test_run.validation.passed}}"
      max_iterations: 3

  - id: fix_agent
    task: "Analyze test failures and fix the code to make them pass"
    depends_on: [self_correct]
    context: [test_run]   # pipes test_run output as agent context
```

**Why this works without new code:**

- `loop.until: "{{test_run.validation.passed}}"` reads from `NodeExecution.result.validation.passed` — a field that already exists in `ExecutionResult` via `ValidationResult`
- The context pipe `context: [test_run]` already works in the existing executor (context resolution from upstream node output)
- Each loop iteration re-runs `fix_agent` with fresh test failure context
- The loop node exits when validation passes or max iterations are hit

**Relationship to existing `runValidationLoop`:** The existing `runValidationLoop` in `src/validation/runner.ts` handles single-agent fix-retry within one run (agent fails, feed error, retry same agent). Self-correction at the pipeline level adds cross-node retry where a _separate_ fix agent node can use different instructions, a different model, or a different workflow than the implementing agent.

**No new files needed for self-correction.** It is documentation, pipeline YAML patterns, and integration tests only.

---

## Integration Points: New vs Modified Summary

| File | Status | Summary of Change |
|------|--------|-------------------|
| `src/orchestrator/delegation.ts` | NEW | DelegationManifest Zod schema, manifest parser, delegateSubtasks(), waitForChildren(), DelegationOpts type |
| `src/pipeline/condition.ts` | NEW | Expression evaluator for conditional/loop node expressions |
| `src/storage/repositories/delegations.ts` | NEW | CRUD for delegations table |
| `src/pipeline/types.ts` | MODIFIED | Add `node_type`, `condition`, `loop` optional fields to `PipelineNode` |
| `src/pipeline/dag.ts` | MODIFIED | Validate branch/body node ID references in conditional and loop nodes |
| `src/pipeline/executor.ts` | MODIFIED | Add `executeConditionalNode()`, `executeLoopNode()`, type dispatch in `executeNode()` |
| `src/pipeline/parser.ts` | MODIFIED | Add Zod validation for new node fields |
| `src/orchestrator/worker.ts` | MODIFIED | Parse delegation manifest from agent stdout; accept optional `DelegationOpts` param |
| `src/orchestrator/dispatcher.ts` | MODIFIED | Accept `depth` param; enforce `depth >= 2` cap; propagate `parentRunId` |
| `src/orchestrator/state.ts` | MODIFIED | Add `delegatedChildren?: string[]` to `WorkerInfo` |
| `src/storage/schema.ts` | MODIFIED | Add `delegations` table definition; add `parentRunId`, `role`, `depth` to `runs` |
| `src/storage/repositories/runs.ts` | MODIFIED | Add `setParent()`, `getChildren()`, `getByRole()` methods |
| `src/workflow/types.ts` | MODIFIED | Add `delegation` section to `WorkflowFileConfig` |
| `src/config/schema.ts` | MODIFIED | Add `delegation` Zod schema |
| `src/storage/migrator.ts` | MODIFIED | Migration for delegations table and runs columns |

---

## Data Flows

### Multi-Agent Delegation Flow

```
Scheduler polls → finds issue with delegation-enabled workflow
    ↓
Dispatcher.dispatchIssue(issue, depth=0)
    ↓
executeWorkerAndHandle()
    ↓ lead agent prompt includes delegation instructions
executeWorker(issue, ..., delegationOpts={depth=0, maxChildren=5})
    ↓ agent runs, writes ---DELEGATE--- block in stdout
parseDelegationManifest(stdout) → DelegationManifest
    ↓ validated with Zod; returns null if missing/invalid
delegateSubtasks(manifest, {parentRunId, maxChildren=5, depth=0})
    ↓ inserts delegation rows (status=pending)
    │ for each subtask (up to budget):
    │   construct synthetic TrackerIssue
    │   dispatchIssue(syntheticIssue, depth=1)  ← depth cap enforced here
    │   child: executeWorker() → validate → output
    │   delegation row updated: status=completed|failed
    ↓
waitForChildren(parentRunId)
    ↓ polls delegations table until all rows terminal
aggregateChildResults([...]) → summary comment
    ↓
parent issue updated with child summary via tracker.postComment()
```

### Conditional Pipeline Node Flow

```
PipelineExecutor.execute()
    ↓ topologicalSort includes condition node in order
executeNode(conditionNode) → dispatches to executeConditionalNode()
    ↓
evaluateCondition(conditionNode.condition.expression, nodeStates)
    ↓ reads upstream NodeExecution result fields
    ↓ returns boolean
if true:
    executeNode(if_branch_node)
    nodeStates.set(else_branch_id, { status: "skipped", ... })
if false:
    executeNode(else_branch_node)  // if defined
    nodeStates.set(if_branch_id, { status: "skipped", ... })
    ↓
conditionNode.status = "completed"
Downstream nodes see the completed branch output normally
```

### Loop Node Flow

```
PipelineExecutor.execute()
    ↓ executeNode(loopNode) → dispatches to executeLoopNode()
iteration = 0
while iteration < max_iterations:
    nodeStates.set(bodyId, { status: "pending" })  // reset
    await executeNode(bodyNode)                     // run body
    bodyResult = nodeStates.get(bodyId)
    if evaluateCondition(loopNode.loop.until, { [bodyId]: bodyResult }):
        break  // exit condition met
    iteration++
loopNode.result = lastBodyResult
loopNode.status = (exitConditionMet ? "completed" : "failed")
```

---

## Architectural Patterns

### Pattern 1: Depth Guard for Delegation

**What:** A numeric `depth` parameter propagates through `dispatchIssue()`. When `depth >= 2`, dispatch is refused immediately — no worker spawned, error returned, parent sees failed delegation entry.

**When to use:** Every call to `dispatchIssue()` that originates from a delegation manager.

**Trade-offs:** Simple and cheap to enforce at the boundary. Does not prevent a single depth=1 agent from spawning many parallel children — that is controlled separately by `maxChildren` budget. The guard must live at `dispatchIssue()`, not in the delegation manager, so it is enforced regardless of how dispatch is triggered.

### Pattern 2: Manifest-Based Delegation Protocol

**What:** The lead agent communicates delegation intent through a sentinel-delimited JSON block in its stdout. The manifest is parsed and validated by Zod after the agent completes. Invalid or missing manifests are silently ignored (no delegation, not an error).

**When to use:** Any lead agent that needs to decompose work and delegate subtasks.

**Trade-offs:** Requires the agent system prompt to include delegation format instructions. Parsing is tolerant (best-effort). The sentinel approach (`---DELEGATE---`) is robust to agents that produce explanation text alongside the JSON.

### Pattern 3: Static DAG with Dynamic Branch Skipping

**What:** Conditional nodes do not add or remove DAG nodes at runtime. All possible branches are defined statically in the pipeline YAML. The executor marks the non-taken branch as `skipped` rather than removing it.

**When to use:** All conditional pipeline logic.

**Trade-offs:** YAML must declare all branches even if some are rarely taken. The benefit is that DAG validation, checkpoint/resume, and visualization all work without modification — they see a static structure.

### Pattern 4: In-Place Loop with State Reset

**What:** The loop body is a single node ID. At the start of each iteration, that node's `NodeExecution` state is reset to `pending`. The loop node owns the iteration counter and exit condition evaluation. Only the final iteration's output is checkpointed.

**When to use:** Self-correction loops, retry-until patterns within a pipeline.

**Trade-offs:** Intermediate iteration outputs are not individually checkpointed. On daemon crash mid-loop, the loop restarts from the beginning of the incomplete iteration. Acceptable for `max_iterations <= 5`. If per-iteration durability is needed later, each iteration would need a unique ephemeral node ID — not in scope for v2.1.

### Pattern 5: Synthetic Issue for Child Delegation

**What:** Child agents receive a `TrackerIssue` object constructed in memory by the delegation manager. The synthetic issue is never written to GitHub or Notion.

**When to use:** All delegated subtasks from a lead agent.

**Trade-offs:** No tracker visibility for subtasks by design — the tracker stays clean. The `delegations` table provides in-app visibility. The GitHub App can post a summary comment on the parent issue listing child outcomes. If tracker visibility of subtasks becomes a requirement later, the delegation manager can optionally create child tracker issues.

---

## Anti-Patterns

### Anti-Pattern 1: Dynamic Node Creation at Runtime

**What people do:** Generate new pipeline nodes mid-execution based on agent output, add them to a running DAG.

**Why it's wrong:** Breaks DAG validation (cannot validate runtime-created nodes), breaks checkpoint/resume (checkpoints reference node IDs by name), breaks visualization.

**Do this instead:** Define all possible nodes statically in YAML. Use conditional skip to avoid executing unnecessary branches. Delegation handles dynamic work decomposition at the orchestrator level — not inside the pipeline executor.

### Anti-Pattern 2: Unbounded Delegation Recursion

**What people do:** Allow lead agents to delegate without a depth limit. A child agent decides it also needs to delegate.

**Why it's wrong:** Exponential container proliferation. SQLite slot contention. Runaway cost. Hard to debug.

**Do this instead:** Enforce `depth <= 2` as a hard boundary at `dispatchIssue()`. Children at depth=1 are given system prompt instructions not to delegate further. The `DelegationOpts.currentDepth` field prevents `parseDelegationManifest` from being called inside depth=1 `executeWorker()` calls.

### Anti-Pattern 3: Concurrent Parent and Child Container Access to Same Workspace

**What people do:** Mount the parent agent's workspace inside a child agent container while the parent is still running.

**Why it's wrong:** The `execution_locks` table enforces at-most-one active container per workspace. Parent and children attempting concurrent access deadlock.

**Do this instead:** The delegation manager only dispatches children after `executeWorker()` returns (parent agent has completed and released its container). Children get their own workspaces, cloned from the parent's committed branch or output directory.

### Anti-Pattern 4: Expression Language Creep in Condition Evaluator

**What people do:** Start with simple comparisons, add arithmetic operators, string functions, external calls. The condition evaluator becomes a mini scripting language.

**Why it's wrong:** Security surface (user-provided expressions execute in daemon process). Maintenance burden. Test complexity grows quadratically.

**Do this instead:** Support exactly three expression forms, document them explicitly, and refuse to add more without a forcing function. The evaluator should be under 100 lines and have 100% test coverage by construction.

### Anti-Pattern 5: Blocking the Dispatcher Thread on Child Completion

**What people do:** `dispatchIssue()` awaits all child runs synchronously before returning.

**Why it's wrong:** The dispatcher is fire-and-forget by design. Blocking it prevents the scheduler from processing other issues during the delegation wait period.

**Do this instead:** `delegateSubtasks()` dispatches children and returns child run IDs. `waitForChildren()` polls the `delegations` table asynchronously (not blocking the scheduler event loop). The parent issue stays in the `running` state in the orchestrator until the wait completes.

---

## Recommended Project Structure Changes

```
src/
├── orchestrator/
│   ├── delegation.ts          # NEW — DelegationManifest, delegateSubtasks, waitForChildren
│   ├── dispatcher.ts          # MODIFIED — depth param, parentRunId propagation
│   ├── worker.ts              # MODIFIED — delegation output parsing
│   └── state.ts               # MODIFIED — delegatedChildren in WorkerInfo
│
├── pipeline/
│   ├── condition.ts           # NEW — expression evaluator (< 100 lines)
│   ├── executor.ts            # MODIFIED — conditional/loop dispatch in executeNode()
│   ├── types.ts               # MODIFIED — node_type, condition, loop fields
│   ├── dag.ts                 # MODIFIED — validate branch/body node references
│   └── parser.ts              # MODIFIED — Zod schema for new fields
│
└── storage/
    ├── schema.ts              # MODIFIED — delegations table, runs column additions
    └── repositories/
        ├── delegations.ts     # NEW — delegation CRUD
        └── runs.ts            # MODIFIED — parent/child/role query methods
```

---

## Build Order

Dependencies between the three features:

```
Schema + migration (no deps)
    ↓
Conditional pipeline nodes (depends on: nothing new, self-contained pipeline change)
    ↓
Loop pipeline nodes (depends on: conditional type dispatch infrastructure)
    ↓
Self-correction validation (depends on: loop nodes — zero new code, integration tests only)

Delegation manager (depends on: schema migration)
    ↓
Delegation wiring (depends on: delegation manager)
    ↓
WORKFLOW.md delegation config (depends on: delegation wiring)
```

**Recommended phase order:**

1. **Schema + migration** — Add `delegations` table, `parentRunId/role/depth` to `runs`. No functional change. All other work depends on this.

2. **Conditional pipeline nodes** — Extend `PipelineNode` type, condition evaluator, `executeConditionalNode`. Self-contained pipeline subsystem change. Testable with unit tests against mock `NodeExecution` states.

3. **Loop pipeline nodes** — Extend executor with `executeLoopNode`. Builds on the type dispatch from step 2.

4. **Self-correction integration tests** — Prove test-fail→fix→retest works using loop nodes. No new code — validates the composition pattern with real agent mocks.

5. **Delegation manager** — New `src/orchestrator/delegation.ts`, manifest parsing with Zod, budget enforcement, child dispatch. Requires schema from step 1.

6. **Delegation wiring** — Modify `executeWorker()` to call manifest parser; modify `dispatchIssue()` to accept depth/parentRunId; wire `DelegationRepository`.

7. **WORKFLOW.md delegation config** — Add `delegation:` block to `WorkflowFileConfig` Zod schema, update config merger, update hot-reload watcher.

8. **End-to-end tests** — Delegation with mock agents, conditional pipeline integration tests.

---

## Scaling Considerations

All three features run within the existing single-machine, single-daemon model. No new scaling dimension is introduced.

| Concern | With New Features | Mitigation |
|---------|-------------------|------------|
| Container count | `maxChildren` multiplies active containers per issue | Slot manager already caps total concurrent workers; children compete for the same global pool |
| SQLite write contention | More rows per parent issue (1 lead + N children) | WAL mode handles this; delegation table writes are low-frequency |
| Loop iteration cost | Each iteration is a full agent invocation (minutes, dollars) | `max_iterations` required in YAML (no default); loop timeout inherits from agent timeout config |
| OrchestratorState memory | `delegatedChildren` adds at most `maxChildren` strings per WorkerInfo | Negligible |
| Condition evaluator safety | User-controlled expressions execute in daemon process | Restrict to three known-safe expression forms; no eval(), no function calls |

---

## Sources

- Direct codebase analysis: `src/orchestrator/worker.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/state.ts` (v2.0, 2026-03-12)
- Direct codebase analysis: `src/pipeline/executor.ts`, `src/pipeline/dag.ts`, `src/pipeline/types.ts` (v2.0, 2026-03-12)
- Direct codebase analysis: `src/validation/runner.ts`, `src/agent/session.ts`, `src/governance/types.ts` (v2.0, 2026-03-12)
- Direct codebase analysis: `src/storage/schema.ts`, `src/workflow/types.ts`, `src/tracker/types.ts` (v2.0, 2026-03-12)
- PROJECT.md: v2.1 Autonomous Factory feature targets and constraints (2026-03-12)

---

*Architecture research for: forgectl v2.1 multi-agent delegation, conditional/loop pipelines, self-correction*
*Researched: 2026-03-12*
