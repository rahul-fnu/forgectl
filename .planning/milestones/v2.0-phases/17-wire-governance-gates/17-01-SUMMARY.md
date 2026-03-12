---
phase: 17-wire-governance-gates
plan: 01
subsystem: orchestration
tags: [governance, autonomy, approval, dispatcher, scheduler, wiring]

requires:
  - phase: 13-governance-approvals
    provides: GovernanceOpts, pre-gate, post-gate, autonomy, approval, rules modules
  - phase: 16-wire-flight-recorder
    provides: EventRecorder wired into daemon server
provides:
  - GovernanceOpts flowing from scheduler tick to dispatchIssue
  - Orchestrator building GovernanceOpts internally from config and runRepo
  - RunQueue passing runRepo in DurabilityDeps for post-gate
  - resolveRunPlan accepting workflow autonomy/auto_approve overrides
affects: [governance, orchestrator, daemon, workflow]

tech-stack:
  added: []
  patterns: [internal-governance-opts-construction, optional-workflow-overrides]

key-files:
  created:
    - test/unit/governance-wiring.test.ts
  modified:
    - src/orchestrator/index.ts
    - src/orchestrator/scheduler.ts
    - src/daemon/server.ts
    - src/workflow/resolver.ts

key-decisions:
  - "Orchestrator builds GovernanceOpts internally from its own fields (single source of truth for all dispatch paths)"
  - "GovernanceOpts is undefined (not empty object) when runRepo absent, preserving graceful fallback"
  - "WorkflowOverrides is a separate interface parameter on resolveRunPlan, not merged into CLIOptions"

patterns-established:
  - "Governance wiring pattern: runRepo presence gates governance activation"
  - "Optional WorkflowOverrides parameter preserves backward compat for existing resolveRunPlan callers"

requirements-completed: [GOVN-01, GOVN-02, GOVN-03]

duration: 4min
completed: 2026-03-11
---

# Phase 17 Plan 01: Wire Governance Gates Summary

**GovernanceOpts wired from daemon config through scheduler/orchestrator to dispatcher pre-gate and single.ts post-gate, with WORKFLOW.md autonomy overrides in resolver**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-11T05:29:05Z
- **Completed:** 2026-03-11T05:32:36Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- GovernanceOpts flows from scheduler tick and Orchestrator.dispatchIssue to dispatcher pre-gate
- runRepo passed in DurabilityDeps from server.ts RunQueue, enabling post-gate in single.ts
- resolveRunPlan accepts optional WorkflowOverrides for autonomy/auto_approve from WORKFLOW.md
- 7 wiring verification tests covering all integration points

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire governance opts through all integration points** - `87ffef1` (feat)
2. **Task 2: Wiring verification tests** - `9649255` (test)

## Files Created/Modified
- `src/orchestrator/index.ts` - Added runRepo/autonomy/autoApprove to OrchestratorOptions, builds GovernanceOpts in dispatchIssue
- `src/orchestrator/scheduler.ts` - Added runRepo/autonomy/autoApprove to TickDeps, builds GovernanceOpts in tick
- `src/daemon/server.ts` - Passes runRepo in DurabilityDeps and OrchestratorOptions
- `src/workflow/resolver.ts` - Added WorkflowOverrides parameter to resolveRunPlan
- `test/unit/governance-wiring.test.ts` - 7 tests verifying governance flows through scheduler, orchestrator, resolver

## Decisions Made
- Orchestrator builds GovernanceOpts internally from its own fields (single source of truth for all dispatch paths including webhook)
- GovernanceOpts is undefined when runRepo absent, preserving Phase 13 graceful fallback behavior
- WorkflowOverrides is a separate interface/parameter on resolveRunPlan, not merged into CLIOptions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All governance gates are now reachable through normal execution paths
- Pre-gate fires when autonomy != "full" and runRepo is available
- Post-gate fires when runRepo is in DurabilityDeps
- evaluateAutoApprove is reachable through both gate paths

---
*Phase: 17-wire-governance-gates*
*Completed: 2026-03-11*
