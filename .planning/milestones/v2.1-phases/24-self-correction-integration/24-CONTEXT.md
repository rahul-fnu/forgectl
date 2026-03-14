# Phase 24: Self-Correction Integration - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Pipelines can autonomously run tests, detect failures, invoke a fix agent with full iteration history, retest, and exhaust cleanly — proving the loop node + context piping composition works end-to-end. Covers CORR-01 through CORR-05. Progressive context piping (CORR-03) is already implemented in Phase 22's executeLoopNode — this phase adds no-progress detection, test file exclusion enforcement, and coverage threshold parsing on top.

</domain>

<decisions>
## Implementation Decisions

### No-progress detection (CORR-05)
- SHA-256 hash comparison of test command stdout+stderr between consecutive iterations only
- If iteration N's output hash matches iteration N-1's hash, abort immediately with "no progress detected" failure
- No cycle detection across non-consecutive iterations — consecutive-only catches the common stuck-agent case
- Failure message includes the repeated test output so users can see what the agent was stuck on
- Hash computed on raw test output (stdout+stderr), not on the progressive context file (which includes timestamps)

### Test file exclusion enforcement (CORR-02)
- Post-execution git diff check after each fix agent iteration, directly in executeLoopNode
- Uses picomatch glob matching against the existing `repo.exclude` list from WORKFLOW.md — no new config surface
- If any excluded file was modified: step fails immediately with error naming the specific files modified
- Error format: "Fix agent modified excluded file(s): test/foo.test.ts, test/bar.test.ts" — no suggestion text
- After failing, excluded file modifications are reverted via git checkout before the next iteration starts
- Other (non-excluded) changes from the fix agent are left in place

### Coverage threshold parsing (CORR-04)
- Regex parsing of test runner stdout for common coverage patterns (vitest, jest, istanbul/c8 formats)
- Coverage number injected as `_coverage` loop variable alongside `_status`, `_iteration`, etc.
- Users write until expressions like `_coverage >= 80` — consistent with the filtrex expression model
- When no coverage pattern is found in output: `_coverage = -1` (until expression stays false, loop continues)
- Exhaustion message includes final coverage: "Coverage target not met after N iterations (final: 72%, target: 80%)"

### Claude's Discretion
- Exact regex patterns for coverage extraction (vitest, jest, istanbul formats)
- How progressive context formats the iteration output (markdown structure, headers)
- Integration test structure and fixture design
- WORKFLOW.md self-correction pattern documentation format and examples
- Whether `_coverage` is always injected or only when the until expression references it

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/pipeline/executor.ts`: `executeLoopNode()` — main integration point; already handles progressive context, iteration checkpoints, until evaluation
- `src/pipeline/checkpoint.ts`: `saveLoopCheckpoint()`, `loadLoopCheckpoint()`, `GLOBAL_MAX_ITERATIONS` — loop checkpoint infrastructure
- `src/pipeline/condition.ts`: `evaluateCondition()` — filtrex evaluator, extend context with `_coverage` variable
- `src/container/workspace.ts`: `picomatch` exclude matching — same glob syntax for post-execution diff check
- `node:crypto` `createHash` — already imported pattern in codebase for SHA-256 hashing

### Established Patterns
- Loop variables injected into filtrex context: `_status`, `_iteration`, `_max_iterations`, `_first_iteration` (line 720-726 of executor.ts)
- Iteration output files written to temp dir with padded naming: `iteration-01-output.md` (line 698)
- Fatal errors set `state.status = "failed"` and `state.error` then return (lines 732-738)
- `repo.exclude` flows from WORKFLOW.md → `config.repo.exclude` → workspace operations

### Integration Points
- `executeLoopNode()` in executor.ts — add hash comparison after each iteration, add git diff check, add `_coverage` to until context
- `src/pipeline/types.ts` — no type changes expected (LoopState and NodeExecution already sufficient)
- `src/workflow/types.ts` line 120 — `exclude: string[]` already defined

</code_context>

<specifics>
## Specific Ideas

- Progressive context from Phase 22 means CORR-03 is already working — each iteration's output accumulates automatically via `progressiveContext` array in `executeLoopNode`
- The self-correction pattern is a composition proof: loop node + condition evaluation + progressive context + exclude enforcement + no-progress detection all working together
- `_status == "completed"` is the canonical "stop when tests pass" expression for the test-fail/fix/retest pattern
- `_coverage >= N` is the canonical "stop when coverage threshold met" expression

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 24-self-correction-integration*
*Context gathered: 2026-03-13*
