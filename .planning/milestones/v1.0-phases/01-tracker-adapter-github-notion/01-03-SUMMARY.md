---
phase: 01-tracker-adapter-github-notion
plan: 03
subsystem: tracker
tags: [notion-api, rich-text, throttle, pagination, delta-polling]

# Dependency graph
requires:
  - phase: 01-tracker-adapter-github-notion/01
    provides: TrackerAdapter interface, TrackerIssue model, TrackerConfig type, resolveToken, registry
provides:
  - Notion database TrackerAdapter implementation with all 6 methods
  - createNotionAdapter factory function
  - Rich text to markdown converter
  - Request throttle (3 req/s) with 429 retry
  - Delta polling via last_edited_time filter
  - Configurable property_map for Notion property names
affects: [01-04]

# Tech tracking
tech-stack:
  added: []
  patterns: [native fetch for API calls, timestamp-based throttle queue, rich text annotation to markdown]

key-files:
  created:
    - src/tracker/notion.ts
    - test/unit/tracker-notion.test.ts
  modified: []

key-decisions:
  - "Used native fetch instead of adding an HTTP client library — keeps dependencies minimal"
  - "Throttle uses timestamp array tracking rather than token bucket — simpler for low concurrency"
  - "Default property_map covers common Notion database layouts (Name, Status, Priority, Tags, Assignee, Description)"

patterns-established:
  - "Notion API wrapper: throttle() -> notionFetch() -> domain method pattern"
  - "Rich text to markdown: annotation-aware conversion for bold/italic/code/strikethrough"
  - "Delta polling: store lastPollTime, filter by last_edited_time on subsequent calls"

requirements-completed: [R1.3]

# Metrics
duration: 2min
completed: 2026-03-07
---

# Phase 01 Plan 03: Notion Adapter Summary

**Notion database TrackerAdapter with delta polling, configurable property mapping, rich text to markdown, 3 req/s throttle, and write-back operations**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-07T21:15:03Z
- **Completed:** 2026-03-07T21:19:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments
- Full Notion TrackerAdapter with all 6 interface methods (fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates, postComment, updateState, updateLabels)
- Delta polling using last_edited_time filter for efficient subsequent queries
- Pagination through start_cursor/has_more for large databases
- Configurable property_map with sensible defaults for common Notion layouts
- Rich text annotation to markdown conversion (bold, italic, code, strikethrough)
- Request throttle enforcing max 3 requests/second with 429 Retry-After support
- 25 unit tests covering all methods, edge cases, throttle behavior, and error handling

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add failing tests for Notion adapter** - `15e5c76` (test, TDD)
2. **Task 1 (GREEN): Implement Notion adapter** - `53364a4` (feat, TDD)

## Files Created/Modified
- `src/tracker/notion.ts` - Full Notion TrackerAdapter implementation + createNotionAdapter factory
- `test/unit/tracker-notion.test.ts` - 25 unit tests with mocked fetch covering all adapter methods

## Decisions Made
- Used native fetch instead of adding an HTTP client library -- keeps dependencies minimal and Node 20+ has built-in fetch
- Throttle uses simple timestamp array tracking rather than token bucket -- sufficient for serial API usage
- Default property_map covers the most common Notion database column names (Name, Status, Priority, Tags, Assignee, Description)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Notion adapter ready for registration in the tracker adapter registry (Plan 04)
- createNotionAdapter factory follows same pattern as GitHub adapter for registry integration
- All 300 existing tests continue to pass (no regressions)

---
*Phase: 01-tracker-adapter-github-notion*
*Completed: 2026-03-07*
