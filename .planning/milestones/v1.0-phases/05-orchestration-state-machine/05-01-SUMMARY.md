---
phase: 05-orchestration-state-machine
plan: 01
subsystem: orchestration
tags: [state-machine, retry, backoff, concurrency, zod]

requires:
  - phase: 04-agent-session-abstraction
    provides: AgentSession interface for WorkerInfo type
  - phase: 01-tracker-adapter-github-notion
    provides: TrackerIssue model for WorkerInfo type
provides:
  - OrchestratorState, WorkerInfo, IssueState types
  - State transition functions (createState, claimIssue, releaseIssue)
  - SlotManager for concurrency control
  - Retry/backoff functions (calculateBackoff, classifyFailure, scheduleRetry, cancelRetry, clearAllRetries)
  - OrchestratorConfigSchema with 9 configuration fields
affects: [05-02, 05-03, 05-04]

tech-stack:
  added: []
  patterns: [mutable-state-with-pure-transitions, exponential-backoff-with-cap, failure-classification]

key-files:
  created:
    - src/orchestrator/state.ts
    - src/orchestrator/retry.ts
    - test/unit/orchestrator-state.test.ts
    - test/unit/orchestrator-retry.test.ts
  modified:
    - src/config/schema.ts

key-decisions:
  - "Mutable state object with pure transition functions (not class-based) for testability"
  - "SlotManager takes running Map as parameter rather than holding state reference"
  - "classifyFailure maps completed to continuation, all others to error"

patterns-established:
  - "Orchestrator state transitions: pure functions operating on mutable OrchestratorState"
  - "Backoff formula: 10s * 2^(attempt-1) capped at configurable max"

requirements-completed: [R2.1, R2.3, R2.4]

duration: 3min
completed: 2026-03-08
---

# Phase 5 Plan 1: State Types and Retry Logic Summary

**Orchestrator state types with claim/release transitions, slot manager for concurrency, and exponential backoff retry with failure classification**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T08:34:29Z
- **Completed:** 2026-03-08T08:37:19Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- OrchestratorState, WorkerInfo, IssueState types with createState/claimIssue/releaseIssue transitions
- SlotManager class for tracking concurrent worker capacity
- Retry functions with exponential backoff (10s base, 2x growth, configurable cap)
- OrchestratorConfigSchema with 9 fields integrated into ConfigSchema
- 32 unit tests covering all state transitions, backoff values, timer operations, and config parsing

## Task Commits

Each task was committed atomically:

1. **Task 1: State types, transitions, and slot manager** - `29cb918` (feat)
2. **Task 2: Retry/backoff logic and config schema** - `2815ddc` (feat)

_Note: TDD tasks — RED/GREEN phases per task_

## Files Created/Modified
- `src/orchestrator/state.ts` - OrchestratorState, WorkerInfo, IssueState types; createState, claimIssue, releaseIssue functions; SlotManager class
- `src/orchestrator/retry.ts` - calculateBackoff, classifyFailure, scheduleRetry, cancelRetry, clearAllRetries
- `src/config/schema.ts` - Added OrchestratorConfigSchema with 9 fields to ConfigSchema
- `test/unit/orchestrator-state.test.ts` - 14 tests for state transitions and slot management
- `test/unit/orchestrator-retry.test.ts` - 18 tests for backoff, classification, timers, config

## Decisions Made
- Used pure functions with mutable state object (not class-based OrchestratorState) for simpler testing
- SlotManager receives running Map as parameter rather than holding a state reference, keeping it decoupled
- classifyFailure maps "completed" to "continuation" (short delay re-dispatch), everything else to "error" (exponential backoff)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing `test/unit/orchestrator-worker.test.ts` fails because it imports `src/orchestrator/worker.ts` which does not yet exist (part of plan 05-02). This is expected and out of scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- State types, transitions, and retry logic ready for plans 05-02 (worker lifecycle), 05-03 (dispatcher/scheduler), and 05-04 (orchestrator class)
- OrchestratorConfigSchema available for all orchestrator modules to consume
- No blockers

---
*Phase: 05-orchestration-state-machine*
*Completed: 2026-03-08*
