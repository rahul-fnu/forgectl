# Phase 6: Observability + API Extensions - Research

**Researched:** 2026-03-08
**Domain:** Structured logging, metrics collection, REST API, dashboard UI
**Confidence:** HIGH

## Summary

This phase adds observability to the orchestrator built in Phase 5. The work is purely additive -- no new orchestrator behavior, just exposing internal state through enriched logs, a metrics layer, three new REST endpoints, and a new dashboard page. All integration points are well-defined: `LogEntry` gets new optional fields, `RunEvent` gets new event types, `routes.ts` gets new `/api/v1/*` handlers, and `index.html` gets a new Orchestrator page.

The implementation is straightforward because the existing patterns (Logger listener pattern, SSE via `runEvents` EventEmitter, Fastify route handlers returning auto-serialized JSON, React components with `useState`/`useEffect` and `fetch()`) directly apply. No new libraries are needed. The main complexity is wiring the `MetricsCollector` into the worker lifecycle so token/runtime data flows from `executeWorker` results into the metrics accumulator.

**Primary recommendation:** Build in three plans -- (1) MetricsCollector + Logger enrichment, (2) REST API routes, (3) Dashboard Orchestrator page. Each plan is independently testable.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Extend existing `LogEntry` interface with optional `issueId`, `issueIdentifier`, and `sessionId` fields -- flat, grep-friendly, no new abstraction
- Log levels: info for key transitions, debug for tick internals
- Add new orchestrator-specific SSE event types (`dispatch`, `reconcile`, `stall`, `retry`) to `RunEvent.type`
- Log sink failures silently swallowed -- try/catch around listener calls
- Standalone `MetricsCollector` class in `src/orchestrator/metrics.ts` -- separate from Orchestrator class
- In-memory accumulator, no persistence -- reset on daemon restart
- Core metrics: token counts (input/output/total), runtime (seconds), retry statistics, slot utilization
- Bounded buffer for completed issue metrics (e.g., last 100 issues)
- `GET /api/v1/state`: Full snapshot with status, uptime, running/retry arrays, slots, totals
- `GET /api/v1/issues/:identifier`: Issue + run history with TrackerIssue data, session info, metrics
- `POST /api/v1/refresh`: Trigger full tick, returns 202 `{ triggered: true }`
- Error responses: `{ error: { code: "...", message: "..." } }`
- New dedicated "Orchestrator" page/tab -- separate from existing Dashboard
- Real-time updates via SSE
- Click issue row to inline expand (no separate detail page)
- "Refresh Now" button calling `POST /api/v1/refresh`

### Claude's Discretion
- Exact SSE event payload structure for orchestrator events
- MetricsCollector internal data structures and buffer eviction strategy
- Dashboard component structure within the single HTML file
- Slot utilization visualization style (bar, gauge, text)
- URL identifier encoding strategy for `/api/v1/issues/:identifier`

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R6.1 | Contextual Logging -- issueId, issueIdentifier, sessionId fields on logs; log dispatch/state transitions/retry/reconciliation; sink failure safety | Logger `LogEntry` interface extension with optional fields; try/catch wrapper in `emit()` for listeners; new `RunEvent` types for SSE |
| R6.2 | Runtime Metrics -- token accounting, runtime tracking, retry stats, slot utilization | `MetricsCollector` class with per-issue and aggregate accumulators; bounded completed-issue buffer; fed from `executeWorkerAndHandle` completion callback |
| R6.3 | REST API Extensions -- `/api/v1/state`, `/api/v1/issues/:identifier`, `/api/v1/refresh`; structured error responses | New Fastify routes in `routes.ts`; Orchestrator/MetricsCollector passed as service dependencies; `tick()` function already exported for refresh |
| R6.4 | Dashboard Updates -- orchestrator status panel, per-issue details, real-time SSE | New Orchestrator page component in `index.html`; SSE subscription to orchestrator events; inline expand pattern for issue details |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | existing | REST API route handlers | Already used for daemon routes |
| node:events | built-in | SSE event broadcasting | Already used via `runEvents` EventEmitter |
| react | 18 (CDN) | Dashboard UI components | Already used in single-file dashboard |
| tailwindcss | CDN | Dashboard styling | Already used in single-file dashboard |

