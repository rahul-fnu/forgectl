---
phase: 12-durable-execution
plan: 01
subsystem: database
tags: [sqlite, drizzle, locks, concurrency, durability]

requires:
  - phase: 10-persistent-storage
    provides: "SQLite database, Drizzle ORM, migration system, repository pattern"
provides:
  - "execution_locks table with unique(lockType, lockKey) constraint"
  - "LockRepository with CRUD operations and stale lock cleanup"
  - "acquireLock/releaseLock/releaseAllStaleLocks business logic"
  - "runs table extended with pause_reason and pause_context columns"
  - "RunRepository extended with pauseReason/pauseContext and clearPauseContext"
affects: [12-durable-execution, orchestrator, daemon]

tech-stack:
  added: []
  patterns: ["execution locking via unique constraint", "stale lock cleanup on daemon startup"]

key-files:
  created:
    - src/durability/locks.ts
    - src/storage/repositories/locks.ts
    - drizzle/0002_condemned_matthew_murdock.sql
    - test/unit/durability-locks.test.ts
  modified:
    - src/storage/schema.ts
    - src/storage/repositories/runs.ts

key-decisions:
  - "Unique constraint on (lockType, lockKey) for lock exclusivity instead of application-level checking"
  - "deleteByStale uses SQL ne() filter for atomic stale lock cleanup rather than find-then-delete"
  - "releaseLock delegates to deleteByOwner (removes all locks for a run, not just one type)"

patterns-established:
  - "Execution locking: acquire returns bool, release is idempotent"
  - "Stale cleanup on startup: releaseAllStaleLocks(currentPid) removes crashed daemon locks"

requirements-completed: [DURA-04]

duration: 5min
completed: 2026-03-10
---

# Phase 12 Plan 01: Execution Locks Summary

**SQLite-based execution locks preventing concurrent runs on same issue/workspace, with stale lock cleanup and run pause context columns**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-10T02:43:10Z
- **Completed:** 2026-03-10T02:48:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- execution_locks table with unique(lockType, lockKey) constraint prevents concurrent runs on same issue or workspace
- LockRepository follows existing repository pattern with insert, findByDaemonPid, deleteByOwner, deleteByStale, deleteAll
- acquireLock/releaseLock/releaseAllStaleLocks provide clean business logic API for lock management
- runs table extended with pause_reason and pause_context columns for Phase 12 Plans 02-03
- RunRepository extended with pauseReason/pauseContext serialization and clearPauseContext method
- Migration 0002 generated and applies cleanly

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema extension and lock repository**
   - `840c2d4` (test: failing tests for lock repo and run pause context)
   - `b489f03` (feat: execution_locks table, lock repository, run pause context)
2. **Task 2: Lock acquire/release business logic**
   - `ad4ecd2` (test: failing tests for lock acquire/release)
   - `8eb90ec` (feat: lock acquire/release with stale cleanup)

_TDD tasks have RED (test) and GREEN (feat) commits_

## Files Created/Modified
- `src/storage/schema.ts` - Added executionLocks table and pause columns to runs
- `src/storage/repositories/locks.ts` - LockRepository with CRUD and stale cleanup
- `src/storage/repositories/runs.ts` - Extended with pauseReason/pauseContext support
- `src/durability/locks.ts` - acquireLock, releaseLock, releaseAllStaleLocks functions
- `drizzle/0002_condemned_matthew_murdock.sql` - Migration for new table and columns
- `test/unit/durability-locks.test.ts` - 17 tests covering all lock and pause functionality

## Decisions Made
- Used unique constraint on (lockType, lockKey) for lock exclusivity -- SQLite enforces atomically, no application-level race conditions
- deleteByStale uses drizzle-orm `ne()` filter for atomic stale lock cleanup rather than find-all-then-delete loop
- releaseLock delegates to deleteByOwner which removes all locks for a run ID -- simpler than filtering by type+key since unique constraint guarantees one lock per type+key

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added deleteByStale method to LockRepository**
- **Found during:** Task 2 (Lock acquire/release business logic)
- **Issue:** Plan specified releaseAllStaleLocks should "find all locks, filter those where daemonPid !== currentPid, delete them" but LockRepository had no method to efficiently do this
- **Fix:** Added `deleteByStale(currentPid)` method using `ne()` filter for atomic SQL deletion
- **Files modified:** src/storage/repositories/locks.ts
- **Verification:** All 17 tests pass including stale lock cleanup scenarios
- **Committed in:** 8eb90ec (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for correct stale lock cleanup. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Execution locks ready for integration with orchestrator dispatch loop
- Pause context columns ready for Plans 02 (crash recovery) and 03 (pause/resume)
- releaseAllStaleLocks ready to be called on daemon startup

---
*Phase: 12-durable-execution*
*Completed: 2026-03-10*
