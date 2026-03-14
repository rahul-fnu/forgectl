# Phase 21: Conditional Pipeline Nodes - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Pipeline YAML supports if/else branch routing — the executor evaluates conditions at runtime, skips false-branch nodes, surfaces skip status in the API, and treats condition errors as fatal. Covers COND-01 through COND-07.

</domain>

<decisions>
## Implementation Decisions

### Expression context
- Condition expressions reference **upstream node statuses only** — values are `"completed"`, `"failed"`, or `"skipped"`
- Only nodes in the transitive `depends_on` chain are available as variables — referencing a non-dependency is a fatal validation error
- Unknown/unresolvable variable names cause the pipeline to fail immediately with a clear error (no silent falsy evaluation)
- Full boolean combinators supported — `and`, `or`, `not` via filtrex's native support (e.g., `build == "completed" and test == "completed"`)

### Shorthand semantics
- `if_failed` and `if_passed` take a **specific node ID** as their value (e.g., `if_failed: test` → `condition: 'test == "failed"'`)
- The referenced node is **auto-added to depends_on** if not already present — no redundant YAML required
- `if_failed`/`if_passed` and `condition` are **mutually exclusive** on the same node — using both is a validation error
- Shorthand expansion happens at **parse time** — the rest of the system only ever sees `condition` strings. Single code path for evaluation

### Skip propagation
- **Cascade skip**: if a node is skipped (condition false), all downstream dependents are also skipped
- If a node has multiple dependencies and **any** dependency was skipped, the node is skipped (conservative model)
- `else_node` is an **alternative execution path**, not a skip cascade — when a condition is false, the conditional node is skipped but the else_node is activated and its dependents run normally
- Distinct skip reasons: condition-based skips include the expression (e.g., `"condition false: test == \"failed\""`) while cascade skips name the skipped dependency (e.g., `"dependency fix-agent was skipped"`)

### Dry-run output
- `--dry-run` assumes all nodes complete successfully (happy path) and shows which conditional nodes would be skipped vs run
- Dry-run **validates condition expressions** — checks that referenced node IDs exist in the pipeline, catches typos before a real run
- Dry-run **validates else_node references** — checks targets exist, aren't self-referencing, and don't create cycles
- Condition annotations shown **only on conditional nodes** — unconditional nodes display normally without annotation clutter

### Claude's Discretion
- Exact filtrex configuration and custom function setup
- Ready-queue data structure choice (priority queue, linked list, etc.)
- How to build the upstream status context object for filtrex evaluation
- Internal error message formatting
- Whether to add a `resolvedCondition` field to NodeExecution for debugging

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/pipeline/types.ts`: PipelineNode already has `condition`, `else_node`, `if_failed`, `if_passed`, `node_type`, `loop` fields (added in Phase 20)
- `src/pipeline/parser.ts`: PipelineNodeSchema Zod validation already accepts all new fields
- `src/pipeline/dag.ts`: `validateDAG()`, `topologicalSort()`, `collectAncestors()`, `collectDescendants()` — all available for upstream resolution and validation
- `src/pipeline/checkpoint.ts`: `loadCheckpoint()`, `saveCheckpoint()` — checkpoint system works with node-level granularity
- `filtrex` ^3.1.0 installed (Phase 20) but not yet imported — Phase 21 adds the first import

### Established Patterns
- NodeExecution already has `status: "skipped"` and `skipReason` fields — skip propagation can use existing state model
- Executor uses `inFlight` Map for parallel tracking with `maxParallel` limit — ready-queue refactor replaces the static topological iteration
- Current `getDependencyIssues()` method checks dep states before executing — extend this for condition/skip logic
- `buildDryRunResult()` already exists in executor — extend with condition annotations

### Integration Points
- `src/pipeline/executor.ts`: Main refactor target — replace static topo-sort loop (line 89-151) with ready-queue model
- `src/daemon/routes.ts`: `GET /pipelines/:id` already returns node states — skipped status will surface automatically
- `src/pipeline/dag.ts`: `validateDAG()` needs extension for else_node validation
- `src/pipeline/parser.ts`: Add shorthand expansion (if_failed/if_passed → condition) as a post-parse transform

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard patterns. Key design insight: shorthand expansion at parse time means the entire condition system has a single evaluation path (filtrex), and the ready-queue model naturally handles skip propagation by re-evaluating readiness after each node completes.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 21-conditional-pipeline-nodes*
*Context gathered: 2026-03-13*
