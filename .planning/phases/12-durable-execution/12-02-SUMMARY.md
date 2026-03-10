---
phase: 12-durable-execution
plan: 02
subsystem: durability
tags: [checkpoint, recovery, locks, daemon-startup, crash-recovery]

requires:
  - phase: 12-durable-execution plan 01
    provides: LockRepository, acquireLock, releaseLock, releaseAllStaleLocks
  - phase: 11-flight-recorder plan 01
    provides: EventRecorder, SnapshotRepository

provides:
  - CheckpointState type and saveCheckpoint/loadLatestCheckpoint helpers
  - recoverInterruptedRuns daemon startup recovery routine
  - Checkpoint saves at 4 phase boundaries in executeSingleAgent
  - Execution lock wiring with try/finally in run lifecycle
  - Daemon startup recovery and stale lock cleanup

affects: [12-durable-execution plan 03, orchestrator, daemon]

tech-stack:
  added: []
  patterns: [optional-deps-parameter for backward-compatible extension, startup-recovery-before-listen]

key-files:
  created:
    - src/durability/checkpoint.ts
    - src/durability/recovery.ts
    - test/unit/durability-checkpoint.test.ts
    - test/unit/durability-recovery.test.ts
  modified:
    - src/orchestration/single.ts
    - src/orchestration/modes.ts
    - src/daemon/server.ts

key-decisions:
  - "DurabilityDeps optional parameter preserves backward compat for CLI and test callers"
  - "Workspace lock uses input.sources[0] as lock key (first source path)"
  - "Recovery runs synchronously before HTTP server accepts requests"
  - "v2.0 marks interrupted runs as failed only, no container re-creation attempt"

patterns-established:
  - "Optional deps pattern: add {snapshotRepo?, lockRepo?, daemonPid?} as last param with default {}"
  - "Startup recovery: stale lock cleanup then interrupted run recovery before app.listen()"

requirements-completed: [DURA-01, DURA-02, DURA-04]

duration: 4min
completed: 2026-03-10
---

# Phase 12 Plan 02: Checkpoint & Recovery Summary

**Checkpoint capture at phase boundaries, daemon startup recovery for interrupted runs, and execution lock wiring with try/finally lifecycle management**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T02:50:44Z
- **Completed:** 2026-03-10T02:54:40Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- CheckpointState type with saveCheckpoint/loadLatestCheckpoint persisting via SnapshotRepository
- recoverInterruptedRuns marks all "running" status runs as "interrupted" with descriptive phase-aware error messages
- Daemon startup releases stale locks and recovers interrupted runs before accepting HTTP requests
- executeSingleAgent saves checkpoints at prepare/execute/validate/output boundaries
- Workspace locks acquired before execution, released in finally block
- 11 new tests covering checkpoint and recovery scenarios, full suite (786 tests) passes

## Task Commits

Each task was committed atomically:

1. **Task 1: Checkpoint helpers and recovery routine** - `f633d8a` (feat, TDD)
2. **Task 2: Wire checkpoints, recovery, and locks into daemon and execution flow** - `dc6dfc8` (feat)

## Files Created/Modified
- `src/durability/checkpoint.ts` - CheckpointState type, saveCheckpoint, loadLatestCheckpoint
- `src/durability/recovery.ts` - recoverInterruptedRuns with phase-aware error messages
- `src/orchestration/single.ts` - Checkpoint saves at phase boundaries, lock acquisition/release
- `src/orchestration/modes.ts` - DurabilityDeps passthrough to executeSingleAgent
- `src/daemon/server.ts` - Startup recovery and stale lock cleanup before app.listen()
- `test/unit/durability-checkpoint.test.ts` - 5 tests for checkpoint save/load
- `test/unit/durability-recovery.test.ts` - 6 tests for recovery routine

## Decisions Made
- DurabilityDeps is an optional last parameter with `= {}` default, ensuring no existing callers break
- Workspace lock uses `plan.input.sources[0]` as lock key since RunPlan has no trackerIssue field
- Recovery runs synchronously (not async) before HTTP server listens -- simple and correct for SQLite
- v2.0 only marks interrupted runs, no container re-creation (per research recommendation)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Adapted lock wiring to actual RunPlan shape**
- **Found during:** Task 2
- **Issue:** Plan referenced `plan.trackerIssue?.id` and `plan.options?.workspace` which don't exist on RunPlan type
- **Fix:** Used `plan.input.sources[0]` as workspace lock key instead; skipped issue lock since RunPlan has no tracker issue field
- **Files modified:** src/orchestration/single.ts
- **Verification:** typecheck passes, all tests pass
- **Committed in:** dc6dfc8

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Adapted to actual type shape. Lock wiring achieves same goal of preventing concurrent workspace access.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Checkpoint and recovery foundation complete for plan 12-03 (pause/resume)
- DurabilityDeps pattern established for threading repos through execution
- All phase boundaries instrumented for crash recovery metadata

---
*Phase: 12-durable-execution*
*Completed: 2026-03-10*
