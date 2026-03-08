---
phase: 07-end-to-end-integration-demo
plan: 01
subsystem: orchestration
tags: [validation, output-collection, auto-close, worker, dispatcher]

requires:
  - phase: 05-orchestration-state-machine
    provides: worker lifecycle, dispatcher, comment builder
  - phase: 03-workflow-contract
    provides: WORKFLOW.md front matter parser
provides:
  - Validation loop integration in orchestrated worker
  - Git output collection before container cleanup
  - Enriched write-back comments with validation results and branch
  - Auto-close and done-label tracker write-back
  - Validation section in WORKFLOW.md front matter
affects: [07-end-to-end-integration-demo]

tech-stack:
  added: []
  patterns:
    - "Validation/output collection before session close (container must be alive)"
    - "Non-critical output collection wrapped in try/catch"
    - "Auto-close and done-label as fire-and-forget tracker calls on successful completion"

key-files:
  created: []
  modified:
    - src/workflow/workflow-file.ts
    - src/workflow/types.ts
    - src/orchestrator/worker.ts
    - src/orchestrator/dispatcher.ts
    - test/unit/workflow-file.test.ts
    - test/unit/orchestrator-worker.test.ts
    - test/unit/orchestrator-dispatcher.test.ts

key-decisions:
  - "Validation and output collection happen before session.close() to keep container alive"
  - "collectGitOutput is non-critical: errors are caught and logged, worker continues"
  - "Auto-close and done-label are fire-and-forget .catch() calls, matching existing label update pattern"
  - "validationConfig parameter threaded through executeWorker to buildOrchestratedRunPlan"

patterns-established:
  - "Worker pipeline: invoke agent -> validate -> collect output -> close session -> cleanup"
  - "Enriched comments include validation checklist and branch name"

requirements-completed: [R7.1, R7.2, R7.3, R7.4]

duration: 5min
completed: 2026-03-08
---

# Phase 7 Plan 01: Validation Loop, Output Collection, and Enriched Write-back Summary

**Orchestrated worker now runs validation loop after agent invoke, collects git branch, posts enriched comments with validation results, and auto-closes issues when configured**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-08T19:47:19Z
- **Completed:** 2026-03-08T19:52:39Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- WORKFLOW.md front matter accepts validation section with steps and on_failure
- Worker integrates runValidationLoop and collectGitOutput before session close
- Dispatcher auto-closes issues and adds done-label when configured and agent completed
- Full test suite passes: 587 tests (14 new)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add validation section to WORKFLOW.md front matter** - `535f43b` (test), `de63b53` (feat)
2. **Task 2: Integrate validation loop, output collection, auto-close** - `0283bfc` (test), `bffeb86` (feat)

_Note: TDD tasks have RED (test) and GREEN (feat) commits_

## Files Created/Modified
- `src/workflow/workflow-file.ts` - Added validation section to WorkflowFrontMatterSchema
- `src/workflow/types.ts` - Added validation field to WorkflowFileConfig
- `src/orchestrator/worker.ts` - Integrated runValidationLoop, collectGitOutput, enriched comment, validationConfig parameter
- `src/orchestrator/dispatcher.ts` - Added auto-close and done-label logic on successful completion
- `test/unit/workflow-file.test.ts` - 4 new tests for validation front matter
- `test/unit/orchestrator-worker.test.ts` - 7 new tests for validation loop, output collection, container lifecycle
- `test/unit/orchestrator-dispatcher.test.ts` - 3 new tests for auto-close, done-label, no-close-on-failure

## Decisions Made
- Validation and output collection happen before session.close() to keep container alive for exec calls
- collectGitOutput is non-critical: errors are caught and logged, worker continues normally
- Auto-close and done-label are fire-and-forget .catch() calls, matching existing label update pattern
- validationConfig parameter is optional and threaded through executeWorker to buildOrchestratedRunPlan

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Worker now has full integration with validation and output subsystems
- Ready for end-to-end testing with real containers and tracker

---
*Phase: 07-end-to-end-integration-demo*
*Completed: 2026-03-08*
