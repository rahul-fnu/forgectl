# Phase 22: Loop Pipeline Nodes - Research

**Researched:** 2026-03-13
**Domain:** Pipeline executor extension — loop-until iteration with safety cap, per-iteration checkpointing, crash recovery, and API observability
**Confidence:** HIGH

## Summary

Phase 22 adds loop-until iteration to the pipeline system. The schema, type stubs, and DAG groundwork were laid in Phase 20. Phase 21 delivered the filtrex evaluator and the ready-queue executor that loop nodes will sit inside. This phase wires them together: a loop node occupies one executor slot, runs its body repeatedly until an `until` expression becomes true or `max_iterations` is exhausted, saves a per-iteration checkpoint after each iteration, and surfaces progress via `NodeExecution.loopState`.

The scope is intentionally narrow. All required infrastructure already exists: `PipelineNode.loop` is parsed by the Zod schema, `evaluateCondition()` works for arbitrary filtrex expressions, `saveCheckpoint()` / `loadCheckpoint()` are in place, and `GET /pipelines/:id` already serializes `NodeExecution` to JSON. The work is almost entirely inside `executeNode()` in `src/pipeline/executor.ts`, with targeted extensions to three adjacent files.

**Primary recommendation:** Implement loop logic as a new private method `executeLoopNode()` called from `processNode()` when `node.loop !== undefined`, keeping `executeNode()` as the single-iteration body runner. This keeps separation of concerns clean and makes the iteration loop testable in isolation.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Loop body failure behavior**
- Failure is an iteration result, not a loop termination event — the loop records the failure, increments the iteration counter, and re-evaluates the `until` expression
- The `until` expression decides when to stop, not individual iteration outcomes
- Loop only fails when `max_iterations` is exhausted without `until` becoming true
- When `max_iterations` is exhausted, the loop node status is always `"failed"` with error message naming the node and iteration count (regardless of last iteration's result)
- Each iteration's output (stdout/stderr) is automatically piped as progressive context to the next iteration — all previous outputs accumulate (not just the most recent)

**Until expression context**
- `until` expressions have access to both upstream node statuses and loop-specific variables
- Upstream node statuses: same as condition expressions (`"completed"`, `"failed"`, `"skipped"`)
- Loop-specific variables injected into context:
  - `_status` — current iteration's result: `"completed"` or `"failed"`
  - `_iteration` — current 1-based iteration count
  - `_max_iterations` — the configured max_iterations value
  - `_first_iteration` — boolean, true only on iteration 1
- Unknown/unresolvable variable names are fatal errors (consistent with Phase 21 conditions)
- Uses the same filtrex evaluator as condition expressions

**Safety cap**
- Global hard cap: `GLOBAL_MAX_ITERATIONS = 50` (enforced in code, YAML cannot exceed)
- When YAML specifies `max_iterations` above the cap: warn and clamp (log message stating the override, proceed with capped value)
- Default `max_iterations` when YAML omits the field: `10`
- Safety cap check happens **before** evaluating the `until` expression (per LOOP-03)

**Iteration history and observability**
- Full iteration history retained in `NodeExecution.loopState` — array of per-iteration records (iteration number, status, startedAt, completedAt)
- Active loop nodes show status `"loop-iterating"` in the API (distinct from `"running"`) with `currentIteration` and `maxIterations` in `loopState`
- Per-iteration checkpoint saved after each iteration completes — checkpoint file overwritten in place (single file per loop node, updated each iteration)
- On crash recovery: resume from last completed iteration's checkpoint, re-run the next iteration (not from iteration 0)

### Claude's Discretion
- Exact `loopState` TypeScript interface shape within `NodeExecution`
- How progressive context is formatted in the agent prompt (markdown, numbered list, etc.)
- Checkpoint file internal structure beyond the required fields
- How `_first_iteration` boolean is represented in filtrex context (1/0 vs true/false)
- DAG validation extensions for loop node semantics
- Dry-run annotation format for loop nodes

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LOOP-01 | PipelineNode supports `loop` field with `until` expression and `max_iterations` | Schema already defined in Phase 20 (parser.ts + types.ts). Needs runtime execution — `executeLoopNode()` method in executor.ts. |
| LOOP-02 | Loops modeled as opaque meta-nodes (no DAG back-edges, compatible with cycle detector) | No DAG changes needed. Loop body is internal iteration; no new edges are added to the adjacency map. The loop node is a single opaque node in the DAG. |
| LOOP-03 | Global max_iterations safety cap enforced regardless of YAML value | `GLOBAL_MAX_ITERATIONS = 50` constant; clamp logic runs before the first iteration. Cap check runs before `until` expression evaluation each iteration. |
| LOOP-04 | Loop iteration counter tracked in NodeExecution and exposed via REST API | Extend `NodeExecution` with `loopState` field. `getNodeStates()` already called by `getRun()` in pipeline-service.ts — loopState serializes automatically. Status `"loop-iterating"` added to NodeExecution.status union. |
| LOOP-05 | Per-iteration checkpoint for crash recovery mid-loop | `saveCheckpoint()` called after each iteration; loop checkpoint overwritten in-place (same path, single file per loop node). On recovery: `loadCheckpoint()` provides `lastCompletedIteration` — resume from iteration N+1. |
</phase_requirements>

---

## Standard Stack

### Core (all pre-installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| filtrex | ^3.1.0 | Evaluate `until` expressions | Already used for condition nodes (Phase 21). Same evaluator, same error types. |
| vitest | (project) | Test framework | Existing test suite pattern — all pipeline tests use vitest with vi.mock |
| chalk | (project) | Console output for iteration progress | Used throughout executor.ts for status output |

No new dependencies required for this phase.

## Architecture Patterns

### Recommended Change Structure
```
src/pipeline/
├── types.ts           # Add loopState field to NodeExecution; add LoopIterationRecord interface; add "loop-iterating" to status union
├── executor.ts        # Add executeLoopNode() private method; add loop detection in processNode(); add loop dry-run annotation in buildDryRunResult()
├── checkpoint.ts      # Add saveLoopCheckpoint() / loadLoopCheckpoint() for per-iteration overwrite semantics
└── condition.ts       # No changes — evaluateCondition() already supports arbitrary contexts

test/unit/
├── pipeline-loop.test.ts         # NEW: loop iteration, safety cap, exhaustion failure
└── pipeline-executor.test.ts     # Extend: loop node in processNode() flow
```

### Pattern 1: executeLoopNode() as separate private method
**What:** Split loop handling from single-node execution. `processNode()` detects `node.loop !== undefined` and calls `executeLoopNode(node)` instead of `executeNode(node)`.

**Why:** `executeNode()` is already 170 lines managing temp dirs, fan-in, checkpoints, events. Mixing iteration logic there would create a 300-line method. Separation enables isolated unit tests.

**Sketch:**
```typescript
// In processNode(), after condition check, before executeNode():
if (node.loop !== undefined) {
  await this.executeLoopNode(node);
  return;
}
await this.executeNode(node);
```

### Pattern 2: Loop state stored in NodeExecution (mutable during execution)
**What:** `NodeExecution.loopState` is set at the start of loop execution and updated in-place each iteration. Since `getNodeStates()` returns a snapshot Map, the live `nodeStates` Map holds the mutable state during execution.

**Why:** `getRun()` in pipeline-service.ts calls `executor.getNodeStates()` which already returns a live copy — loopState will appear in API responses without any route changes.

**loopState interface (recommended shape):**
```typescript
export interface LoopIterationRecord {
  iteration: number;         // 1-based
  status: "completed" | "failed";
  startedAt: string;         // ISO timestamp
  completedAt: string;       // ISO timestamp
}

export interface LoopState {
  currentIteration: number;  // 1-based; 0 before first iteration starts
  maxIterations: number;     // clamped value (after safety cap applied)
  iterations: LoopIterationRecord[];  // full history
}
```

Add to `NodeExecution`:
```typescript
loopState?: LoopState;
```

### Pattern 3: Safety cap enforcement order (LOOP-03 requirement)
**What:** Per the locked decision, safety cap check happens BEFORE evaluating the `until` expression each iteration.

**Correct loop structure:**
```typescript
private async executeLoopNode(node: PipelineNode): Promise<void> {
  const GLOBAL_MAX_ITERATIONS = 50;
  const configuredMax = node.loop!.max_iterations ?? 10;
  const maxIterations = Math.min(configuredMax, GLOBAL_MAX_ITERATIONS);

  if (configuredMax > GLOBAL_MAX_ITERATIONS) {
    // log warning: clamped from configuredMax to GLOBAL_MAX_ITERATIONS
  }

  // initialize loopState on nodeStates
  const state = this.nodeStates.get(node.id)!;
  state.status = "loop-iterating";
  state.loopState = { currentIteration: 0, maxIterations, iterations: [] };

  let iterationResult: "completed" | "failed" = "failed";

  for (let i = 1; i <= maxIterations; i++) {
    // STEP 1: Safety cap check (always before until evaluation)
    // Already enforced by loop bound — i <= maxIterations

    // STEP 2: Execute one iteration body (calls executeNode internally)
    iterationResult = await this.executeOneIteration(node, i, progressiveContext);

    // STEP 3: Update loopState
    state.loopState.currentIteration = i;
    state.loopState.iterations.push({ iteration: i, status: iterationResult, ... });

    // STEP 4: Save per-iteration checkpoint (overwrite in place)
    await saveLoopCheckpoint(this.pipelineRunId, node.id, i, state.loopState);

    // STEP 5: Evaluate until expression
    const untilCtx = buildUntilContext(node, i, maxIterations, iterationResult, deps);
    const done = evaluateCondition(node.loop!.until, untilCtx);
    if (done) {
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      return;
    }
  }

  // Exhausted — LOOP-03: fail with named message
  state.status = "failed";
  state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without until expression becoming true`;
  state.completedAt = new Date().toISOString();
}
```

### Pattern 4: Until expression context building
**What:** The `until` context merges upstream node statuses with loop-specific variables. The `_` prefix for loop variables avoids collisions with node IDs (node IDs must be `[a-z0-9-]+` per the Zod schema, so `_status` etc. cannot collide).

**filtrex boolean representation:** filtrex uses JavaScript-style truthiness. `_first_iteration` should be `1` (truthy) or `0` (falsy), not the TypeScript `true`/`false` booleans, because filtrex compares using `==` against string/number literals in expressions. Alternatively use `"true"/"false"` strings — but `1`/`0` is idiomatic for filtrex numeric contexts. This is Claude's discretion per CONTEXT.md.

```typescript
function buildUntilContext(
  node: PipelineNode,
  iteration: number,
  maxIterations: number,
  iterationStatus: "completed" | "failed",
  upstreamDeps: string[],
  nodeStates: Map<string, NodeExecution>,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  // Upstream node statuses (same as condition expressions)
  for (const dep of upstreamDeps) {
    const depState = nodeStates.get(dep);
    if (depState) ctx[dep] = depState.status;
  }
  // Loop-specific variables
  ctx["_status"] = iterationStatus;
  ctx["_iteration"] = iteration;
  ctx["_max_iterations"] = maxIterations;
  ctx["_first_iteration"] = iteration === 1 ? 1 : 0;
  return ctx;
}
```

**Important:** `evaluateCondition()` uses `customProp` to throw `ConditionVariableError` when a variable is not in the context. Unknown variables in `until` expressions must be fatal — this is already the behavior of `evaluateCondition()`. No changes to condition.ts needed.

### Pattern 5: Progressive context accumulation
**What:** Each iteration receives all previous iterations' output as context. This is formatted as text files passed to the agent via the existing `context` field in `CLIOptions`.

**Implementation:** Maintain a `progressiveContext: string[]` array (file paths) across iterations. After each iteration, append the iteration's output text to this list. Pass to `executeNode()` (or the inner `executeOneIteration()` call) as `cliOptions.context`.

**Format (Claude's discretion):** Recommended: write each iteration's output as a numbered markdown file, e.g., `iteration-01-output.md`, containing:
```
## Iteration 1 result: failed