### Supporting
No new libraries needed. This phase uses only existing dependencies.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| In-memory MetricsCollector | prom-client (Prometheus) | Overkill for single-daemon, no external metrics store needed yet |
| Flat LogEntry fields | Structured logging lib (pino) | Would require replacing existing Logger; unnecessary churn |
| CDN React | Separate React build | Breaks single-file dashboard pattern established in Phase 6 (v1) |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/
│   ├── metrics.ts          # NEW: MetricsCollector class
│   ├── index.ts            # MODIFY: accept MetricsCollector, expose via getMetrics()
│   ├── dispatcher.ts       # MODIFY: emit orchestrator events, feed metrics on completion
│   ├── scheduler.ts        # MODIFY: emit reconcile events
│   ├── state.ts            # existing (no changes needed)
│   ├── worker.ts           # existing (no changes needed)
│   └── ...
├── logging/
│   ├── logger.ts           # MODIFY: add optional issueId/issueIdentifier/sessionId to LogEntry
│   └── events.ts           # MODIFY: extend RunEvent type union with orchestrator event types
├── daemon/
│   ├── routes.ts           # MODIFY: add /api/v1/* routes, accept Orchestrator service dep
│   └── server.ts           # MODIFY: pass orchestrator to registerRoutes
└── ui/
    └── index.html          # MODIFY: add Orchestrator page component
```

### Pattern 1: MetricsCollector as Standalone Accumulator
**What:** A class that accumulates per-issue and aggregate metrics, with bounded history for completed issues.
**When to use:** When metrics need to be collected from multiple points (dispatcher, worker, reconciler) and queried from multiple points (API, dashboard).
**Example:**
```typescript
// src/orchestrator/metrics.ts
export interface IssueMetrics {
  issueId: string;
  identifier: string;
  tokens: { input: number; output: number; total: number };
  runtimeMs: number;
  attempts: number;
  lastAttemptAt: number;
  status: "running" | "completed" | "failed";
}

export class MetricsCollector {
  private active = new Map<string, IssueMetrics>();
  private completed: IssueMetrics[] = [];
  private readonly maxCompleted: number;
  private startedAt = Date.now();

  constructor(maxCompleted = 100) {
    this.maxCompleted = maxCompleted;
  }

  recordDispatch(issueId: string, identifier: string): void { /* ... */ }
  recordCompletion(issueId: string, tokens: TokenUsage, runtimeMs: number, status: string): void { /* ... */ }
  getSnapshot(): MetricsSnapshot { /* ... */ }
}
```

### Pattern 2: Orchestrator Service Dependency in Routes
**What:** Pass the Orchestrator instance (and MetricsCollector) to route registration so API handlers can access state.
**When to use:** For all `/api/v1/*` routes that need orchestrator state.
**Example:**
```typescript
// Extend RouteServices interface
interface RouteServices {
  pipelineService?: PipelineRunService;
  boardStore?: BoardStore;
  boardEngine?: BoardEngine;
  orchestrator?: Orchestrator;  // NEW
}

// In route handler
app.get("/api/v1/state", async () => {
  if (!orchestrator) return { error: { code: "NOT_CONFIGURED", message: "Orchestrator not running" } };
  return orchestrator.getStateSnapshot();
});
```

### Pattern 3: SSE Event Extension
**What:** Extend `RunEvent.type` union with orchestrator-specific event types and emit them from the orchestrator modules.
**When to use:** Real-time dashboard updates for orchestrator activity.
**Example:**
```typescript
// events.ts - extend type union
export interface RunEvent {
  runId: string;
  type: "started" | "phase" | "validation" | "retry" | "output" | "completed" | "failed"
    | "dispatch" | "reconcile" | "stall" | "orch_retry";  // NEW orchestrator types
  timestamp: string;
  data: Record<string, unknown>;
}

// In dispatcher.ts
emitRunEvent({
  runId: "orchestrator",
  type: "dispatch",
  timestamp: new Date().toISOString(),
  data: { issueId, identifier, attempt },
});
```

### Pattern 4: Global SSE Stream for Orchestrator Events
**What:** Add an SSE endpoint for all orchestrator events (not scoped to a single run).
**When to use:** Dashboard Orchestrator page needs to subscribe to all orchestrator events, not just one run's events.
**Example:**
```typescript
// Global orchestrator events stream
app.get("/api/v1/events", async (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const handler = (event: RunEvent) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* swallow sink errors */ }
  };
  runEvents.on("run:orchestrator", handler);
  request.raw.on("close", () => {
    runEvents.off("run:orchestrator", handler);
  });
});
```

### Anti-Patterns to Avoid
- **Mutating OrchestratorState from MetricsCollector:** MetricsCollector must be a separate accumulator, never modify or read from `OrchestratorState` directly. It gets data via explicit method calls.
- **Coupling logger to orchestrator internals:** LogEntry extension uses flat optional fields, not nested objects. Keep the Logger generic.
- **Blocking the tick loop with metrics:** All metrics recording must be synchronous O(1). No async operations in the metrics path.
- **Unbounded completed issue history:** Use a bounded array/ring buffer. Evict oldest entries when `maxCompleted` is exceeded.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSE protocol | Custom text streaming | Existing `runEvents` EventEmitter + `reply.raw.write()` pattern | Pattern already established and working |
| JSON serialization in routes | Custom response builders | Fastify auto-serialization (return object from handler) | Already the pattern throughout routes.ts |
| URL parameter decoding | Custom identifier parsing | Fastify's built-in `request.params` | Handles standard URL decoding automatically |

**Key insight:** This phase does not introduce any problem that requires a new library or custom infrastructure. Every pattern needed is already established in the codebase.

## Common Pitfalls

### Pitfall 1: SlotManager maxConcurrent not exposed
**What goes wrong:** API needs to report `slots: { active: N, max: M }` but `SlotManager.maxConcurrent` is private.
**Why it happens:** SlotManager was designed for internal use only.
**How to avoid:** Add a `getMax()` getter to SlotManager, or have Orchestrator expose max from config directly.
**Warning signs:** API returns `{ active: N }` without the `max` field.

### Pitfall 2: Race between tick() and POST /api/v1/refresh
**What goes wrong:** If refresh triggers `tick()` while the scheduler's own tick is running, concurrent state mutations can corrupt data.
**Why it happens:** `tick()` does async operations (fetch candidates, dispatch) and scheduler runs on setTimeout.
**How to avoid:** Add a mutex/flag in the scheduler: `if (tickInProgress) return`. Or have refresh set a flag and let the scheduler pick it up. The simplest approach: have `/api/v1/refresh` call `tick()` directly since JavaScript is single-threaded for sync operations, but the async portions can interleave. Use a simple boolean lock: `if (this.ticking) return; this.ticking = true; try { await tick(...) } finally { this.ticking = false; }`.
**Warning signs:** Duplicate dispatches for the same issue.

### Pitfall 3: SSE listener leak on error
**What goes wrong:** If `reply.raw.write()` throws (client disconnected), the error handler must not re-throw, or the EventEmitter's `error` event fires and crashes the process.
**Why it happens:** Node EventEmitter throws unhandled if `error` event has no listener.
**How to avoid:** Wrap every SSE write in try/catch. The CONTEXT.md explicitly requires this: "sink failure must never crash the orchestrator."
**Warning signs:** Process crash with "unhandled error event" stack trace.

### Pitfall 4: Identifier encoding in URL path
**What goes wrong:** Issue identifiers like `owner/repo#123` contain `/` and `#` which break URL routing.
**Why it happens:** TrackerIssue `identifier` can contain special characters.
**How to avoid:** Use `encodeURIComponent()` on the client side when building URLs, and Fastify will automatically decode `:identifier` params. Document this in the API. GitHub identifiers are typically `#123` (just a number with hash), so most cases are simple. Notion identifiers are sanitized to `[A-Za-z0-9._-]` already.
**Warning signs:** 404 errors when trying to fetch issue details.

