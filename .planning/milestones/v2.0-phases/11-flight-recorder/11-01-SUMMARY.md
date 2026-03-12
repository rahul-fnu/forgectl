---
phase: 11-flight-recorder
plan: 01
subsystem: database
tags: [sqlite, drizzle-orm, event-sourcing, audit-trail, eventEmitter]

# Dependency graph
requires:
  - phase: 10-persistent-storage
    provides: "SQLite database, Drizzle ORM schema, repository pattern, migrator"
provides:
  - "runEvents and runSnapshots Drizzle tables with auto-increment PKs"
  - "EventRepository with insert, findByRunId, findByRunIdAndType"
  - "SnapshotRepository with insert, findByRunId, latest"
  - "EventRecorder subscriber that persists runEvents to DB"
  - "Extended RunEvent type with prompt, agent_response, validation_step, cost, snapshot"
affects: [11-flight-recorder, 12-durable-execution, 13-governance]

# Tech tracking
tech-stack:
  added: []
  patterns: [append-only-events, event-subscriber-persistence, error-swallowing-subscriber]

key-files:
  created:
    - src/storage/repositories/events.ts
    - src/storage/repositories/snapshots.ts
    - src/logging/recorder.ts
    - drizzle/0001_shiny_joshua_kane.sql
    - test/unit/storage-events.test.ts
    - test/unit/storage-snapshots.test.ts
    - test/unit/event-recorder.test.ts
  modified:
    - src/storage/schema.ts
    - src/logging/events.ts

key-decisions:
  - "EventRecorder swallows insert errors to never crash the emitter"
  - "Auto-increment integer PKs for event/snapshot ordering (not UUIDs)"
  - "Snapshot capture is explicit via captureSnapshot(), not automatic on every event"

patterns-established:
  - "Append-only event tables: insert-only repositories with no update/delete methods"
  - "Subscriber error isolation: try/catch in event handlers, log to stderr, never re-throw"

requirements-completed: [AUDT-01, AUDT-04]

# Metrics
duration: 4min
completed: 2026-03-10
---

# Phase 11 Plan 01: Flight Recorder Foundation Summary

**Append-only event and snapshot tables with EventRecorder subscriber persisting runEvents to SQLite via Drizzle repositories**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T02:07:52Z
- **Completed:** 2026-03-10T02:11:22Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Append-only runEvents and runSnapshots tables with auto-increment PKs and JSON serialization
- EventRepository and SnapshotRepository following Phase 10 pattern with full CRUD coverage
- EventRecorder class that subscribes to runEvents emitter and persists to DB without blocking
- Extended RunEvent type union with 5 new event types for flight recording
- 20 new unit tests all passing (720 total suite)

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema, migration, and repositories** - `d3ba424` (feat)
2. **Task 2: EventRecorder and extended RunEvent types** - `52c0399` (feat)

_TDD tasks: tests written first (RED), implementation second (GREEN)._

## Files Created/Modified
- `src/storage/schema.ts` - Added runEvents and runSnapshots table definitions
- `src/storage/repositories/events.ts` - EventRepository with insert, findByRunId, findByRunIdAndType
- `src/storage/repositories/snapshots.ts` - SnapshotRepository with insert, findByRunId, latest
- `src/logging/events.ts` - Extended RunEvent type union with 5 new types
- `src/logging/recorder.ts` - EventRecorder class subscribing to runEvents emitter
- `drizzle/0001_shiny_joshua_kane.sql` - Migration for new tables
- `test/unit/storage-events.test.ts` - 8 tests for EventRepository
- `test/unit/storage-snapshots.test.ts` - 6 tests for SnapshotRepository
- `test/unit/event-recorder.test.ts` - 6 tests for EventRecorder

## Decisions Made
- EventRecorder swallows insert errors to never crash the emitter (console.error only)
- Auto-increment integer PKs for event/snapshot ordering (natural insertion order)
- Snapshot capture is explicit method call, not automatic on every event type

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Event and snapshot storage layer complete, ready for Plan 02 (CLI inspect commands and rich write-back)
- EventRecorder ready to be wired into the daemon/orchestrator lifecycle
- All 720 tests passing, typecheck clean

---
*Phase: 11-flight-recorder*
*Completed: 2026-03-10*