[stdout/stderr content]
```

Files are written to a temp directory cleaned up after the loop node completes.

### Pattern 6: Per-iteration checkpoint (overwrite semantics)
**What:** Unlike regular node checkpoints (one file per node per pipeline run), loop checkpoints are overwritten each iteration. The single file at `~/.forgectl/checkpoints/{pipelineRunId}/{nodeId}/loop-checkpoint.json` is updated in-place.

**Why overwrite, not append:** Crash recovery only needs to resume from the LAST completed iteration. Appending full history on every iteration wastes disk. The `LoopState.iterations` array in the file still contains full history.

**New functions in checkpoint.ts:**
```typescript
export async function saveLoopCheckpoint(
  pipelineRunId: string,
  nodeId: string,
  lastCompletedIteration: number,
  loopState: LoopState,
): Promise<void>

export async function loadLoopCheckpoint(
  pipelineRunId: string,
  nodeId: string,
): Promise<{ lastCompletedIteration: number; loopState: LoopState } | null>
```

**File path:** `~/.forgectl/checkpoints/{pipelineRunId}/{nodeId}/loop-checkpoint.json`

### Pattern 7: Crash recovery integration
**What:** When the executor starts with `checkpointSourceRunId` set AND a loop node is encountered, check for a loop checkpoint and resume from `lastCompletedIteration + 1`.

**Where:** At the top of `executeLoopNode()`, before the iteration loop:
```typescript
let startIteration = 1;
let progressiveContext: string[] = [];
if (this.options.checkpointSourceRunId) {
  const lc = await loadLoopCheckpoint(this.options.checkpointSourceRunId, node.id);
  if (lc) {
    startIteration = lc.lastCompletedIteration + 1;
    // Reconstruct progressiveContext from lc.loopState.iterations
    progressiveContext = this.reconstructProgressiveContext(lc.loopState);
  }
}
```

### Pattern 8: Status "loop-iterating" in the ready-queue drain loop
**What:** The drain loop's `isTerminal()` helper must NOT treat `"loop-iterating"` as terminal. The loop node occupies one inFlight slot for its entire duration — this is already correct because `executeLoopNode()` is `await`-ed synchronously just like `executeNode()`.

**Required change in isTerminal:**
```typescript
const isTerminal = (status: string) =>
  status === "completed" || status === "failed" || status === "skipped";
  // "loop-iterating" is NOT terminal — intentionally excluded
