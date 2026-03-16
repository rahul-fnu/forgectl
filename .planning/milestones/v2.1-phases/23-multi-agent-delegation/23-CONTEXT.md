# Phase 23: Multi-Agent Delegation - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

A lead agent decomposes a complex issue into subtasks, dispatches child workers concurrently within configured slot budgets, retries failed children with updated context, and synthesizes a final summary for write-back. Covers DELEG-01 through DELEG-09.

</domain>

<decisions>
## Implementation Decisions

### Delegation manifest format
- JSON array inside sentinel-delimited stdout block: `---DELEGATE---` / `---END-DELEGATE---`
- Required fields per subtask: `id` (unique within manifest) and `task` (instruction text)
- Optional fields: `workflow` (defaults to parent's workflow), `agent` (defaults to parent's agent)
- If lead agent outputs multiple manifest blocks, only the first is parsed — subsequent blocks are ignored
- Lead's non-manifest stdout is not extracted separately — already captured in RunLog JSON for debugging

### Two-tier slot pool
- Reserved child budget: split `max_concurrent_agents` into top-level slots + child slots
- New config field `orchestrator.child_slots` in forgectl.yaml — top-level slots = max_concurrent_agents - child_slots
- When `child_slots` is 0 or omitted: delegation is disabled — manifest blocks are logged as warnings and ignored
- Both global `child_slots` and per-parent `maxChildren` (from WORKFLOW.md) are enforced simultaneously
- Per-parent `maxChildren` caps how many children one delegation can have in-flight; global `child_slots` caps total child concurrency across all parents

### Child failure retry behavior
- Lead rewrites the failed subtask: lead agent is re-invoked with original issue + child failure output + "rewrite this subtask only"
- Rewrite scope is the failed subtask only — completed children are untouched, lead outputs a single-item manifest with the same id
- Maximum 1 retry per child (3 agent invocations max per subtask: original + lead rewrite + retry)
- Retries happen immediately — no waiting for other children to complete first; retry runs concurrently with remaining work
- If retry also fails, child is marked permanently failed

### Synthesis and write-back
- After all children complete (or permanently fail), re-invoke the lead agent with original issue + all child results
- Lead produces a structured markdown summary: header with overall status, per-child section with status badge + key output, lead-written synthesis paragraph
- Child outputs (branches, PRs) are separate artifacts — no auto-merge; synthesis comment references them
- Synthesis always runs regardless of child outcomes — partial results are valuable, user gets full picture

### Claude's Discretion
- Exact DelegationManager class structure and method signatures
- How child workspace isolation works (reuse parent workspace vs fresh clone)
- Sentinel parsing implementation details (regex vs streaming)
- How the synthesis prompt is structured beyond the required content
- Governance inheritance model for child runs
- Dry-run behavior for delegation nodes

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/storage/repositories/delegations.ts`: Full DelegationRepository with insert, findByParentRunId, findByChildRunId, updateStatus, countByParentAndStatus — ready for Phase 23 wiring
- `src/orchestrator/state.ts`: `SlotManager` class — needs extension from single-tier to two-tier (topLevelSlots + childSlots)
- `src/orchestrator/worker.ts`: Full worker lifecycle (agent session, validation, output, comments) — child workers reuse this
- `src/orchestrator/scheduler.ts`: Scheduling loop uses `slotManager.availableSlots()` — extend to differentiate top-level vs child scheduling
- `src/storage/schema.ts`: `delegations` table and `runs` table with `parentRunId` column already defined (Phase 20)

### Established Patterns
- Repository pattern: Row interface → Params interfaces → deserializeRow() → factory function
- SlotManager: `availableSlots(running)` returns count based on `maxConcurrent - running.size`
- Worker result: `WorkerResult` interface with agentResult, comment, executionResult, validationResult, branch
- Run tracking: `state.running` Map<string, WorkerInfo> in orchestrator state

### Integration Points
- `src/orchestrator/index.ts`: Main orchestrator — SlotManager instantiation, scheduler dispatch, worker completion handling
- `src/orchestrator/dispatcher.ts`: Dispatches workers — extend to handle delegation dispatch
- `src/orchestrator/reconciler.ts`: Reconciles run state on daemon restart — extend for parent/child recovery
- `src/orchestrator/comment.ts`: Comment building — extend for aggregate synthesis comments
- `src/daemon/routes.ts`: REST API — delegation status may surface here

</code_context>

<specifics>
## Specific Ideas

- The delegation manifest format (`---DELEGATE---` JSON array `---END-DELEGATE---`) is chosen for clean Zod validation and round-trip compatibility with the `taskSpec` JSON column in the delegations table
- Two-tier slot pool is the simplest starvation-proof design — no priority queues, no preemption logic
- Lead rewrite pattern (re-invoke lead on child failure) gives the lead full agency to change strategy, not just retry blindly
- Structured markdown for synthesis comments matches the existing `buildResultComment` pattern in `src/github/comments.ts`

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 23-multi-agent-delegation*
*Context gathered: 2026-03-13*
