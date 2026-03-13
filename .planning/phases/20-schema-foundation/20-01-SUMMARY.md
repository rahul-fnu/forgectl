---
phase: 20-schema-foundation
plan: 01
subsystem: database
tags: [drizzle, sqlite, repository-pattern, pipeline, filtrex, schema-migration]

# Dependency graph
requires: []
provides:
  - "SQLite migration 0005: 5 new columns on runs table + delegations table with 2 indexes"
  - "DelegationRepository with 7 CRUD methods and JSON serialization"
  - "Extended RunRow/RunInsertParams/RunUpdateParams with delegation fields"
  - "Extended PipelineNode interface with node_type, condition, else_node, if_failed, if_passed, loop"
  - "Extended PipelineNodeSchema Zod validation for all new pipeline node fields"
  - "filtrex@^3.1.0 installed and type-resolvable (not yet imported)"
affects: [21-conditional-nodes, 22-loop-nodes, 23-delegation, 24-self-correction]

# Tech tracking
tech-stack:
  added: [filtrex@3.1.0]
  patterns:
    - "Drizzle repository factory pattern (createXRepository(db)) extended to delegations table"
    - "JSON column round-trip via JSON.stringify/JSON.parse in deserializeRow()"
    - "Hand-written SQL migrations with --> statement-breakpoint separators"

key-files:
  created:
    - drizzle/0005_delegation_schema.sql
    - src/storage/repositories/delegations.ts
    - test/unit/storage-delegations-repo.test.ts
  modified:
    - drizzle/meta/_journal.json
    - src/storage/schema.ts
    - src/storage/repositories/runs.ts
    - src/pipeline/types.ts
    - src/pipeline/parser.ts
    - package.json
    - package-lock.json

key-decisions:
  - "delegations table uses INTEGER AUTOINCREMENT id (not UUID) — repo method uses Number(result.lastInsertRowid)"
  - "filtrex installed but not imported — noUnusedLocals:true would error; Phase 21 adds the import"
  - "All 5 new runs columns are nullable/defaulted — backward compat, existing INSERT calls unchanged"
  - "PipelineNode extension is purely additive — all new fields optional, existing pipelines parse unchanged"

patterns-established:
  - "Delegation repo pattern: factory function returns object literal with typed methods, mirrors runs.ts"
  - "updateStatus completedAt: set automatically when status is 'completed' or 'failed'"

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-03-13
---

# Phase 20 Plan 01: Schema Foundation Summary

**SQLite migration 0005 with delegations table + extended runs columns, DelegationRepository with 7 CRUD methods, PipelineNode interface extended for conditional/loop nodes, filtrex@3.1.0 installed**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-13T02:52:00Z
- **Completed:** 2026-03-13T02:54:00Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Drizzle migration 0005 adds `parent_run_id`, `role`, `depth`, `max_children`, `children_dispatched` to runs table and creates delegations table with 10 columns and 2 indexes
- DelegationRepository created following exact factory pattern from runs.ts with all 7 methods: insert, findById, findByParentRunId, findByChildRunId, updateStatus, countByParentAndStatus, list
- RunRow/RunInsertParams/RunUpdateParams extended with 5 delegation fields — all optional for backward compatibility
- PipelineNode interface and PipelineNodeSchema Zod extended with node_type, condition, else_node, if_failed, if_passed, loop — all optional, existing pipelines parse unchanged
- filtrex@^3.1.0 installed; not imported in any source file (Phase 21 will import it)
- 1,040 tests pass (up from 1,021 — 19 new delegation tests added), zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema migration, runs column extension, and delegations repository** - `00cb030` (feat)
2. **Task 2: PipelineNode type extensions and filtrex installation** - `2aaf94d` (feat)

**Plan metadata:** _(final docs commit follows)_

_Note: Task 1 used TDD (test written first, confirmed failing, then implementation made tests pass)_

## Files Created/Modified

- `drizzle/0005_delegation_schema.sql` - Migration: 5 ALTER TABLE on runs, CREATE TABLE delegations, 2 indexes
- `drizzle/meta/_journal.json` - Added idx:5 entry for 0005_delegation_schema
- `src/storage/schema.ts` - Added 5 columns to runs table, added delegations table definition
- `src/storage/repositories/runs.ts` - Extended RunRow/RunInsertParams/RunUpdateParams and insert/updateStatus/deserializeRow
- `src/storage/repositories/delegations.ts` - New DelegationRepository (7 methods, JSON round-trip for taskSpec/result)
- `src/pipeline/types.ts` - Extended PipelineNode interface with conditional/loop fields
- `src/pipeline/parser.ts` - Extended PipelineNodeSchema Zod with matching optional fields
- `package.json` + `package-lock.json` - filtrex@^3.1.0 added
- `test/unit/storage-delegations-repo.test.ts` - 35 tests for DelegationRepository

## Decisions Made

- Used `Number(result.lastInsertRowid)` to convert BigInt from better-sqlite3 to number for the delegation id
- Set `completedAt` automatically in `updateStatus()` when status becomes 'completed' or 'failed' — avoids callers needing to pass timestamp
- `filtrex` is installed but not imported in any source file to avoid `noUnusedLocals` TypeScript error

## Deviations from Plan

### Out-of-scope discovery (not fixed, deferred)

**Pre-existing: `npm run lint` broken — no eslint.config.js in project root**
- **Found during:** Task 2 (lint verification)
- **Issue:** ESLint v9 flat config required but no config file exists (never existed in this repo)
- **Action:** Logged to `deferred-items.md`, not fixed (pre-existing, out of scope)
- **Impact:** Zero — `npm run typecheck` passes cleanly, which is the authoritative TypeScript check

---

**Total deviations:** 0 auto-fixes (1 out-of-scope pre-existing issue deferred)
**Impact on plan:** No scope changes. All plan objectives met.

## Issues Encountered

None beyond the pre-existing ESLint config absence documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 21 (Conditional Nodes): Can now import filtrex and use `PipelineNode.condition`, `node_type`, `else_node`, `if_failed`, `if_passed` fields
- Phase 22 (Loop Nodes): Can use `PipelineNode.loop` field
- Phase 23 (Delegation): Can use `delegations` table via `DelegationRepository` and the 5 new `runs` columns (parentRunId, role, depth, maxChildren, childrenDispatched)
- Phase 24 (Self-Correction): Depends on Phases 21-23 being complete first

---
*Phase: 20-schema-foundation*
*Completed: 2026-03-13*