```

This is already correct — `isTerminal` checks exact strings. Adding `"loop-iterating"` to the `NodeExecution.status` union type without adding it to `isTerminal` is the right move.

### Pattern 9: Dry-run annotation for loop nodes
**What:** In `buildDryRunResult()`, loop nodes should show their configuration in the dry-run output — e.g., `LOOP(max:10, until: _status == "completed")`.

**Where:** Extend the dry-run rendering loop in `buildDryRunResult()` to check `node.loop !== undefined` and add a loop annotation to the line output.

### Anti-Patterns to Avoid
- **Modifying executeNode() to contain iteration logic:** Creates a 300-line method mixing single-run and loop concerns. Use a separate `executeLoopNode()` method.
- **Treating loop node failure as a DAG edge cascade:** Loop exhaustion sets the loop node to `"failed"` and the normal cascade-skip logic handles downstream nodes automatically — no special casing needed.
- **Saving checkpoint BEFORE evaluating `until`:** The correct order per LOOP-03 is: cap check → run iteration → save checkpoint → evaluate `until`. If saving after `until` evaluation, a crash between iteration and checkpoint would cause re-running an already-completed iteration.
- **Accumulating output in-memory only:** Write iteration outputs to temp files immediately after each iteration; don't hold them in a memory array that's lost on crash.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Expression evaluation | Custom expression parser | `evaluateCondition()` from condition.ts | Already handles filtrex, error types, variable validation |
| Condition error types | New error classes | `ConditionSyntaxError`, `ConditionVariableError` | Already defined, already thrown by evaluateCondition |
| Checkpoint serialization | Custom JSON writing | Extend `saveCheckpoint()` / `loadCheckpoint()` pattern | Same dir structure, same error handling |
| Loop-specific context merging | Complex context builder | Simple object spread + `_`-prefixed keys | filtrex sees all context keys equally |

**Key insight:** The entire expression evaluation, error handling, and checkpoint storage infrastructure is reusable as-is. This phase is mostly wiring, not new infrastructure.

## Common Pitfalls

### Pitfall 1: TypeScript "loop-iterating" not in status union
**What goes wrong:** `NodeExecution.status` is typed as `"pending" | "running" | "completed" | "failed" | "skipped"`. Setting it to `"loop-iterating"` without updating the type causes a TypeScript error.
**Why it happens:** `noUnusedLocals: true` and strict mode make type mismatches compilation errors, not runtime warnings.
**How to avoid:** Update the union in `types.ts` first, before the executor code that sets the value.
**Warning signs:** `tsc --noEmit` fails on the assignment.

### Pitfall 2: filtrex customProp throws but result is not re-thrown
**What goes wrong:** filtrex catches errors from `customProp` and returns them as the result value. `evaluateCondition()` already handles this with `if (result instanceof ConditionVariableError) throw result`. The `until` expression context MUST include all `_`-prefixed variables so they don't trigger false `ConditionVariableError`s.
**Why it happens:** If `buildUntilContext()` forgets to add `_iteration` or `_status`, evaluating `_status == "completed"` throws a `ConditionVariableError`.
**How to avoid:** Always populate all four `_`-prefixed keys in the context, regardless of whether the expression uses them.
**Warning signs:** Test for `'_status == "completed"'` throws ConditionVariableError unexpectedly.

### Pitfall 3: Loop checkpoint path collision with node checkpoint
**What goes wrong:** If `saveLoopCheckpoint()` writes to `checkpoint.json` (the same file as `saveCheckpoint()`), rerun logic that calls `loadCheckpoint()` on a loop node gets malformed data.
**Why it happens:** The existing `checkpointDir()` helper generates `~/.forgectl/checkpoints/{runId}/{nodeId}/checkpoint.json`. Loop state is a superset of regular checkpoint data.
**How to avoid:** Write loop checkpoint to `loop-checkpoint.json` (distinct from `checkpoint.json`). The loop node also saves a regular `checkpoint.json` with the last successful iteration's result so rerun/hydration works unchanged.

### Pitfall 4: Progressive context temp dir leaked on loop exhaustion
**What goes wrong:** Temp files written for progressive context are not cleaned up when the loop exhausts `max_iterations`.
**Why it happens:** `executeLoopNode()` returns without error; no `finally` block cleans up temp dir.
**How to avoid:** Wrap the entire `executeLoopNode()` in a try/finally that calls `rmSync(tempDir, { recursive: true, force: true })`.

### Pitfall 5: isNodeReady() sees "loop-iterating" as non-terminal and re-enqueues
**What goes wrong:** After `executeLoopNode()` sets status to `"loop-iterating"`, if `processNode()` finishes synchronously (before iteration loop starts), the drain loop might call `isNodeReady()` and find the node is not terminal, not in inFlight, and all deps are terminal — re-enqueuing it.
**Why it happens:** The inFlight.set() happens synchronously in the drain loop, so the node IS in inFlight while `executeLoopNode()` runs. This is not actually a problem — the race condition from Phase 21 (`.then()` delete-before-set) is already fixed. But the `isNodeReady()` check `inFlight.has(nodeId)` correctly prevents re-enqueue.
**Warning signs:** A loop node runs twice. Check that inFlight.set() precedes the async work.

### Pitfall 6: Crash recovery skips the loop node entirely when checkpointSourceRunId is set
**What goes wrong:** The existing `hydrateNodeFromCheckpoint()` is called for ancestor nodes in a rerun. If a loop node is in the ancestors set AND has a loop checkpoint, the hydration tries to load `checkpoint.json` (regular format). Loop nodes should have BOTH files: a `loop-checkpoint.json` (for resume) and a `checkpoint.json` (for hydration by downstream nodes).
**Why it happens:** `prepareRerunSelection()` doesn't know about loop nodes; it just adds ancestors to `hydratedNodes`.
**How to avoid:** Loop nodes must write a regular `checkpoint.json` (with the last iteration's ExecutionResult) so `hydrateNodeFromCheckpoint()` works. The `loop-checkpoint.json` is additionally written for mid-loop resumption.

## Code Examples

### Extending NodeExecution type
```typescript
// src/pipeline/types.ts — source: existing file structure

