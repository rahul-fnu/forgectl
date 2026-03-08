---
phase: 04-agent-session-abstraction
plan: 02
subsystem: agent
tags: [json-rpc, codex, app-server, session, stdio, docker-exec]

requires:
  - phase: 01-tracker-adapter-github-notion
    provides: "Docker container exec infrastructure"
provides:
  - "AppServerSession class with JSON-RPC over stdio for Codex app-server"
  - "JsonLineReader helper for JSONL line buffering"
  - "Multi-turn agent session with threadId reuse"
  - "Token usage tracking across turns"
affects: [04-agent-session-abstraction, orchestration]

tech-stack:
  added: []
  patterns: [json-rpc-over-stdio, docker-exec-hijack-bidirectional, demux-passthrough-streams]

key-files:
  created:
    - src/agent/appserver-session.ts
    - test/unit/appserver-session.test.ts
  modified: []

key-decisions:
  - "Docker modem demuxStream with PassThrough targets for bidirectional exec streams"
  - "Notifications for turn/start (no response expected), requests for initialize and thread/start"
  - "Token usage set from latest notification (not accumulated incrementally)"
  - "Timeout resolves with status timeout rather than rejecting"

patterns-established:
  - "JsonLineReader: buffer-then-split pattern for partial JSONL chunks"
  - "Session state machine: idle -> invoking -> closed with guards"
  - "Mock Docker exec with simulateStdout helper for testing JSON-RPC protocols"

requirements-completed: [R5.3, R5.4]

duration: 4min
completed: 2026-03-08
---

# Phase 04 Plan 02: AppServerSession Summary

**Persistent Codex app-server session with JSON-RPC handshake, multi-turn thread reuse, auto-approval, and token tracking over Docker exec stdio**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-08T07:48:49Z
- **Completed:** 2026-03-08T07:52:32Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- AppServerSession implements full JSON-RPC protocol for Codex app-server with handshake, turns, approvals
- Multi-turn sessions reuse threadId without re-handshake, tracking turnCount across invocations
- Comprehensive test suite with 15 tests using mock Docker exec streams for all protocol interactions

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing tests** - `d9e44a7` (test)
2. **Task 1 (GREEN): AppServerSession implementation** - `f772241` (feat)

_TDD: RED-GREEN pattern (no REFACTOR needed -- code was clean from the start)_

## Files Created/Modified
- `src/agent/appserver-session.ts` - AppServerSession class with JsonLineReader, JSON-RPC protocol handling, session lifecycle
- `test/unit/appserver-session.test.ts` - 15 unit tests covering handshake, turns, multi-turn, approvals, tokens, activity, timeout, lifecycle, JSONL buffering

## Decisions Made
- Used Docker modem demuxStream with PassThrough targets to separate stdout/stderr from hijacked bidirectional exec stream
- turn/start sent as notification (not request) since server doesn't respond to it directly -- turn/completed is the response
- Token usage replaces values from latest notification rather than accumulating deltas
- Timeout resolves the turn with status "timeout" rather than rejecting the promise, keeping consistent AgentResult shape
- Types defined inline (AgentStatus, TokenUsage, AgentResult, AgentSessionOptions) since plan 01 (session interface) runs in same wave

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript type errors**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** `Docker.Modem` type not exported by dockerode; unused `initResult` variable violated noUnusedLocals
- **Fix:** Used inline type assertion for modem access; removed unused variable binding
- **Files modified:** src/agent/appserver-session.ts
- **Verification:** `npx tsc --noEmit` passes clean
- **Committed in:** f772241

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor type fix, no scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- AppServerSession ready for integration with AgentSession factory (plan 01 provides interface, plan 03 may wire them)
- OneShotSession (plan 01) and AppServerSession (this plan) cover both agent execution modes

---
*Phase: 04-agent-session-abstraction*
*Completed: 2026-03-08*
