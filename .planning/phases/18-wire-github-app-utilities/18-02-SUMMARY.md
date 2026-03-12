---
phase: 18-wire-github-app-utilities
plan: 02
subsystem: orchestrator
tags: [github, checks, pr-description, worker, wiring]

requires:
  - phase: 18-wire-github-app-utilities
    provides: GitHubDeps pattern, toRunResult mapping, progress comment lifecycle (18-01)
  - phase: 14-github-app
    provides: github/checks.ts, github/pr-description.ts modules

provides:
  - Check run lifecycle wired into worker (create/update/complete)
  - PR description auto-generation after successful runs with branch
  - updatePRDescriptionForBranch with branch-based PR lookup and human-description preservation
  - forgectl-generated marker for safe PR description overwrite detection

affects: [orchestrator, worker, github-app]

tech-stack:
  added: []
  patterns: [check-run-lifecycle-in-worker, branch-based-pr-description-lookup, forgectl-marker-detection]

key-files:
  created:
    - test/unit/wiring-checks.test.ts
    - test/unit/wiring-pr-description.test.ts
  modified:
    - src/orchestrator/worker.ts
    - src/github/pr-description.ts

key-decisions:
  - "GitHubDeps extended with headSha and repoContext for check run and PR description API calls"
  - "updatePRDescriptionForBranch does branch-based PR lookup with human-description preservation via forgectl-generated marker"
  - "Check run and PR description errors caught and logged as warnings (never crash worker)"
  - "PRDescriptionData mapped from RunResult with fallback defaults for missing cost/agent fields"

patterns-established:
  - "Check run lifecycle: create at worker start (if headSha), update after validation, complete at end"
  - "PR description: generate after output collection when branch and repoContext available"
  - "Human PR description preservation: skip update if body exists without forgectl-generated marker"

requirements-completed: [GHAP-08, GHAP-09]

duration: 5min
completed: 2026-03-12
---

# Phase 18 Plan 02: Wire Check Runs and PR Description Generation Summary

**Check run lifecycle (create/update/complete) and PR description auto-generation wired into worker with branch-based PR lookup and human-description preservation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-12T01:43:06Z
- **Completed:** 2026-03-12T01:48:07Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Check runs created at worker start when headSha available, updated after validation, completed with success/failure at end
- PR descriptions auto-generated after output collection with branch-based PR lookup
- Human-written PR descriptions preserved via forgectl-generated marker detection
- Issue-only runs and CLI runs skip check runs and PR descriptions gracefully
- All GitHub API calls are best-effort with error logging

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire check run lifecycle into worker** - `ee051ba` (feat)
2. **Task 2: Wire PR description generation after successful execution** - `827e03d` (feat)

## Files Created/Modified
- `src/orchestrator/worker.ts` - Extended GitHubDeps with headSha/repoContext, added check run lifecycle and PR description calls
- `src/github/pr-description.ts` - Added updatePRDescriptionForBranch, forgectl-generated marker, OctokitPulls list support
- `test/unit/wiring-checks.test.ts` - 12 tests for check run lifecycle wiring
- `test/unit/wiring-pr-description.test.ts` - 10 tests for PR description generation wiring

## Decisions Made
- GitHubDeps extended with headSha and repoContext for check run and PR description API calls
- updatePRDescriptionForBranch does branch-based PR lookup with human-description preservation via forgectl-generated marker
- Check run and PR description errors caught and logged as warnings (never crash worker)
- PRDescriptionData mapped from RunResult with fallback defaults for missing cost/agent fields

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added branch-based PR lookup to pr-description.ts**
- **Found during:** Task 2
- **Issue:** Plan assumed updatePRDescription takes branch parameter, but actual implementation took prNumber. Needed branch-based lookup for worker integration.
- **Fix:** Added updatePRDescriptionForBranch function with pulls.list API call and marker-based human description preservation
- **Files modified:** src/github/pr-description.ts
- **Verification:** 10 tests pass including branch lookup, no-PR skip, human-description preservation
- **Committed in:** 827e03d (Task 2 commit)

**2. [Rule 2 - Missing Critical] Added forgectl-generated marker to PR descriptions**
- **Found during:** Task 2
- **Issue:** Plan specified human-written descriptions should not be overwritten, but no marker existed to distinguish forgectl vs human descriptions
- **Fix:** Added `<!-- forgectl-generated -->` HTML comment marker to buildPRDescription output, check in updatePRDescriptionForBranch
- **Files modified:** src/github/pr-description.ts
- **Verification:** Tests verify marker presence and human-description preservation
- **Committed in:** 827e03d (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical)
**Impact on plan:** Both essential for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Check runs and PR descriptions fully wired into worker execution flow
- All GitHub App utility modules now integrated (comments, checks, PR descriptions)
- Ready for any remaining phase 18 plans or next milestone work

---
*Phase: 18-wire-github-app-utilities*
*Completed: 2026-03-12*