### Pitfall 5: MetricsCollector not wired to worker completion
**What goes wrong:** Metrics show zeros because nobody calls `recordCompletion()`.
**Why it happens:** The worker completion flow in `executeWorkerAndHandle` (dispatcher.ts) handles results but doesn't know about MetricsCollector.
**How to avoid:** Pass MetricsCollector into TickDeps and then into dispatchIssue. Call `recordCompletion()` in the completion handler alongside the existing comment-posting and retry logic.
**Warning signs:** API returns `{ totals: { tokens: 0, dispatched: N } }`.

### Pitfall 6: Uptime calculation drift
**What goes wrong:** Uptime calculated from `Date.now() - startedAt` drifts if system clock changes.
**Why it happens:** Using wall-clock time for duration measurement.
**How to avoid:** This is acceptable for an approximate uptime display. Don't over-engineer; `Date.now()` is fine for this use case.

## Code Examples

### LogEntry Extension
```typescript
// src/logging/logger.ts - extend interface
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
  // Orchestrator context (optional)
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
}
```

### Safe Listener Emission
```typescript
// src/logging/logger.ts - wrap listeners in try/catch
private emit(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = { timestamp: new Date().toISOString(), level, phase, message, data };
  this.entries.push(entry);
  for (const listener of this.listeners) {
    try {
      listener(entry);
    } catch {
      // Swallow sink failures — must never crash the orchestrator
    }
  }
}
```

### MetricsCollector Bounded Buffer
```typescript
// Eviction: shift oldest when buffer full
recordCompletion(issueId: string, ...): void {
  const metrics = this.active.get(issueId);
  if (!metrics) return;
  this.active.delete(issueId);
  metrics.status = "completed";
  this.completed.push(metrics);
  if (this.completed.length > this.maxCompleted) {
    this.completed.shift(); // O(n) but n=100, acceptable
  }
}
```

