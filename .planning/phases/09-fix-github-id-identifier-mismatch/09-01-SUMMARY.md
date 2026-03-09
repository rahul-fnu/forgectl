---
phase: 09-fix-github-id-identifier-mismatch
plan: 01
subsystem: tracker
tags: [github-api, issue-id, cross-phase-wiring, bug-fix]

requires:
  - phase: 01-tracker-adapters
    provides: TrackerAdapter interface, GitHub adapter, normalizeIssue
  - phase: 05-orchestration-state-machine
    provides: Dispatcher, reconciler, orchestrator state

provides:
  - Fixed GitHub adapter normalizeIssue using ghIssue.number as TrackerIssue.id
  - Hardened parseIssueNumber accepting both "42" and "#42" formats
  - JSDoc contract on TrackerIssue.id (API-addressable) vs .identifier (display)
  - Cross-phase integration test proving dispatcher-to-tracker ID correctness

affects: [orchestrator, dispatcher, reconciler, tracker]

tech-stack:
  added: []
  patterns: [number-based-issue-id-contract]

key-files:
  created:
    - test/integration/cross-phase-id.test.ts
  modified:
    - src/tracker/types.ts
    - src/tracker/github.ts
    - src/tracker/notion.ts
    - test/unit/tracker-github.test.ts
    - test/unit/orchestrator-dispatcher.test.ts
    - test/unit/orchestrator-reconciler.test.ts
    - test/integration/e2e-orchestration.test.ts

key-decisions:
  - "TrackerIssue.id is the API-addressable identifier (issue number for GitHub, page UUID for Notion)"
  - "parseIssueNumber accepts both plain numbers and #-prefixed identifiers, throws on invalid input"

patterns-established:
  - "Number-based ID contract: TrackerIssue.id must be the value passed to REST API endpoints, not internal DB identifiers"

requirements-completed: [R1.2, R7.3]

duration: 6min
completed: 2026-03-09
---

# Phase 9 Plan 1: Fix GitHub ID/Identifier Mismatch Summary

**Fixed cross-phase wiring bug: normalizeIssue now returns ghIssue.number (API-addressable) instead of ghIssue.id (internal), preventing 404s on all orchestrator mutations**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-09T01:58:59Z
- **Completed:** 2026-03-09T02:05:02Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Fixed the one-line production bug (`id: String(ghIssue.number)`) that caused 404s on all GitHub API mutation calls
- Hardened parseIssueNumber to accept both "42" and "#42" formats and reject invalid input
- Added JSDoc documenting the API-addressable vs display contract on TrackerIssue fields
- Created cross-phase integration test verifying dispatcher and reconciler pass correct IDs
- Updated all test fixtures across 4 test files to use number-based IDs matching the new contract
- All 667 tests passing, zero type errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix production code and update existing unit tests** - `858e4f1` (fix)
2. **Task 2: Cross-phase integration test and test fixture updates** - `575bd13` (test)

## Files Created/Modified
- `src/tracker/types.ts` - Added JSDoc on TrackerIssue.id and .identifier fields
- `src/tracker/github.ts` - Fixed normalizeIssue id, hardened parseIssueNumber
- `src/tracker/notion.ts` - Added JSDoc on normalizePage for consistency
- `test/unit/tracker-github.test.ts` - Updated id assertions, added 3 new tests
- `test/integration/cross-phase-id.test.ts` - New cross-phase integration test (5 tests)
- `test/unit/orchestrator-dispatcher.test.ts` - Updated makeIssue default to number-based id
- `test/unit/orchestrator-reconciler.test.ts` - Updated makeWorkerInfo default to number-based id
- `test/integration/e2e-orchestration.test.ts` - Updated all fixtures to number-based ids

## Decisions Made
- TrackerIssue.id is the API-addressable identifier (issue number for GitHub, page UUID for Notion) -- not an internal database identifier
- parseIssueNumber accepts both plain numbers ("42") and hash-prefixed identifiers ("#42"), throwing on invalid input rather than returning NaN silently

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed reconciler test identifier assertions**
- **Found during:** Task 2 (test fixture updates)
- **Issue:** Reconciler test checked `removeWorkspace("GH-1")` but identifier was updated to `"#1"`
- **Fix:** Updated all `"GH-*"` identifier references in reconciler tests to `"#*"` format
- **Files modified:** test/unit/orchestrator-reconciler.test.ts
- **Verification:** Full test suite passes
- **Committed in:** 575bd13 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for test consistency. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The GitHub adapter ID/identifier mismatch is fully resolved
- All orchestrator mutation paths (postComment, updateState, updateLabels, fetchIssueStatesByIds) now receive the correct API-addressable issue number
- v1.0 gap closure is complete

---
*Phase: 09-fix-github-id-identifier-mismatch*
*Completed: 2026-03-09*
