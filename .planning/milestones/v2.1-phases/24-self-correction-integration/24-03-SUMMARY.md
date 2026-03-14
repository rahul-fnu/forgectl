---
phase: 24-self-correction-integration
plan: 03
subsystem: testing
tags: [pipeline, exclusion-enforcement, git, picomatch, tdd, vitest]

# Dependency graph
requires:
  - phase: 24-02
    provides: "Exclusion enforcement wired into executeLoopNode (inline implementation)"
provides:
  - "checkExclusionViolations standalone function in src/pipeline/exclusion.ts"
  - "Executor refactored to call checkExclusionViolations instead of inline logic"
  - "Real git repo tests for exclusion enforcement with strict assertions"
  - "CORR-02 gap closed: no conditional assertions, no vi.doMock, no placeholders"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Extract inline git/filesystem logic into standalone modules for testability"
    - "Real temporary git repos in tests instead of mocking execSync"

key-files:
  created:
    - src/pipeline/exclusion.ts
  modified:
    - src/pipeline/executor.ts
    - test/unit/pipeline-self-correction.test.ts

key-decisions:
  - "Exclusion violation causes immediate return from loop body — prevents no-progress detection race condition"
  - "picomatch import removed from executor.ts; lives only in exclusion.ts where it is used"
  - "TDD approach: RED (import fails) → GREEN (implement) → all tests pass"

patterns-established:
  - "Real git repos in tests: mkdtempSync + git init + commit + modify + assert — no execSync mocking needed"
  - "Early return on exclusion violation: state.status = failed + return prevents subsequent loop guards from overwriting error"

requirements-completed: [CORR-02]

# Metrics
duration: 4min
completed: 2026-03-14
---

# Phase 24 Plan 03: Self-Correction Gap Closure (CORR-02) Summary

**Extracted `checkExclusionViolations` into `src/pipeline/exclusion.ts` and replaced broken mock-based tests with real temp git repo tests eliminating the CORR-02 coverage gap**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T01:59:11Z
- **Completed:** 2026-03-14T02:03:20Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments
- Created `src/pipeline/exclusion.ts` exporting `checkExclusionViolations(repoPath, excludePatterns)` — detects and reverts excluded file modifications via real git commands
- Refactored `executeLoopNode` to call the helper and return early on violations (fixing a race condition with no-progress detection)
- Removed `picomatch` import from executor.ts (moved to exclusion.ts where it belongs)
- Replaced `vi.doMock("node:child_process", ...)` approach with 5 unit tests using real temporary git repos with strict assertions
- Added integration test for PipelineExecutor with `repo` field on pipeline node — verifies end-to-end exclusion failure path

## Task Commits

1. **Task 1: Extract checkExclusionViolations helper and rewire executor** - `9ad44dc` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified
- `src/pipeline/exclusion.ts` - Standalone exclusion enforcement: git diff, picomatch filtering, git checkout revert
- `src/pipeline/executor.ts` - Removed inline exclusion block, added `checkExclusionViolations` import, added early return on violation
- `test/unit/pipeline-self-correction.test.ts` - Rewrote exclusion enforcement section with real git repo tests; removed vi.doMock and placeholder assertions

## Decisions Made
- **Early return on violation:** When exclusion fires, we set `state.status = "failed"` and return immediately from the loop body. Without this, the loop continues to iteration 2 where no-progress detection sees identical "tests pass" output and overwrites the error with a different message.
- **Inline logic vs early return:** The original inline code set `violationState.status = "failed"` but did not return — the loop continued. Moving the mark-and-return into a single block ensures the exclusion error is the terminal one.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added early return on exclusion violation to prevent no-progress detection race**
- **Found during:** Task 1 (GREEN phase — integration test failing)
- **Issue:** Original plan's code set `violationState.status = "failed"` but didn't return. Loop continued to iteration 2 with identical "tests pass" output, triggering no-progress detection which overwrote the exclusion error.
- **Fix:** Changed `violationState.status` update to `state.status` update and added `return` — exits loop body immediately on violation.
- **Files modified:** src/pipeline/executor.ts
- **Verification:** Integration test "fails iteration when fix agent modifies excluded file" passes with exact exclusion error message
- **Committed in:** 9ad44dc (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - logic bug in early-exit behavior)
**Impact on plan:** Required for correctness — exclusion violation must terminate the loop with the exclusion error, not be overridden by no-progress detection on a subsequent iteration.

## Issues Encountered
None — aside from the auto-fixed early-return issue which was caught immediately by the integration test.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CORR-02 gap fully closed: `checkExclusionViolations` is tested with real git repos, strict assertions, no mocking
- Phase 24 is now complete: all 3 plans (foundation, wiring, gap closure) shipped
- Full test suite: 1211 tests pass, 0 regressions, clean typecheck

## Self-Check: PASSED
- src/pipeline/exclusion.ts: FOUND
- test/unit/pipeline-self-correction.test.ts: FOUND
- 24-03-SUMMARY.md: FOUND
- Commit 9ad44dc: FOUND

---
*Phase: 24-self-correction-integration*
*Completed: 2026-03-14*
