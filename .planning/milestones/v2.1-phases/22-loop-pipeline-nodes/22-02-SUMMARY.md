---
phase: 22-loop-pipeline-nodes
plan: "02"
subsystem: pipeline
tags: [loop, checkpoint, executor, filtrex, vitest, progressive-context]

# Dependency graph
requires:
  - phase: 22-loop-pipeline-nodes/22-01
    provides: LoopIterationRecord, LoopState, LoopState.loopState on NodeExecution, saveLoopCheckpoint, loadLoopCheckpoint, GLOBAL_MAX_ITERATIONS
  - phase: 21-conditional-nodes
    provides: evaluateCondition, NodeStatusContext, PipelineExecutor base

provides:
  - executeLoopNode() private method on PipelineExecutor
  - Loop detection in processNode() before executeNode() dispatch
  - Safety cap enforcement (Math.min(configured, GLOBAL_MAX_ITERATIONS)) with warning log
  - Progressive context accumulation via temp files across iterations
  - Per-iteration loop checkpoint via saveLoopCheckpoint after each iteration
  - Crash recovery via loadLoopCheckpoint when checkpointSourceRunId is set
  - Until expression evaluation with _status, _iteration, _max_iterations, _first_iteration context
  - Loop exhaustion failure with named error message
  - Dry-run LOOP(max:N, until: expr) annotation in buildDryRunResult()
  - 9 new tests: 5 in pipeline-loop.test.ts, 4 in pipeline-executor.test.ts

affects: [23-delegation, 24-self-correction]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "executeLoopNode() delegates from processNode() before executeNode() — loop nodes bypass single-execution path"
    - "Progressive context: each iteration's output written to a temp file immediately and accumulated in an array for next iteration's node.context"
    - "Loop checkpoint saved AFTER iteration and BEFORE until evaluation — correct recovery order"
    - "Body failure is an iteration result (status recorded as 'failed'), not loop termination — loop continues to next iteration"
    - "state.status reset to 'loop-iterating' after each executeNode() call because executeNode() overwrites with 'completed'/'failed'"
    - "try/finally on loopTempDir ensures progressive context files are cleaned up even on fatal errors"

key-files:
  created: []
  modified:
    - src/pipeline/executor.ts
    - test/unit/pipeline-loop.test.ts
    - test/unit/pipeline-executor.test.ts

key-decisions:
  - "executeLoopNode receives upstreamCtx (Record<string,string>) built from buildStatusContext(deps) — caller passes it to avoid duplicate context computation"
  - "Progressive context passed via node clone: iterationNode = {...node, context: [...(node.context ?? []), ...progressiveContext]} — no mutation, clean interface with executeNode()"
  - "Logger.warn() called for clamping notification (requires 2 args: phase + message) — uses 'loop' as phase label"
  - "Crash recovery reconstructs progressive context with placeholder markdown files (not original output) — enough for context passing semantics"
  - "beforeEach in pipeline-executor.test.ts now re-sets executeRun default after vi.clearAllMocks() to prevent mock state leakage across tests"

patterns-established:
  - "Loop tests in pipeline-loop.test.ts use same homedir mock (testDir redirect) as pipeline-checkpoint.test.ts so saveLoopCheckpoint writes to test-controlled location"
  - "executeLoopNode unit tests use vi.mocked(executeRun) from top-level vi.mock() factory, with per-test .mockResolvedValueOnce() for sequenced results"

requirements-completed: [LOOP-01, LOOP-02, LOOP-03, LOOP-04, LOOP-05]

# Metrics
duration: 5min
completed: 2026-03-13
---

# Phase 22 Plan 02: executeLoopNode Implementation Summary

**Loop iteration engine in PipelineExecutor: safety-capped until-expression loop with progressive context, per-iteration checkpointing, crash recovery, and dry-run annotation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-13T05:19:39Z
- **Completed:** 2026-03-13T05:25:00Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- Implemented `executeLoopNode()` as a private method on `PipelineExecutor` covering all LOOP-01 through LOOP-05 requirements
- Wired loop detection into `processNode()` so loop nodes bypass `executeNode()` and delegate to `executeLoopNode()`
- Extended `buildDryRunResult()` with cyan `LOOP(max:N, until: expr)` annotation after condition annotations
- Added 9 new tests (5 in pipeline-loop.test.ts section 8, 4 in pipeline-executor.test.ts) covering all behavioral requirements
- Fixed `beforeEach` mock reset in pipeline-executor.test.ts to prevent `vi.clearAllMocks()` leaving `executeRun` in a failure state for subsequent tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement executeLoopNode() and wire into processNode** - `729fecc` (feat)

