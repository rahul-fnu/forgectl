---
phase: 25-sub-issue-dag-dependencies
plan: "02"
subsystem: tracker
tags: [github, sub-issues, dag, scheduler, webhooks, cache, octokit]

# Dependency graph
requires:
  - phase: 25-sub-issue-dag-dependencies plan 01
    provides: SubIssueCache (TTL cache) and detectIssueCycles (3-color DFS) standalone modules

provides:
  - Sub-issue enrichment wired into GitHub adapter (fetchCandidateIssues populates blocked_by)
  - ghInternalId stored in TrackerIssue metadata for all GitHub issues
  - Auto-discovery of sub-issues as dispatch candidates
  - Scheduler tick populates terminalIssueIds from SubIssueCache (SUBISSUE-03)
  - Webhook handler invalidates SubIssueCache on issues.edited (SUBISSUE-04)
  - Cycle detection integrated into GitHub adapter fetch flow (SUBISSUE-04)
  - Backward compatibility preserved: all new fields optional, no behavior change when absent

affects:
  - 25-sub-issue-dag-dependencies (phase complete)
  - 28-sub-issue-advanced (builds on this sub-issue data flow)
  - src/orchestrator/scheduler.ts (TickDeps now accepts subIssueCache)
  - src/github/webhooks.ts (WebhookDeps now accepts subIssueCache)
  - src/tracker/github.ts (enriched with sub-issue fetch and cycle detection)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional injection pattern: new cache fields in deps interfaces are optional (?) for backward compat"
    - "mockRejectedValueOnce vs mockRejectedValue: use Once variant in tests to prevent cross-test mock contamination"

key-files:
  created: []
  modified:
    - src/tracker/github.ts
    - src/orchestrator/scheduler.ts
    - src/github/webhooks.ts
    - test/unit/tracker-github.test.ts
    - test/unit/orchestrator-scheduler.test.ts

key-decisions:
  - "Optional injection for subIssueCache in TickDeps and WebhookDeps -- Notion adapter users unaffected, backward compat preserved"
  - "Webhook invalidation on issues.edited is best-effort -- TTL is the reliable fallback per user decision in 25-RESEARCH.md"
  - "terminalIssueIds populated from SubIssueCache.getAllEntries() at tick time -- fresh data per tick, lazy TTL cleanup as side effect"

patterns-established:
  - "Optional dep injection: add cache to deps interface as optional field, check before use"
  - "Test isolation: use mockRejectedValueOnce not mockRejectedValue to avoid contaminating subsequent tests"

requirements-completed: [SUBISSUE-01, SUBISSUE-02, SUBISSUE-03, SUBISSUE-04]

# Metrics
duration: 100min
completed: 2026-03-13
---

# Phase 25 Plan 02: Sub-Issue DAG Wire-Up Summary

**SubIssueCache and cycle detection wired into GitHub adapter, scheduler terminalIssueIds, and webhook invalidation for dependency-aware dispatch**

## Performance

- **Duration:** ~100 min (both tasks, continuation agent)
- **Started:** 2026-03-13T05:19:00Z
- **Completed:** 2026-03-13T07:08:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- GitHub adapter enriches every candidate issue with sub-issue data from SubIssueCache, populating `blocked_by` and `metadata.ghInternalId`
- Scheduler `tick()` builds `terminalIssueIds` from SubIssueCache entries at each tick, unblocking parents whose children have reached terminal states
- `issues.edited` webhook handler invalidates the SubIssueCache entry for the edited issue, keeping sub-issue relationships fresh
- Auto-discovery: sub-issues fetched during enrichment are added as dispatch candidates automatically
- Cycle detection via `detectIssueCycles` runs on all enriched candidates per fetch; cycles are logged as warnings
- All 1,060 tests pass with no regressions; TypeScript compiles clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Integrate sub-issue fetch and enrichment into GitHub adapter** - `a695ceb` (feat)
2. **Task 2: Wire scheduler terminalIssueIds and webhook cache invalidation** - `a012866` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified
- `src/tracker/github.ts` - normalizeIssue stores ghInternalId; fetchCandidateIssues enriches with sub-issues, auto-discovers, runs cycle detection
- `src/orchestrator/scheduler.ts` - TickDeps gains optional subIssueCache; tick() builds terminalIssueIds from cache
- `src/github/webhooks.ts` - WebhookDeps gains optional subIssueCache; issues.edited handler invalidates cache entry
- `test/unit/tracker-github.test.ts` - Tests for ghInternalId storage, blocked_by population, cache hit/miss, rate limit degradation, auto-discovery
- `test/unit/orchestrator-scheduler.test.ts` - Tests for terminalIssueIds population, backward compat, custom terminal_states; fixed test isolation bug

## Decisions Made
- Optional injection pattern used for `subIssueCache` in `TickDeps` and `WebhookDeps` -- both fields are `?` optional, so callers not passing a cache (Notion adapter users, existing code) see no behavior change
- Webhook invalidation on `issues.edited` is best-effort; TTL (5 min default) is the reliable fallback
- `terminalIssueIds` populated at the start of every `tick()` call using `getAllEntries()` which also performs lazy TTL cleanup

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test isolation: mockRejectedValue -> mockRejectedValueOnce**
- **Found during:** Task 2 (scheduler test implementation)
- **Issue:** The "handles reconcile errors gracefully" test used `mockRejectedValue` (permanent) instead of `mockRejectedValueOnce`. After `vi.clearAllMocks()` (which calls `mockClear`, not `mockReset`), the rejection implementation persisted into subsequent tests, causing `tick()` to return early in all subIssueCache tests. `filterCandidates` was never called, making `mock.calls[0]` undefined.
- **Fix:** Changed `mockRejectedValue` to `mockRejectedValueOnce` so the rejection only fires once and doesn't contaminate subsequent tests
- **Files modified:** test/unit/orchestrator-scheduler.test.ts
- **Verification:** All 16 scheduler tests pass when run together and in isolation
- **Committed in:** a012866 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug)
**Impact on plan:** Bug-only fix, no scope change. vitest `clearAllMocks` does not reset implementations -- `mockRejectedValueOnce` is the correct pattern for single-shot error injection in test suites.

## Issues Encountered
- vitest mock clearing behavior: `vi.clearAllMocks()` calls `mockClear()` which clears call history but NOT implementation. Tests that set permanent mock overrides (like `mockRejectedValue`) contaminate subsequent tests in the same `describe` block. Root cause identified by running the failing tests in isolation (they passed) vs. the full suite (they failed). Fixed by switching to `mockRejectedValueOnce`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 25 (Sub-Issue DAG Dependencies) is complete. All 4 requirements satisfied: SUBISSUE-01 through SUBISSUE-04.
- Phase 28 (Sub-Issue Advanced) can now proceed, building on the sub-issue data flow established here.
- Callers that want sub-issue-aware dispatch need to pass `subIssueCache` to `TickDeps` and `WebhookDeps` -- the GitHub adapter already exposes it as `adapter.subIssueCache`.

---
*Phase: 25-sub-issue-dag-dependencies*
*Completed: 2026-03-13*
