---
phase: 13-governance-approvals
plan: 01
subsystem: governance
tags: [autonomy, approval, state-machine, picomatch, zod, sqlite]

requires:
  - phase: 10-persistent-storage
    provides: SQLite storage layer, Drizzle ORM, RunRepository
  - phase: 12-durable-execution
    provides: Pause/resume pattern in durability module
provides:
  - Governance types (AutonomyLevel, ApprovalAction, ApprovalContext, AutoApproveRule)
  - Gate-checking helpers (needsPreApproval, needsPostApproval)
  - Approval state machine (approveRun, rejectRun, requestRevision)
  - Auto-approve rule evaluator (evaluateAutoApprove with AND logic)
  - Extended WorkflowSchema with autonomy and auto_approve fields
  - Extended RunEvent type with governance event types
affects: [13-02-PLAN, orchestrator, daemon-routes]

tech-stack:
  added: []
  patterns: [pure-function state machine following pause.ts pattern, AND-logic rule evaluation]

key-files:
  created:
    - src/governance/types.ts
    - src/governance/autonomy.ts
    - src/governance/approval.ts
    - src/governance/rules.ts
    - test/unit/governance-autonomy.test.ts
    - test/unit/governance-approval.test.ts
    - test/unit/governance-rules.test.ts
    - drizzle/0003_governance_approval_columns.sql
  modified:
    - src/config/schema.ts
    - src/workflow/types.ts
    - src/storage/schema.ts
    - src/storage/repositories/runs.ts
    - src/logging/events.ts

key-decisions:
  - "Approval state machine follows pause.ts pattern: pure functions taking RunRepository"
  - "Auto-approve uses AND logic: all specified conditions must pass"
  - "Cost threshold returns false when actualCost undefined (safe pre-gate default)"
  - "autonomy defaults to full for backward compatibility with existing workflows"

patterns-established:
  - "Governance pure functions: take RunRepository, validate state, emit events"
  - "Auto-approve AND logic: vacuous truth for empty rules, strict for specified conditions"

requirements-completed: [GOVN-01, GOVN-02, GOVN-03]

duration: 8min
completed: 2026-03-10
---

# Phase 13 Plan 01: Governance Module Summary

**Governance types, autonomy level gate-checking, approval state machine, and auto-approve rule evaluator with picomatch glob matching**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-10T03:31:44Z
- **Completed:** 2026-03-10T03:39:15Z
- **Tasks:** 2
- **Files modified:** 15

## Accomplishments
- Created src/governance/ module with shared types, autonomy helpers, approval transitions, and auto-approve evaluator
- Extended WorkflowSchema with autonomy enum (4 levels, defaults to "full") and auto_approve rule schema
- Approval state machine handles approve/reject/revision for both pre-execution and post-output pending states
- Auto-approve evaluator with AND logic for label, workflow_pattern (picomatch), and cost threshold conditions
- 54 new governance unit tests, all passing alongside 840 total tests

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1: Governance types, config schema, and autonomy helpers**
   - `e4343a0` (test: failing tests for autonomy levels)
   - `588f142` (feat: implement governance types, autonomy helpers, config schema)
2. **Task 2: Approval state machine and auto-approve evaluator**
   - `94ea6cb` (test: failing tests for approval and rules)
   - `0b60781` (feat: implement approval state machine, auto-approve rules, storage schema)

## Files Created/Modified
- `src/governance/types.ts` - AutonomyLevel, ApprovalAction, ApprovalContext, AutoApproveRule, AutoApproveContext
- `src/governance/autonomy.ts` - needsPreApproval, needsPostApproval gate-checking helpers
- `src/governance/approval.ts` - approveRun, rejectRun, requestRevision, enterPendingApproval, enterPendingOutputApproval
- `src/governance/rules.ts` - evaluateAutoApprove with picomatch and AND logic
- `src/config/schema.ts` - Added AutonomyLevelEnum, AutoApproveRuleSchema, autonomy/auto_approve to WorkflowSchema
- `src/workflow/types.ts` - Added autonomy and auto_approve to WorkflowFileConfig
- `src/storage/schema.ts` - Added approval_context, approval_action columns to runs table
- `src/storage/repositories/runs.ts` - Extended RunRow, RunUpdateParams, deserializeRow, updateStatus
- `src/logging/events.ts` - Added governance event types to RunEvent union
- `drizzle/0003_governance_approval_columns.sql` - Migration for new columns
- `test/unit/governance-autonomy.test.ts` - 25 tests for autonomy levels and config schema
- `test/unit/governance-approval.test.ts` - 15 tests for approval state machine
- `test/unit/governance-rules.test.ts` - 14 tests for auto-approve evaluator

## Decisions Made
- Approval state machine follows pause.ts pattern: pure functions taking RunRepository, validating state, emitting events
- Auto-approve uses AND logic: all specified conditions must pass (vacuous truth for empty rules)
- Cost threshold returns false when actualCost is undefined (safe pre-gate default)
- autonomy defaults to "full" for backward compatibility with existing workflows

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added autonomy: "full" to builtin workflows and worker.ts**
- **Found during:** Task 2 (typecheck after schema changes)
- **Issue:** Adding `autonomy` to WorkflowSchema made it required in the inferred type. All 6 builtin workflow definitions and the orchestrator worker.ts build a WorkflowDefinition directly without going through zod parse.
- **Fix:** Added `autonomy: "full"` to all 7 locations that construct WorkflowDefinition objects directly
- **Files modified:** src/workflow/builtins/{code,content,data,general,ops,research}.ts, src/orchestrator/worker.ts
- **Verification:** `npm run typecheck` passes clean
- **Committed in:** 0b60781 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for type safety. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Governance module is fully functional with types, helpers, state machine, and evaluator
- Ready for Plan 02 to wire governance gates into the orchestrator execution flow
- All 840 tests pass with no regressions

---
*Phase: 13-governance-approvals*
*Completed: 2026-03-10*