### API State Response Shape
```typescript
// GET /api/v1/state response
{
  status: "running" | "stopped",
  uptime: 3600,  // seconds
  running: [
    { issueId: "123", identifier: "#42", startedAt: "...", attempt: 1, tokens: { input: 500, output: 200, total: 700 } }
  ],
  retryQueue: [
    { issueId: "456", identifier: "#43", nextRetryAt: "...", attempt: 2 }
  ],
  slots: { active: 1, max: 3 },
  totals: { dispatched: 10, completed: 8, failed: 1, tokens: { input: 50000, output: 20000, total: 70000 } }
}
```

### Wiring Orchestrator into Routes
```typescript
// server.ts - pass orchestrator to routes
registerRoutes(app, queue, {
  pipelineService,
  boardStore,
  boardEngine,
  orchestrator: orchestrator ?? undefined,  // may be null
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No orchestrator visibility | Phase 6 adds full observability | This phase | API consumers and dashboard can monitor orchestrator |
| Logger has no issue context | Optional issueId/sessionId fields | This phase | Logs are filterable by issue |
| No metrics tracking | In-memory MetricsCollector | This phase | Token/runtime stats visible |

## Open Questions

1. **Tick mutex for /api/v1/refresh**
   - What we know: `tick()` is async and the scheduler uses setTimeout chain
   - What's unclear: Whether two concurrent ticks can cause state corruption
   - Recommendation: Add a simple boolean lock in the Orchestrator class. If tick is in progress, refresh returns 202 with `{ triggered: false, reason: "tick_in_progress" }` or just queues a flag for next tick.

2. **SlotManager.maxConcurrent accessor**
   - What we know: The field is `private readonly`
   - What's unclear: Whether to add a getter or read from config
   - Recommendation: Add a `getMax(): number` public method to SlotManager. Cleanest approach.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest, via devDependencies) |
| Config file | `vitest.config.ts` |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R6.1 | LogEntry includes issueId/issueIdentifier/sessionId | unit | `npx vitest run test/unit/observability-logging.test.ts -x` | No - Wave 0 |
| R6.1 | Log sink failures swallowed | unit | `npx vitest run test/unit/observability-logging.test.ts -x` | No - Wave 0 |
| R6.1 | RunEvent extended with orchestrator types | unit | `npx vitest run test/unit/observability-logging.test.ts -x` | No - Wave 0 |
| R6.2 | MetricsCollector tracks per-issue tokens/runtime | unit | `npx vitest run test/unit/metrics.test.ts -x` | No - Wave 0 |
| R6.2 | MetricsCollector bounded buffer eviction | unit | `npx vitest run test/unit/metrics.test.ts -x` | No - Wave 0 |
| R6.2 | Aggregate totals correct after multiple completions | unit | `npx vitest run test/unit/metrics.test.ts -x` | No - Wave 0 |
| R6.2 | Slot utilization snapshot | unit | `npx vitest run test/unit/metrics.test.ts -x` | No - Wave 0 |
| R6.3 | GET /api/v1/state returns correct shape | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | No - Wave 0 |
| R6.3 | GET /api/v1/issues/:identifier returns issue or 404 | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | No - Wave 0 |
| R6.3 | POST /api/v1/refresh returns 202 | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | No - Wave 0 |
| R6.3 | Error responses use structured envelope | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | No - Wave 0 |
| R6.4 | Dashboard renders orchestrator page | manual-only | N/A | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/metrics.test.ts` -- covers R6.2 (MetricsCollector)
- [ ] `test/unit/observability-logging.test.ts` -- covers R6.1 (LogEntry enrichment, safe listeners, SSE events)
- [ ] `test/unit/observability-routes.test.ts` -- covers R6.3 (API response shapes, error envelopes)

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of `src/logging/logger.ts`, `src/logging/events.ts`, `src/daemon/routes.ts`, `src/daemon/server.ts`, `src/orchestrator/index.ts`, `src/orchestrator/state.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/scheduler.ts`, `src/orchestrator/worker.ts`, `src/ui/index.html`
- Phase CONTEXT.md with locked implementation decisions
- REQUIREMENTS.md R6.1-R6.4 specifications

### Secondary (MEDIUM confidence)
- Fastify route handler patterns (verified from existing codebase usage)
- React CDN component patterns (verified from existing dashboard)

### Tertiary (LOW confidence)
- None -- all findings based on direct code inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, all existing patterns
- Architecture: HIGH -- direct extension of existing code, all integration points verified
- Pitfalls: HIGH -- identified from actual code inspection (private fields, async race conditions, SSE error handling)

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- internal codebase, no external API changes)
