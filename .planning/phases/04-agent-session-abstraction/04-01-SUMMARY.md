---
phase: 04-agent-session-abstraction
plan: 01
subsystem: agent
tags: [session, interface, oneshot, factory, lifecycle]

requires:
  - phase: none
    provides: existing invokeAgent and AgentAdapter interfaces
provides:
  - AgentSession interface (invoke/isAlive/close contract)
  - AgentResult structured type with status, tokenUsage, durationMs
  - OneShotSession wrapping invokeAgent()
  - createAgentSession factory function
affects: [04-02, 04-03, orchestration]

tech-stack:
  added: []
  patterns: [session-abstraction, factory-by-agent-type, activity-callback]

key-files:
  created:
    - src/agent/session.ts
    - src/agent/oneshot-session.ts
    - test/unit/session.test.ts
  modified: []

key-decisions:
  - "InvokeOptions type for per-call overrides (timeout) separate from AgentSessionOptions"
  - "Activity callback fires once per invoke, not per line of output"
  - "TokenUsage defaults to zeros for one-shot (no usage tracking in CLI mode)"

patterns-established:
  - "Session lifecycle: alive flag guards invoke, close sets false"
  - "mapExitCodeToStatus helper for status enum mapping"
  - "Factory delegates to getAgentAdapter for validation, wraps in session"

requirements-completed: [R5.1, R5.2, R5.4]

duration: 2min
completed: 2026-03-08
---

# Phase 04 Plan 01: Session Interface Summary

**AgentSession interface with OneShotSession wrapping invokeAgent() for unified one-shot/persistent agent abstraction**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-08T07:48:51Z
- **Completed:** 2026-03-08T07:50:28Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- AgentSession interface defining invoke/isAlive/close contract for all agent modes
- OneShotSession class wrapping existing invokeAgent() with lifecycle semantics and structured AgentResult
- createAgentSession factory returning OneShotSession for claude-code and codex agent types
- 18 comprehensive unit tests covering factory, invoke delegation, activity callback, and lifecycle

## Task Commits

Each task was committed atomically:

1. **Task 1: AgentSession interface, AgentResult types, and OneShotSession** - TDD
   - RED: `0eb2c45` (test: failing tests for session interface)
   - GREEN: `9e73d1a` (feat: implement AgentSession and OneShotSession)

## Files Created/Modified
- `src/agent/session.ts` - AgentSession interface, AgentResult/AgentStatus/TokenUsage types, createAgentSession factory
- `src/agent/oneshot-session.ts` - OneShotSession class implementing AgentSession via invokeAgent delegation
- `test/unit/session.test.ts` - 18 unit tests with mocked invokeAgent and getAgentAdapter

## Decisions Made
- InvokeOptions type separated from AgentSessionOptions for per-call timeout overrides
- Activity callback fires once per invoke (when stdout or stderr non-empty), not streaming
- TokenUsage defaults to zeros since CLI one-shot mode has no token tracking

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Session abstraction ready for AppServerSession (plan 02) and orchestration migration (plan 03)
- OneShotSession provides backward-compatible wrapper for existing invokeAgent usage

## Self-Check: PASSED

- All 3 source/test files exist
- Commits `0eb2c45` (RED) and `9e73d1a` (GREEN) verified
- 18 tests pass, 397 total tests pass, no type errors

---
*Phase: 04-agent-session-abstraction*
*Completed: 2026-03-08*
