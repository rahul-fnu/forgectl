# Phase 6: Observability + API Extensions - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Structured logging, metrics, REST API, and dashboard updates for orchestrator visibility. This phase exposes the orchestrator's internal state (from Phase 5) through enriched logs, a metrics layer, new REST endpoints, and a new dashboard page. No new orchestrator behavior — purely observability and API surface.

</domain>

<decisions>
## Implementation Decisions

### Logging enrichment
- Extend existing `LogEntry` interface with optional `issueId`, `issueIdentifier`, and `sessionId` fields — flat, grep-friendly, no new abstraction
- Log levels: info for key transitions (dispatch, completion, failure, retry scheduled, reconciliation actions like stop/cleanup), debug for tick internals (tick start, candidate filtering, slot checks, state refresh details)
- Add new orchestrator-specific SSE event types (`dispatch`, `reconcile`, `stall`, `retry`) to `RunEvent.type` — dashboard and SSE clients get real-time orchestrator updates alongside existing run events
- Log sink failures (e.g., SSE write errors) are silently swallowed — wrap listener calls in try/catch, discard errors. Sink failure must never crash the orchestrator

### Metrics tracking
- Standalone `MetricsCollector` class in `src/orchestrator/metrics.ts` — separate from Orchestrator class, clean separation of concerns
- In-memory accumulator, no persistence — reset on daemon restart, matches "no DB yet" decision
- Core metric set:
  - Token counts: input/output/total per issue and aggregate
  - Runtime: seconds running per issue and aggregate
  - Retry statistics: attempt counts per issue and aggregate
  - Slot utilization: active/max slots
- Retain completed issue metrics in a bounded buffer (e.g., last 100 issues) — enables history in dashboard/API without unbounded memory growth

### API response shape
- `GET /api/v1/state`: Full snapshot — status, uptime, running issues array (issueId, identifier, startedAt, attempt, tokens), retry queue array (issueId, identifier, nextRetryAt, attempt), slots (active/max), totals (dispatched, completed, failed, tokens)
- `GET /api/v1/issues/:identifier`: Issue + run history — TrackerIssue data, current orchestrator state, active session info (startedAt, lastActivityAt, attempt), metrics history (totalAttempts, totalRuntime, tokens)
- `POST /api/v1/refresh`: Trigger a full tick (reconcile + fetch candidates + dispatch), returns 202 with `{ triggered: true }`
- Error responses use structured envelope per R6.3: `{ error: { code: "NOT_FOUND", message: "Issue not found" } }`

### Dashboard updates
- New dedicated "Orchestrator" page/tab — separate from existing Dashboard page. Shows: status banner (running/stopped), slot utilization bar, running issues table, retry queue, aggregate metrics
- Real-time updates via SSE — subscribe to new orchestrator event types, consistent with existing Run View SSE pattern
- Click issue row to inline expand showing session details, token usage, attempt history — no separate detail page
- "Refresh Now" button in the status bar that calls `POST /api/v1/refresh` for on-demand full tick

### Claude's Discretion
- Exact SSE event payload structure for orchestrator events
- MetricsCollector internal data structures and buffer eviction strategy
- Dashboard component structure within the single HTML file
- Slot utilization visualization style (bar, gauge, text)
- How to route identifier in URL path (encoding strategy for `/api/v1/issues/:identifier`)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/logging/logger.ts`: Logger class with `LogEntry` interface, `data?: Record<string, unknown>` field, listener pattern (`onEntry`). Extend `LogEntry` to add optional issue/session fields
- `src/logging/events.ts`: `RunEvent` type with `emitRunEvent()` + `runEvents` EventEmitter. Add new event types for orchestrator
- `src/daemon/routes.ts`: Fastify route registration pattern with `registerRoutes()`. Add new `/api/v1/*` routes following same pattern
- `src/ui/index.html`: Single-file React+Tailwind dashboard with hash routing. Add new Orchestrator page component
- `src/orchestrator/state.ts`: `OrchestratorState` with `claimed` Set, `running` Map<string, WorkerInfo>, `retryTimers`, `retryAttempts`. Source of truth for API responses
- `src/orchestrator/state.ts`: `WorkerInfo` with `issueId`, `identifier`, `issue`, `startedAt`, `lastActivityAt`, `attempt`. Core data for per-issue API

### Established Patterns
- Fastify routes use simple async handlers returning objects (auto-serialized as JSON)
- SSE uses `reply.raw.writeHead()` + `runEvents.on()` pattern
- Dashboard uses React function components with `useState`/`useEffect`, `fetch()` for API calls
- `tsup.config.ts` `onSuccess` copies `src/ui/index.html` to `dist/ui/index.html`
- Zod schemas with `.default()` for config sections

### Integration Points
- `src/daemon/routes.ts` — register new `/api/v1/*` routes, pass Orchestrator/MetricsCollector as service dependency
- `src/orchestrator/index.ts` — Orchestrator class needs to accept and populate MetricsCollector
- `src/orchestrator/worker.ts` — Worker completion callbacks feed metrics (tokens, runtime)
- `src/logging/events.ts` — Extend RunEvent type union with orchestrator event types
- `src/daemon/server.ts` — Pass orchestrator instance to route registration for API access

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-observability-api-extensions*
*Context gathered: 2026-03-08*