export interface LoopIterationRecord {
  iteration: number;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
}

export interface LoopState {
  currentIteration: number;   // 0 before first iteration
  maxIterations: number;      // clamped effective value
  iterations: LoopIterationRecord[];
}

export interface NodeExecution {
  nodeId: string;
  runId?: string;
  status: "pending" | "running" | "loop-iterating" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;
  checkpoint?: CheckpointRef;
  error?: string;
  skipReason?: string;
  loopState?: LoopState;      // present only for loop nodes
  hydratedFromCheckpoint?: {
    pipelineRunId: string;
    nodeId: string;
  };
}
```

### Loop checkpoint save/load
```typescript
// src/pipeline/checkpoint.ts — new additions

function loopCheckpointPath(pipelineRunId: string, nodeId: string): string {
  return join(checkpointDir(pipelineRunId, nodeId), "loop-checkpoint.json");
}

export async function saveLoopCheckpoint(
  pipelineRunId: string,
  nodeId: string,
  lastCompletedIteration: number,
  loopState: LoopState,
): Promise<void> {
  const dir = checkpointDir(pipelineRunId, nodeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    loopCheckpointPath(pipelineRunId, nodeId),
    JSON.stringify({ lastCompletedIteration, loopState }, null, 2),
  );
}

export async function loadLoopCheckpoint(
  pipelineRunId: string,
  nodeId: string,
): Promise<{ lastCompletedIteration: number; loopState: LoopState } | null> {
  const path = loopCheckpointPath(pipelineRunId, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as {
    lastCompletedIteration: number;
    loopState: LoopState;
  };
}
```

### processNode() loop detection
```typescript
// In PipelineExecutor.processNode(), after condition check:

// Loop node: delegate to executeLoopNode
if (node.loop !== undefined) {
  await this.executeLoopNode(node);
  // Enqueue newly-ready dependents (same as after executeNode)
  for (const dependentId of dependentsMap.get(nodeId) ?? []) {
    if (isNodeReady(dependentId)) {
      readyQueue.add(dependentId);
    }
  }
  return;
}

// Regular node
await this.executeNode(node);
```

### Exhaustion error message (LOOP-03 requirement)
```typescript
state.status = "failed";
state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;
state.completedAt = new Date().toISOString();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static topological sort | Ready-queue executor with maxParallel | Phase 21 | Loop node occupies one inFlight slot; no executor changes needed |
| No expression evaluation | filtrex ^3.1.0 evaluator | Phase 20/21 | `until` expressions reuse exact same evaluator |
| Node checkpoints only | Add per-iteration loop checkpoints | Phase 22 | Enables mid-loop crash recovery |

**No deprecated approaches:** All Phase 21 patterns are current and applicable.

## Open Questions

1. **What happens to iteration output when body uses `files` output mode?**
   - What we know: `executeNode()` returns an `ExecutionResult` with `output.mode === "files"` — the output dir has text files that can be piped as progressive context.
   - What's unclear: Should progressive context read from the files output dir, or from stdout/stderr captured in `result.error` / `result.output`?
   - Recommendation: Treat files-mode output like context-mode — copy files to the progressive context dir. For git-mode output, extract the diff or commit message as text. This is Claude's discretion per CONTEXT.md.

2. **Does `until` expression evaluation error fail the loop or the pipeline?**
   - What we know: Condition evaluation errors are fatal in Phase 21 (COND-06). The CONTEXT.md says "Unknown/unresolvable variable names are fatal errors (consistent with Phase 21 conditions)."
   - What's unclear: Is a syntax error in `until` fatal at parse time (pre-validate in `validateDAG()`) or at first evaluation?
   - Recommendation: Validate `until` expression at `validateDAG()` time using `compileExpression()` (just check it compiles). Runtime evaluation errors remain fatal. This catches YAML authoring errors early.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (project standard) |
| Config file | vitest.config.ts (project root) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-loop.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LOOP-01 | Loop node executes body until `until` becomes true | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-01 | Loop node with default max_iterations (10) terminates | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-02 | Loop node does not create DAG back-edges; cycle detector passes | unit | `npm test -- test/unit/pipeline-dag.test.ts` | ✅ (extend) |
| LOOP-03 | YAML max_iterations > 50 is clamped to 50 with warning | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-03 | Safety cap check happens before until expression | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-04 | NodeExecution.loopState.currentIteration increments each iteration | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-04 | Active loop node shows status "loop-iterating" in getNodeStates() | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-05 | Per-iteration checkpoint saved after each iteration | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-05 | Crash recovery: executor resumes from lastCompletedIteration + 1 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |
| LOOP-01+LOOP-03 | Loop exhaustion fails with message naming node and count | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-loop.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/pipeline-loop.test.ts` — covers LOOP-01, LOOP-03, LOOP-04, LOOP-05
- [ ] Extend `test/unit/pipeline-dag.test.ts` with loop node DAG validation cases (LOOP-02)

*(Existing test infrastructure is complete — only the new loop test file is missing)*

## Sources

### Primary (HIGH confidence)
- Direct source inspection of `src/pipeline/executor.ts` — processNode(), executeNode(), drain loop, inFlight semantics
- Direct source inspection of `src/pipeline/types.ts` — NodeExecution, PipelineNode.loop (already defined)
- Direct source inspection of `src/pipeline/condition.ts` — evaluateCondition(), customProp error handling
- Direct source inspection of `src/pipeline/checkpoint.ts` — saveCheckpoint(), loadCheckpoint(), file paths
- Direct source inspection of `src/pipeline/parser.ts` — Zod schema with loop field (Phase 20)
- Direct source inspection of `src/pipeline/dag.ts` — validateDAG(), cycle detection
- Direct source inspection of `src/daemon/pipeline-service.ts` — getRun() serialization path
- Direct source inspection of `src/daemon/routes.ts` — GET /pipelines/:id response
- Direct source inspection of `test/unit/pipeline-executor.test.ts` — mock patterns for new tests

### Secondary (MEDIUM confidence)
- `.planning/phases/22-loop-pipeline-nodes/22-CONTEXT.md` — all locked decisions
- `.planning/REQUIREMENTS.md` — LOOP-01 through LOOP-05 definitions
- `.planning/STATE.md` — Phase 21 decisions (filtrex error-as-value pattern, inFlight race fix)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all libraries already in use
- Architecture: HIGH — source code fully inspected; integration points precisely identified
- Pitfalls: HIGH — derived from direct inspection of existing code patterns and Phase 21 decisions in STATE.md
- Test patterns: HIGH — existing test files inspected, mock patterns documented

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable codebase; no external dependencies being researched)
