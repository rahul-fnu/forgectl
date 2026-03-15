---
phase: 25-sub-issue-dag-dependencies
plan: 01
subsystem: tracker
tags: [cache, dag, cycle-detection, dfs, ttl, sub-issues]

# Dependency graph
requires: []
provides:
  - SubIssueCache class with TTL-based expiry, get/set/invalidate/invalidateAll/getAllEntries
  - detectIssueCycles() function for issue dependency graph cycle detection
  - IssueDAGNode interface for typed issue graph inputs
  - SubIssueEntry interface for typed cache entries
affects:
  - 25-02 (GitHub adapter and scheduler integration will import both modules)
  - 25-sub-issue-dag-dependencies (all remaining plans in this phase)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TTL cache with lazy expiry: check TTL on read, filter on getAllEntries() -- no background timer needed"
    - "3-color DFS (WHITE/GRAY/BLACK) cycle detection adapted for issue graphs with external ref filtering"
    - "External reference filtering: blocked_by IDs not in input set are silently ignored (cross-repo deps)"

key-files:
  created:
    - src/tracker/sub-issue-cache.ts
    - src/tracker/sub-issue-dag.ts
    - test/unit/tracker-sub-issue-cache.test.ts
    - test/unit/tracker-sub-issue-dag.test.ts
  modified: []

key-decisions:
  - "Standalone DFS cycle detector instead of reusing validateDAG() -- pipeline/dag.ts errors on unknown node refs which are valid in issue graphs"
  - "Lazy TTL expiry on read and getAllEntries() -- no setInterval/background cleanup needed"
  - "External blocked_by refs silently filtered (not errored) -- cross-repo issue references are expected"

patterns-established:
  - "SubIssueCache lazy cleanup: expired entries deleted on get() and getAllEntries(), never by timer"
  - "Issue DAG cycle detection: filter to known IDs first, then DFS -- handles incomplete graph subsets"

requirements-completed: [SUBISSUE-01, SUBISSUE-04]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 25 Plan 01: Sub-Issue Cache and DAG Cycle Detection Summary

**TTL cache for sub-issue relationships and standalone DFS cycle detector for issue dependency graphs, both designed to ignore external/cross-repo references**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-13T05:15:26Z
- **Completed:** 2026-03-13T05:18:26Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- SubIssueCache with 5-minute default TTL, lazy expiry on read, getAllEntries() for scheduler terminalIssueIds population
- detectIssueCycles() with standalone 3-color DFS that silently ignores cross-repo blocked_by references
- 26 unit tests (15 cache, 11 DAG) all passing including vi.useFakeTimers() TTL testing

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SubIssueCache module with TTL and invalidation** - `6708588` (feat)
2. **Task 2: Create sub-issue-dag cycle detection adapter** - `4e6152a` (feat)

## Files Created/Modified

- `src/tracker/sub-issue-cache.ts` - TTL cache for parent->children sub-issue mappings, lazy expiry
- `src/tracker/sub-issue-dag.ts` - Standalone DFS cycle detector for issue dependency graphs
- `test/unit/tracker-sub-issue-cache.test.ts` - 15 tests with fake timers for TTL behavior
- `test/unit/tracker-sub-issue-dag.test.ts` - 11 tests covering cycles, diamonds, external refs

## Decisions Made

- Used standalone DFS rather than reusing `validateDAG()` from `pipeline/dag.ts`: the pipeline validator errors on unknown node references (step 2 in its logic), but issue DAGs legitimately reference cross-repo issues not in the local set. A bespoke implementation avoids the mismatch.
- Lazy TTL cleanup (check-on-read) avoids any background timer or interval, keeping the cache zero-maintenance.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `npx vitest` failed due to Node.js version incompatibility (v20.11.1 vs required v20.19.0+ for rolldown). Resolved by running `npm install` to populate local `node_modules/.bin/vitest` and invoking it directly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both modules export clean interfaces ready for Plan 02 integration into the GitHub adapter and scheduler.
- SubIssueCache is adapter-agnostic (no GitHub-specific code), so it can be used by future Notion sub-issue support.
- detectIssueCycles() accepts IssueDAGNode[] which maps directly to TrackerIssue fields (id + blocked_by).

---
*Phase: 25-sub-issue-dag-dependencies*
*Completed: 2026-03-13*
