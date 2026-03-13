---
phase: 28-sub-issue-advanced-features
plan: "02"
subsystem: orchestrator
tags: [dispatcher, sub-issues, rollup, synthesizer, github, progress-comment, label]

requires:
  - phase: 28-01
    provides: sub-issue-rollup.ts pure functions (upsertRollupComment, buildSubIssueProgressComment, allChildrenTerminal)
  - phase: 25-sub-issue-dag-dependencies
    provides: SubIssueCache with getAllEntries() scan for child→parent lookup
provides:
  - triggerParentRollup exported function: post-completion rollup callback wired into dispatcher
  - Synthesizer-gated close: forge:synthesize label triggers parent close on success, error comment on failure
  - subIssueCache optional parameter on dispatchIssue and executeWorkerAndHandle (backward compat)
affects:
  - src/orchestrator/dispatcher.ts (modified)
  - test/unit/wiring-sub-issue-rollup.test.ts (created)

tech-stack:
  added: []
  patterns:
    - "Rollup callback: fire-and-forget with .catch warn-swallow after executeWorker returns"
    - "Cache scan pattern: getAllEntries().find(entry => entry.childIds.includes(childId))"
    - "In-place childStates update: entry.childStates.set(childId, 'closed') before terminal check"
    - "Synthesizer gate: issue.labels.includes('forge:synthesize') triggers alternate close path"

key-files:
  created:
    - test/unit/wiring-sub-issue-rollup.test.ts
  modified:
    - src/orchestrator/dispatcher.ts

key-decisions:
  - "triggerParentRollup removes childSuccess parameter — implementation always sets 'closed' state, parameter was unused (noUnusedParameters enforced)"
  - "Rollup inserted between executeWorker return and tracker.postComment — ensures parent is notified before child's own completion comment"
  - "Synthesizer-gated close replaces normal auto_close/done_label path for issues with forge:synthesize label"
  - "allChildrenTerminal uses terminalStates from config.tracker.terminal_states with 'closed' fallback"

metrics:
  duration: 5min
  completed: 2026-03-13
  tasks: 2
  files: 2
---

# Phase 28 Plan 02: Dispatcher Rollup Wiring Summary

**Rollup callback wired into dispatcher's executeWorkerAndHandle — triggerParentRollup scans SubIssueCache after child completion, upserts progress comment on parent, adds forge:synthesize label when all children terminal, and gates parent close on synthesizer success/failure**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-13T23:32:58Z
- **Completed:** 2026-03-13T23:37:21Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `triggerParentRollup` exported async helper to `src/orchestrator/dispatcher.ts`: scans SubIssueCache via `getAllEntries()`, updates child state to "closed" in-place, builds `ChildStatus[]` with proper GitHub URLs and fallback titles, calls `upsertRollupComment` and `buildSubIssueProgressComment`
- Added optional `subIssueCache?: SubIssueCache` parameter to `dispatchIssue` and `executeWorkerAndHandle` — fully backward compatible, all existing callers unaffected
- Rollup fires after `executeWorker` returns and before `tracker.postComment`, wrapped in try/catch warn-swallow
- `forge:synthesize` label added via fire-and-forget when `allChildrenTerminal` returns true
- Synthesizer-gated close: success path closes parent + removes label; failure path posts error comment + leaves parent open
- 10 unit tests covering: comment post, state update, error swallowing, label trigger, skip conditions, terminal config, URL construction
- TypeScript compiles clean; full 1152-test suite passes with zero regressions

## Task Commits

1. **Task 1 (RED+GREEN): Wire rollup callback into dispatcher** - `8bb7ea1` (feat)
2. **Task 2 (typecheck fix): Remove unused param, fix AgentStatus comparison** - `d1c45db` (fix)

## Files Created/Modified

- `src/orchestrator/dispatcher.ts` — added `triggerParentRollup`, `subIssueCache` optional params, synthesizer-gated close logic
- `test/unit/wiring-sub-issue-rollup.test.ts` — 10 unit tests for rollup wiring behaviors

## Decisions Made

- Removed `childSuccess` parameter from `triggerParentRollup` signature — `noUnusedParameters: true` is enforced and the implementation always updates child state to "closed" regardless of success flag
- `AgentStatus` type has no `"error"` value (`"completed" | "failed" | "timeout" | "user_input_required"`) — removed the incorrect `status !== "error"` comparison; used `classifyFailure()` result instead
- Rollup placed before `tracker.postComment` to ensure parent progress is visible immediately when the child's completion comment appears
- `allChildrenTerminal` called with `config.tracker?.terminal_states ?? ["closed"]` as Set — defaults to `["closed"]` matching existing orchestrator conventions

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused `childSuccess` parameter**
- **Found during:** Task 2 typecheck
- **Issue:** `noUnusedParameters: true` in tsconfig caused compile error TS6133 on `childSuccess: boolean` parameter in `triggerParentRollup`
- **Fix:** Removed parameter from function signature and all test call sites — implementation always sets child state to "closed" (the completed state) regardless of success flag
- **Files modified:** `src/orchestrator/dispatcher.ts`, `test/unit/wiring-sub-issue-rollup.test.ts`
- **Commit:** d1c45db

**2. [Rule 1 - Bug] Fixed incorrect AgentStatus comparison**
- **Found during:** Task 2 typecheck
- **Issue:** `result.agentResult.status !== "error"` caused TS2367 because `AgentStatus` type is `"completed" | "failed" | "timeout" | "user_input_required"` — no `"error"` value
- **Fix:** Removed the `childSuccess` variable that depended on this comparison (unused after fix 1)
- **Files modified:** `src/orchestrator/dispatcher.ts`
- **Commit:** d1c45db

## Self-Check: PASSED

- `src/orchestrator/dispatcher.ts` — FOUND
- `test/unit/wiring-sub-issue-rollup.test.ts` — FOUND
- `.planning/phases/28-sub-issue-advanced-features/28-02-SUMMARY.md` — FOUND
- commit `8bb7ea1` — verified
- commit `d1c45db` — verified

---
*Phase: 28-sub-issue-advanced-features*
*Completed: 2026-03-13*
