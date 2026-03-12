---
phase: 10-persistent-storage-layer
plan: 02
subsystem: database
tags: [sqlite, drizzle-orm, repository-pattern, crud, daemon-persistence]

requires:
  - phase: 10-01
    provides: SQLite database singleton, Drizzle schema, migrator
provides:
  - RunRepository with typed CRUD (insert, findById, updateStatus, findByStatus, list)
  - PipelineRepository with typed CRUD (insert, findById, updateStatus, updateNodeStates, list)
  - RunQueue persists all state to SQLite via RunRepository
  - PipelineRunService persists metadata to SQLite via PipelineRepository
  - Daemon startup initializes database, runs migrations, injects repositories
  - Daemon shutdown closes database connection
affects: [11-company-agent-identity, 12-flight-recorder, 13-durable-execution]

tech-stack:
  added: []
  patterns: [repository-pattern, json-serialization-in-sqlite, constructor-injection]

key-files:
  created:
    - src/storage/repositories/runs.ts
    - src/storage/repositories/pipelines.ts
    - test/unit/storage-runs-repo.test.ts
    - test/unit/storage-pipelines-repo.test.ts
  modified:
    - src/daemon/queue.ts
    - src/daemon/pipeline-service.ts
    - src/daemon/server.ts
    - test/unit/daemon.test.ts
    - test/unit/board-routes.test.ts
    - test/unit/pipeline-rerun-route.test.ts

key-decisions:
  - "Repository pattern with synchronous methods (better-sqlite3 is sync, no async/await needed)"
  - "JSON columns manually serialized/deserialized in repository layer (not in schema)"
  - "PipelineRunService keeps in-memory Map for active runs alongside repo for durability"
  - "PipelineRepository is optional in PipelineRunService constructor for backward compatibility"

patterns-established:
  - "Repository factory: createXxxRepository(db) returns interface with CRUD methods"
  - "Constructor injection: RunQueue(repo, onExecute), PipelineRunService(repo?)"
  - "JSON round-trip: serialize to string on insert/update, parse on select"

requirements-completed: [STOR-03]

duration: 7min
completed: 2026-03-09
---

# Phase 10 Plan 02: Repository Pattern and Daemon Integration Summary

**Typed run/pipeline repositories with SQLite persistence wired into RunQueue, PipelineRunService, and daemon startup**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-09T05:11:35Z
- **Completed:** 2026-03-09T05:18:44Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- RunRepository and PipelineRepository with full CRUD, JSON round-tripping, and type-safe interfaces
- RunQueue refactored from in-memory array to SQLite-backed repository (runs survive restarts)
- PipelineRunService augmented with optional PipelineRepository for durable metadata
- Daemon startup initializes database and migrations before accepting requests, shutdown closes connection

## Task Commits

Each task was committed atomically:

1. **Task 1: Create typed repositories (TDD RED)** - `6a5d6dd` (test)
2. **Task 1: Create typed repositories (TDD GREEN)** - `789127d` (feat)
3. **Task 2: Wire repositories into daemon** - `a2f6218` (feat)

## Files Created/Modified
- `src/storage/repositories/runs.ts` - RunRepository interface and factory with CRUD operations
- `src/storage/repositories/pipelines.ts` - PipelineRepository interface and factory with CRUD operations
- `src/daemon/queue.ts` - RunQueue refactored to use RunRepository instead of in-memory array
- `src/daemon/pipeline-service.ts` - PipelineRunService with optional PipelineRepository injection
- `src/daemon/server.ts` - Database initialization, migration, repository creation, and cleanup on shutdown
- `test/unit/storage-runs-repo.test.ts` - 11 tests for run repository CRUD
- `test/unit/storage-pipelines-repo.test.ts` - 9 tests for pipeline repository CRUD
- `test/unit/daemon.test.ts` - Updated for new constructor signature, added persistence test
- `test/unit/board-routes.test.ts` - Updated RunQueue constructor for new signature
- `test/unit/pipeline-rerun-route.test.ts` - Updated RunQueue constructor for new signature

## Decisions Made
- Repository methods are synchronous (better-sqlite3 driver is sync; no unnecessary async)
- JSON columns serialized/deserialized in repository layer rather than schema layer for explicit control
- PipelineRunService keeps in-memory Map alongside repo (executor/promise are runtime objects, not persistable)
- PipelineRepository is optional in constructor for backward compatibility in tests

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pipeline rerun 404 after activeRuns cleanup**
- **Found during:** Task 2 (full test suite verification)
- **Issue:** Initial implementation removed completed entries from activeRuns Map, causing rerun lookups to fail when no repo was available
- **Fix:** Kept completed entries in activeRuns Map for in-process lookups; repo provides durability across restarts
- **Files modified:** src/daemon/pipeline-service.ts
- **Verification:** pipeline-rerun-route tests pass (700/700)
- **Committed in:** a2f6218 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix to maintain backward compatibility. No scope creep.

## Issues Encountered
- Test for RunQueue persistence initially asserted "queued" status but async processing changed it to "running" before assertion -- fixed by waiting for completion and asserting "completed" instead.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Storage layer complete: database, schema, migrations, repositories, and daemon integration all wired
- 700 tests passing, TypeScript compiles cleanly, build succeeds
- Phase 10 is complete -- ready for Phase 11 (Company & Agent Identity)

## Self-Check: PASSED

- All 4 created files verified present
- Commit 6a5d6dd (Task 1 RED) verified in git log
- Commit 789127d (Task 1 GREEN) verified in git log
- Commit a2f6218 (Task 2) verified in git log

---
*Phase: 10-persistent-storage-layer*
*Completed: 2026-03-09*