## Files Created/Modified
- `src/pipeline/executor.ts` - Added executeLoopNode() method, loop detection in processNode(), LOOP annotation in buildDryRunResult(), updated imports
- `test/unit/pipeline-loop.test.ts` - Added section 8 with 5 executeLoopNode unit tests, added vi.mock() factories for config/loader, modes, events
- `test/unit/pipeline-executor.test.ts` - Added loadLoopCheckpoint mock, 4 loop integration tests, fixed beforeEach to reset executeRun default

## Decisions Made
- `executeLoopNode()` receives `upstreamCtx` from the caller (buildStatusContext result) — avoids duplicating context computation inside the method
- Progressive context passed via a shallow node clone (`{...node, context: [...prev, ...loopCtx]}`) — clean separation, no mutation of original PipelineNode
- `state.status` explicitly reset to `"loop-iterating"` after each `executeNode()` call, because `executeNode()` overwrites it with `"completed"` or `"failed"`
- Crash recovery writes placeholder markdown files for recovered iterations — preserves the progressive context file count but not actual content (accepted trade-off for simplicity)
- `beforeEach` in pipeline-executor.test.ts re-establishes `executeRun` default after `vi.clearAllMocks()` to prevent mock pollution between tests

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Logger.warn() call signature**
- **Found during:** Task 1 (initial typecheck)
- **Issue:** `logger.warn(message)` called with 1 arg; Logger.warn requires 2 (phase: string, message: string)
- **Fix:** Changed to `logger.warn("loop", message)`
- **Files modified:** src/pipeline/executor.ts
- **Verification:** `npm run typecheck` passes
- **Committed in:** `729fecc` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed LoopState import causing noUnusedLocals error**
- **Found during:** Task 1 (initial typecheck)
- **Issue:** `import type { LoopState, LoopIterationRecord }` — LoopState not directly used in executor (only LoopIterationRecord and the inline `state.loopState!` field access)
- **Fix:** Removed LoopState from import, kept only LoopIterationRecord
- **Files modified:** src/pipeline/executor.ts
- **Verification:** `npm run typecheck` passes
- **Committed in:** `729fecc` (Task 1 commit)

**3. [Rule 1 - Bug] Fixed progressive context test to read plan.context.files instead of plan.context**
- **Found during:** Task 1 (test run)
- **Issue:** Test read `plan.context` as an array, but `resolveRunPlan` returns `plan.context` as `{system, files, inject}` object
- **Fix:** Changed test to access `(plan.context as { files?: string[] }).files ?? []`
- **Files modified:** test/unit/pipeline-loop.test.ts
- **Verification:** Test passes
- **Committed in:** `729fecc` (Task 1 commit)

**4. [Rule 1 - Bug] Fixed mock state leakage in pipeline-executor.test.ts**
- **Found during:** Task 1 (full test suite run)
- **Issue:** Loop exhaustion test sets `executeRun.mockResolvedValue({ success: false, error: "Always fails" })`. `vi.clearAllMocks()` in `beforeEach` only resets call counts, not implementations. Subsequent test ("checkpoint-hydrated") picked up the failure mock.
- **Fix:** Added `vi.mocked(executeRun).mockResolvedValue({ success: true, ... })` to `beforeEach` to restore default after `clearAllMocks()`
- **Files modified:** test/unit/pipeline-executor.test.ts
- **Verification:** All 23 executor tests pass
- **Committed in:** `729fecc` (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (all Rule 1 bugs caught during typecheck and test runs)
**Impact on plan:** All fixes necessary for correctness. No scope creep.

## Issues Encountered
- `vi.clearAllMocks()` does not reset mock implementations, only call counts/instances. This is a known vitest behavior. The fix (re-setting default in beforeEach) is the standard pattern going forward for any test file that both (a) uses `clearAllMocks()` and (b) has tests that override the default mock implementation.

## Next Phase Readiness
- All LOOP-01 through LOOP-05 requirements are satisfied and observable via tests
- `executeLoopNode()` is complete and production-ready
- Phase 23 (Delegation) and Phase 24 (Self-Correction) can proceed — no loop-specific blockers

## Self-Check: PASSED

- src/pipeline/executor.ts — FOUND
- test/unit/pipeline-loop.test.ts — FOUND
- test/unit/pipeline-executor.test.ts — FOUND
- Commit 729fecc — FOUND

---
*Phase: 22-loop-pipeline-nodes*
*Completed: 2026-03-13*
