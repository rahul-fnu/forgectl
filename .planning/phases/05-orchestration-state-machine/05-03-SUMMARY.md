---
phase: 05-orchestration-state-machine
plan: 03
subsystem: orchestration
tags: [dispatcher, reconciler, scheduler, priority-sorting, stall-detection, tick-loop]

requires:
  - phase: 05-orchestration-state-machine
    provides: OrchestratorState, SlotManager, retry/backoff functions (Plan 01)
  - phase: 05-orchestration-state-machine
    provides: executeWorker and buildResultComment (Plan 02)
  - phase: 01-tracker-adapter-github-notion
    provides: TrackerAdapter interface with fetchCandidateIssues, fetchIssueStatesByIds
provides:
  - filterCandidates for excluding claimed, running, and blocked issues
  - sortCandidates for priority-based ordering with tiebreakers
  - dispatchIssue for full worker lifecycle with retry scheduling
  - reconcile for state refresh, terminal cleanup, and stall detection
  - startScheduler and tick for setTimeout-based polling loop
affects: [05-04-orchestration-loop]

tech-stack:
  added: []
  patterns: [fire-and-forget-dispatch, per-worker-error-isolation, setTimeout-chain-scheduling]

key-files:
  created:
    - src/orchestrator/dispatcher.ts
    - src/orchestrator/reconciler.ts
    - src/orchestrator/scheduler.ts
    - test/unit/orchestrator-dispatcher.test.ts
    - test/unit/orchestrator-reconciler.test.ts
    - test/unit/orchestrator-scheduler.test.ts
  modified: []

key-decisions:
  - "Priority extraction re-implemented locally (P0-P4 labels, priority:level labels, numeric field) rather than importing from github adapter"
  - "dispatchIssue uses fire-and-forget pattern with void executeWorkerAndHandle for non-blocking dispatch"
  - "Reconciler uses separate loops for state reconciliation and stall detection with per-worker error isolation"
  - "Scheduler uses setTimeout chain (not setInterval) to prevent tick overlap"

patterns-established:
  - "Tick sequence: reconcile -> validate config -> fetch candidates -> filter -> sort -> dispatch"
  - "Per-worker try/catch in reconciliation so one cleanup failure doesn't affect others"
  - "Best-effort tracker label updates that log warnings on failure but don't block dispatch"

requirements-completed: [R2.2, R2.3, R2.5]

duration: 3min
completed: 2026-03-08
---

# Phase 5 Plan 3: Dispatcher, Reconciler, and Scheduler Summary

**Candidate filtering with priority sorting, state reconciliation with stall detection, and setTimeout-based tick loop for orchestrator runtime**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T08:40:55Z
- **Completed:** 2026-03-08T08:46:30Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Dispatcher with filterCandidates (claimed/running/blocked exclusion), sortCandidates (priority/age/identifier ordering), and dispatchIssue (full worker lifecycle with retry)
- Reconciler with state refresh via fetchIssueStatesByIds, terminal/non-active/active handling, and stall detection past configurable threshold
- Scheduler with tick loop using setTimeout chain, preventing overlap, with clean stop function
- 51 tests covering all filtering, sorting, dispatch, reconciliation, stall detection, and scheduler behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1: Dispatcher** - `a38ad49` (feat)
2. **Task 2: Reconciler and Scheduler** - `20518d1` (feat)

_Note: TDD tasks -- RED/GREEN phases per task_

## Files Created/Modified
- `src/orchestrator/dispatcher.ts` - filterCandidates, sortCandidates, extractPriorityNumber, dispatchIssue with fire-and-forget worker lifecycle
- `src/orchestrator/reconciler.ts` - reconcile with terminal/non-active/active state handling, stall detection, per-worker error isolation
- `src/orchestrator/scheduler.ts` - tick (reconcile->fetch->filter->sort->dispatch), startScheduler with setTimeout chain
- `test/unit/orchestrator-dispatcher.test.ts` - 29 tests for filtering, sorting, priority extraction, and dispatch lifecycle
- `test/unit/orchestrator-reconciler.test.ts` - 10 tests for reconciliation states, fetch failure, stall detection
- `test/unit/orchestrator-scheduler.test.ts` - 12 tests for tick ordering, slot limits, setTimeout chain, stop behavior

## Decisions Made
- Re-implemented priority extraction locally rather than coupling to github adapter's private implementation
- Used fire-and-forget dispatch pattern (void async function) to avoid blocking the tick loop
- Separate reconciliation and stall detection loops in reconciler for clarity and error isolation
- setTimeout chain prevents tick overlap; setInterval was explicitly avoided

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Dispatcher, reconciler, and scheduler ready for Plan 04 (orchestrator class) to compose into the full orchestration loop
- All 51 plan-specific tests pass, 526 total tests pass, typecheck clean
- No blockers

---
*Phase: 05-orchestration-state-machine*
*Completed: 2026-03-08*
