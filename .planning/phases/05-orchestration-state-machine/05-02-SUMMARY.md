---
phase: 05-orchestration-state-machine
plan: 02
subsystem: orchestration
tags: [worker, comment-builder, workspace, agent-session, tracker-writeback]

requires:
  - phase: 04-agent-session
    provides: AgentSession interface and createAgentSession factory
  - phase: 02-workspace-management
    provides: WorkspaceManager with lifecycle hooks
  - phase: 03-workflow-contract
    provides: renderPromptTemplate and buildTemplateVars
provides:
  - buildOrchestratedRunPlan function mapping issue + config to RunPlan with workspace paths
  - executeWorker function for full worker lifecycle (workspace -> hooks -> agent -> cleanup)
  - buildResultComment producing structured markdown for tracker write-back
affects: [05-03-dispatcher, 05-04-orchestration-loop]

tech-stack:
  added: []
  patterns: [orchestrated-run-plan, worker-lifecycle, structured-comment]

key-files:
  created:
    - src/orchestrator/comment.ts
    - src/orchestrator/worker.ts
    - test/unit/orchestrator-worker.test.ts
  modified: []

key-decisions:
  - "Empty tempDirs in CleanupContext to preserve workspace while destroying container"
  - "CommitConfig field mapping (include_task -> includeTask) inline in buildOrchestratedRunPlan"
  - "Before hook failure returns immediate failure result without agent invocation"

patterns-established:
  - "Worker lifecycle: ensureWorkspace -> beforeHook -> prepareExecution -> agentSession -> afterHook -> cleanupRun"
  - "Structured comment format with status, duration, token usage, optional validation results"

requirements-completed: [R2.2]

duration: 4min
completed: 2026-03-08
---

# Phase 05 Plan 02: Worker Lifecycle and Comment Builder Summary

**Worker lifecycle adapting prepareExecution for orchestrated runs with WorkspaceManager paths and structured markdown comment builder for tracker write-back**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-08T08:34:52Z
- **Completed:** 2026-03-08T08:38:27Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- buildResultComment produces structured markdown with status, duration, agent type, token usage table, and optional validation checklist
- buildOrchestratedRunPlan maps TrackerIssue + ForgectlConfig to RunPlan using workspace paths instead of temp dirs
- executeWorker implements full lifecycle: workspace setup, hooks, agent session with stall detection callback, cleanup
- 27 tests passing with mocked Docker/agent dependencies

## Task Commits

Each task was committed atomically:

1. **Task 1: Structured comment builder with tests** - `e1fac9a` (feat)
2. **Task 2: Worker lifecycle** - `123866b` (feat)

_Note: TDD tasks have RED+GREEN phases in single commits_

## Files Created/Modified
- `src/orchestrator/comment.ts` - Structured markdown comment builder with duration formatting and token usage table
- `src/orchestrator/worker.ts` - buildOrchestratedRunPlan and executeWorker for orchestrated agent dispatch
- `test/unit/orchestrator-worker.test.ts` - 27 tests covering comment builder and worker lifecycle

## Decisions Made
- Empty tempDirs in CleanupContext ensures workspace directory persists after container destruction
- CommitConfig field mapping done inline (include_task -> includeTask) matching the pattern from workflow resolver
- Before hook failures return immediate failure result to avoid wasting agent invocation on a broken workspace

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed CommitConfig field name mismatch**
- **Found during:** Task 2 (typecheck)
- **Issue:** ForgectlConfig uses snake_case `include_task` but CommitConfig interface uses camelCase `includeTask`
- **Fix:** Added explicit field mapping in buildOrchestratedRunPlan matching the pattern from src/workflow/resolver.ts
- **Files modified:** src/orchestrator/worker.ts
- **Verification:** npm run typecheck passes cleanly
- **Committed in:** 123866b (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Auto-fix necessary for type correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Worker lifecycle ready for dispatcher (Plan 03) to call executeWorker for each dispatched issue
- Comment builder ready for tracker write-back after worker completion

---
*Phase: 05-orchestration-state-machine*
*Completed: 2026-03-08*
