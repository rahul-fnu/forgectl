---
phase: 10-persistent-storage-layer
plan: 01
subsystem: database
tags: [sqlite, drizzle-orm, better-sqlite3, migrations, wal]

requires:
  - phase: none
    provides: greenfield storage layer
provides:
  - SQLite database singleton (createDatabase, closeDatabase, AppDatabase)
  - Drizzle ORM schema for runs and pipeline_runs tables
  - Migration runner (runMigrations) with auto-discovery of migrations folder
  - storage.db_path configuration field
  - Build tooling for native module externalization and migration shipping
affects: [10-02, 11-company-agent-identity, 12-flight-recorder, 13-durable-execution]

tech-stack:
  added: [drizzle-orm, better-sqlite3, drizzle-kit, "@types/better-sqlite3"]
  patterns: [drizzle-schema-definitions, sqlite-wal-mode, native-module-externalization]

key-files:
  created:
    - src/storage/database.ts
    - src/storage/schema.ts
    - src/storage/migrator.ts
    - drizzle.config.ts
    - drizzle/0000_mature_winter_soldier.sql
    - test/unit/storage-database.test.ts
    - test/unit/storage-migrator.test.ts
  modified:
    - package.json
    - tsup.config.ts
    - src/config/schema.ts

key-decisions:
  - "WAL journal mode for concurrent read/write performance"
  - "busy_timeout=5000ms to handle lock contention gracefully"
  - "Drizzle schema uses camelCase TS properties mapped to snake_case SQL columns"
  - "Migrator auto-discovers drizzle/ folder from both src and dist paths"

patterns-established:
  - "Database creation: createDatabase(path?) returns typed Drizzle instance with schema"
  - "Migration: runMigrations(db) at daemon startup, idempotent"
  - "Native modules: externalized in tsup, not bundled"

requirements-completed: [STOR-01, STOR-02]

duration: 3min
completed: 2026-03-09
---

# Phase 10 Plan 01: Storage Foundation Summary

**SQLite database with Drizzle ORM, WAL mode, runs/pipeline_runs schema, and idempotent migrator**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-09T05:05:25Z
- **Completed:** 2026-03-09T05:08:53Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- SQLite database singleton with WAL mode, foreign keys, and busy timeout configured
- Drizzle ORM schema defining runs and pipeline_runs tables matching existing in-memory types
- Idempotent migration runner with dev/prod path auto-discovery
- Build tooling updated to externalize better-sqlite3 and ship migrations

## Task Commits

Each task was committed atomically:

1. **Task 1: Install dependencies, create database singleton and schema** - `9b876d8` (feat)
2. **Task 2: Create migrator with initial migration and tests** - `a58c8cb` (feat)

## Files Created/Modified
- `src/storage/database.ts` - Database singleton with createDatabase(), closeDatabase(), AppDatabase type
- `src/storage/schema.ts` - Drizzle table definitions for runs and pipelineRuns
- `src/storage/migrator.ts` - Migration runner with auto-discovery of drizzle/ folder
- `drizzle.config.ts` - Drizzle Kit configuration for migration generation
- `drizzle/0000_mature_winter_soldier.sql` - Initial migration creating both tables
- `tsup.config.ts` - Externalized better-sqlite3, added drizzle/ copy to dist
- `src/config/schema.ts` - Added storage.db_path configuration field
- `package.json` - Added drizzle-orm, better-sqlite3, drizzle-kit, @types/better-sqlite3
- `test/unit/storage-database.test.ts` - 7 tests for database creation and configuration
- `test/unit/storage-migrator.test.ts` - 5 tests for migration execution, idempotency, CRUD

## Decisions Made
- WAL journal mode for concurrent read/write performance
- busy_timeout=5000ms to handle lock contention gracefully
- Drizzle schema uses camelCase TypeScript properties mapped to snake_case SQL columns
- Migrator auto-discovers drizzle/ folder supporting both src/ and dist/ layouts

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- SQLite `busy_timeout` pragma returns `{ timeout: 5000 }` not `{ busy_timeout: 5000 }` -- fixed test expectation accordingly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Database foundation ready for plan 02 (CRUD repositories, daemon integration)
- All 12 new tests pass, full suite at 679 tests passing
- TypeScript compiles cleanly, build succeeds with native module externalized

## Self-Check: PASSED

- All 7 created files verified present
- Commit 9b876d8 (Task 1) verified in git log
- Commit a58c8cb (Task 2) verified in git log

---
*Phase: 10-persistent-storage-layer*
*Completed: 2026-03-09*
