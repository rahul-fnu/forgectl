---
phase: 16-wire-flight-recorder
plan: 01
subsystem: logging
tags: [event-sourcing, sqlite, flight-recorder, daemon]

requires:
  - phase: 11-flight-recorder
    provides: EventRecorder class, EventRepository, event schema
  - phase: 10-persistent-storage
    provides: SQLite database, Drizzle ORM, repository pattern
provides:
  - EventRecorder wired into daemon lifecycle (instantiation + shutdown cleanup)
  - All 39 emitRunEvent() call sites now persist to SQLite
  - forgectl run inspect returns real event data from database
affects: [12-durable-execution, 13-governance]

tech-stack:
  added: []
  patterns: [daemon-lifecycle-wiring]

key-files:
  created:
    - test/unit/daemon-recorder-wiring.test.ts
  modified:
    - src/daemon/server.ts

key-decisions:
  - "EventRecorder instantiated after repo creation but before RunQueue to capture all events"

patterns-established:
  - "Source-code wiring verification tests: read source as text, assert imports and instantiation"

requirements-completed: [AUDT-01, AUDT-03]

duration: 2min
completed: 2026-03-11
---

# Phase 16 Plan 01: Wire Flight Recorder Summary

**EventRecorder wired into daemon server.ts so all 39 emitRunEvent() call sites persist to SQLite via auto-subscription**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-11T05:01:52Z
- **Completed:** 2026-03-11T05:03:42Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- EventRecorder instantiated in startDaemon() with auto-subscription to runEvents EventEmitter
- recorder.close() called in shutdown before closeDatabase to ensure clean listener removal
- All existing 967 tests pass with no regressions, typecheck clean
- Source-code wiring verification test confirms imports, instantiation, and shutdown order

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Wiring test** - `16c50bf` (test)
2. **Task 1 (GREEN): Wire EventRecorder** - `b9d1e89` (feat)
3. **Task 2: Full suite verification** - no code changes, verification only

## Files Created/Modified
- `test/unit/daemon-recorder-wiring.test.ts` - Source-code verification test (4 assertions)
- `src/daemon/server.ts` - Added EventRecorder imports, instantiation, and shutdown cleanup

## Decisions Made
- EventRecorder instantiated after repo creation but before RunQueue to capture all events from first run

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Flight recorder now persists all events to SQLite automatically
- inspect command will return real event data from database
- Foundation ready for any future event-based features

---
*Phase: 16-wire-flight-recorder*
*Completed: 2026-03-11*
