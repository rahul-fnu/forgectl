---
phase: 06-observability-api-extensions
plan: 02
subsystem: api
tags: [fastify, rest-api, sse, observability, orchestrator]

# Dependency graph
requires:
  - phase: 06-observability-api-extensions/01
    provides: "MetricsCollector, enriched LogEntry/RunEvent, Orchestrator getMetrics/triggerTick"
provides:
  - "GET /api/v1/state endpoint for orchestrator snapshot"
  - "GET /api/v1/issues/:identifier endpoint for per-issue details"
  - "POST /api/v1/refresh endpoint for manual tick trigger"
  - "GET /api/v1/events SSE stream for orchestrator events"
  - "Structured error envelope { error: { code, message } }"
affects: [06-03-dashboard, external-tooling, cli-status]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Structured error envelope for API errors", "SSE stream per subsystem channel"]

key-files:
  created:
    - test/unit/observability-routes.test.ts
  modified:
    - src/daemon/routes.ts
    - src/daemon/server.ts
    - src/orchestrator/index.ts

key-decisions:
  - "getSlotUtilization() on Orchestrator class delegates to internal slotManager (avoids exposing private field)"
  - "Retry queue derived from retryAttempts entries not in running map (no separate data structure)"
  - "SSE events route listens on run:orchestrator channel (matches dispatcher emit pattern)"
  - "registerRoutes moved after orchestrator init in server.ts to avoid block-scoped variable reference"

patterns-established:
  - "Observability routes use /api/v1/ prefix to namespace from existing routes"
  - "All orchestrator error responses use { error: { code, message } } shape"
  - "503 NOT_CONFIGURED for missing/stopped orchestrator (consistent across all orch routes)"

requirements-completed: [R6.3]

# Metrics
duration: 6min
completed: 2026-03-08
---

# Phase 6 Plan 2: Observability API Routes Summary

**Four REST endpoints exposing orchestrator state, per-issue details, manual refresh trigger, and SSE event stream with structured error envelopes**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-08T18:12:35Z
- **Completed:** 2026-03-08T18:18:05Z
- **Tasks:** 1 (TDD: test + feat)
- **Files modified:** 4

## Accomplishments
- Four new Fastify routes under /api/v1/ for orchestrator observability
- Structured error responses with { error: { code, message } } envelope
- SSE stream for real-time orchestrator events via run:orchestrator channel
- 12 new unit tests using Fastify inject(), full suite (573 tests) green

## Task Commits

Each task was committed atomically:

1. **Task 1: REST API routes and server wiring (RED)** - `f26fd63` (test)
2. **Task 1: REST API routes and server wiring (GREEN)** - `9f60783` (feat)

## Files Created/Modified
- `src/daemon/routes.ts` - Added four /api/v1/ routes for orchestrator observability
- `src/daemon/server.ts` - Passes orchestrator instance to registerRoutes, reordered init
- `src/orchestrator/index.ts` - Added getSlotUtilization() method
- `test/unit/observability-routes.test.ts` - 12 tests for all four routes and error shapes

## Decisions Made
- Added `getSlotUtilization()` to Orchestrator class rather than exposing `slotManager` directly -- keeps internal state private
- Retry queue computed from `retryAttempts` entries not in `running` map -- avoids maintaining separate retry queue data structure
- Moved `registerRoutes()` call after orchestrator initialization in `server.ts` -- fixes block-scoped variable reference error
- SSE events route uses `run:orchestrator` channel matching existing dispatcher emit pattern

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TrackerIssue.status to TrackerIssue.state**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** Plan referenced `worker.issue.status` but TrackerIssue uses `state` field
- **Fix:** Changed to `worker.issue.state`
- **Files modified:** src/daemon/routes.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** 9f60783 (Task 1 feat commit)

**2. [Rule 3 - Blocking] Reordered server.ts initialization**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** `registerRoutes` referenced block-scoped `orchestrator` variable before its declaration
- **Fix:** Moved `registerRoutes` call after orchestrator initialization block
- **Files modified:** src/daemon/server.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** 9f60783 (Task 1 feat commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for compilation. No scope creep.

## Issues Encountered
- SSE route test initially timed out with Fastify `inject()` (SSE never completes). Fixed by using `app.printRoutes()` to verify route registration instead.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All four API routes ready for dashboard consumption (Plan 03)
- Structured error envelope established for consistent API error handling

---
*Phase: 06-observability-api-extensions*
*Completed: 2026-03-08*
