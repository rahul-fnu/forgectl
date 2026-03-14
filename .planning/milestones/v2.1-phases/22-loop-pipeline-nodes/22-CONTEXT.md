# Phase 22: Loop Pipeline Nodes - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Pipeline YAML supports loop-until iteration — loops execute up to a hard safety cap, each iteration is checkpointed for crash recovery, and loop progress is visible in the API. The loop node is an opaque meta-node (no DAG back-edges). Covers LOOP-01 through LOOP-05.

</domain>

<decisions>
## Implementation Decisions

### Loop body failure behavior
- Failure is an iteration result, not a loop termination event — the loop records the failure, increments the iteration counter, and re-evaluates the `until` expression
- The `until` expression decides when to stop, not individual iteration outcomes
- Loop only fails when `max_iterations` is exhausted without `until` becoming true
- When `max_iterations` is exhausted, the loop node status is always `"failed"` with error message naming the node and iteration count (regardless of last iteration's result)
- Each iteration's output (stdout/stderr) is automatically piped as progressive context to the next iteration — all previous outputs accumulate (not just the most recent)

### Until expression context
- `until` expressions have access to **both** upstream node statuses and loop-specific variables
- Upstream node statuses: same as condition expressions (`"completed"`, `"failed"`, `"skipped"`)
- Loop-specific variables injected into context:
  - `_status` — current iteration's result: `"completed"` or `"failed"`
  - `_iteration` — current 1-based iteration count
  - `_max_iterations` — the configured max_iterations value
  - `_first_iteration` — boolean, true only on iteration 1
- Unknown/unresolvable variable names are fatal errors (consistent with Phase 21 conditions)
- Uses the same filtrex evaluator as condition expressions

### Safety cap
- Global hard cap: `GLOBAL_MAX_ITERATIONS = 50` (enforced in code, YAML cannot exceed)
- When YAML specifies `max_iterations` above the cap: warn and clamp (log message stating the override, proceed with capped value)
- Default `max_iterations` when YAML omits the field: `10`
- Safety cap check happens **before** evaluating the `until` expression (per LOOP-03)

### Iteration history and observability
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/pipeline/condition.ts`: `evaluateCondition()` — reusable for `until` expression evaluation; extend context with loop-specific variables
- `src/pipeline/condition.ts`: `expandShorthands()` — pattern for parse-time transforms
- `src/pipeline/checkpoint.ts`: `saveCheckpoint()`, `loadCheckpoint()` — per-node checkpoint system, extend for per-iteration overwrite
- `src/pipeline/types.ts`: `PipelineNode.loop` field already defined with `{ until, max_iterations, body }` (Phase 20)
- `src/pipeline/types.ts`: `NodeExecution` — extend with `loopState` field
- `src/pipeline/parser.ts`: Zod schema already accepts `loop` fields (Phase 20)

### Established Patterns
- Ready-queue executor (Phase 21): nodes tracked in `inFlight` Map with `maxParallel` limit — loop node occupies one slot for its entire duration
- Condition errors are fatal: `ConditionSyntaxError`, `ConditionVariableError` — same error handling for `until` expressions
- Skip cascade: if loop node is skipped, all downstream dependents are also skipped
- `NodeExecution.status` enum: add `"loop-iterating"` alongside existing `"pending" | "running" | "completed" | "failed" | "skipped"`

### Integration Points
- `src/pipeline/executor.ts`: `processNode()` method — add loop detection and iteration logic
- `src/pipeline/executor.ts`: `executeNode()` method — wrap in iteration loop for loop-type nodes
- `src/pipeline/checkpoint.ts`: Extend to support per-iteration checkpoint overwrite
- `src/daemon/routes.ts`: `GET /pipelines/:id` — loop state surfaces automatically via `NodeExecution`
- `src/pipeline/dag.ts`: `validateDAG()` — validate `until` expression references

</code_context>

<specifics>
## Specific Ideas

- Progressive context piping enables Phase 24 self-correction natively — no additional wiring needed in Phase 24 for CORR-03
- Loop nodes are opaque to the DAG — no back-edges, no cycle detection issues; the iteration is internal to the meta-node
- `_status == "completed"` is the canonical "stop when body succeeds" expression — this will be the most common pattern

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 22-loop-pipeline-nodes*
*Context gathered: 2026-03-13*
