# Technology Stack: v2.0 Additions

**Project:** forgectl v2.0 Durable Runtime
**Researched:** 2026-03-09
**Scope:** NEW dependencies only. Existing stack (TypeScript, Node 20+, Commander, Fastify 5, Dockerode, Zod, Vitest, tsup, etc.) is validated and excluded.

## Recommended Stack Additions

### Database Layer

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `better-sqlite3` | ^12.6.2 | SQLite driver | Fastest synchronous SQLite driver for Node.js. Native bindings, zero-config embedded database. Synchronous API is an advantage for forgectl's single-process daemon -- no connection pool needed, no async overhead for simple queries. WAL mode gives concurrent read/write without blocking. |
| `drizzle-orm` | ^0.45.1 | ORM / query builder | TypeScript-first, SQL-like syntax, zero runtime overhead. Schema defined in TypeScript (co-located with Zod validation already in the project). Supports prepared statements for performance. Thin abstraction -- you can drop to raw SQL when needed. |
| `drizzle-kit` | ^0.31.9 | Schema migrations (dev dep) | Generates and runs SQL migrations from schema diffs. `drizzle-kit generate` creates migration files, `drizzle-kit migrate` applies them. Keeps schema changes version-controlled and reviewable. |
| `@types/better-sqlite3` | ^7.6.13 | Type definitions (dev dep) | TypeScript types for better-sqlite3 API. |

**Confidence:** HIGH -- drizzle-orm + better-sqlite3 is the standard TypeScript/SQLite combination. Verified via npm and official docs.

**Key configuration:**
- Enable WAL mode on database open: `db.pragma('journal_mode = WAL')` -- required for concurrent read/write during daemon operation.
- Use `BEGIN IMMEDIATE` transactions for execution locks (prevents SQLITE_BUSY on write contention).
- Store database at `~/.forgectl/forgectl.db` (alongside existing `daemon.pid`).
- Drizzle config file (`drizzle.config.ts`) points to schema directory and migrations output.

### GitHub App

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@octokit/app` | ^16.1.2 | GitHub App toolkit | Handles JWT authentication, installation tokens, webhook verification, and event routing. Lower-level than Probot, which is the right choice because forgectl already has Fastify and its own daemon architecture. Probot brings its own Express server -- unnecessary overhead and architectural conflict. |
| `@octokit/webhooks` | ^14.2.0 | Webhook event handling | Type-safe webhook event definitions and payload parsing. `webhooks.on("issues.labeled", handler)` pattern. Included transitively by `@octokit/app` but useful to reference directly for types. |
| `@octokit/rest` | ^22.0.1 | GitHub REST API client | Typed methods for all GitHub API endpoints. `octokit.rest.issues.createComment()`, `octokit.rest.checks.create()`, etc. Used via installation-scoped Octokit instances from `@octokit/app`. |
| `@octokit/types` | ^16.0.0 | Shared TypeScript types (dev dep) | Webhook payload types, API response types. Useful for typing handler functions. |

**Confidence:** HIGH -- Octokit is GitHub's official SDK. Versions verified via npm.

**Why NOT Probot:**
Probot (v14.2.4) is a framework that bundles its own Express server, logging, and app lifecycle. forgectl already has all of this via Fastify + structured logger + daemon lifecycle. Using Probot would mean either (a) running two HTTP servers, (b) fighting Probot's Express internals to integrate with Fastify via `@fastify/middie`, or (c) replacing Fastify with Express. None of these are acceptable.

Instead, use `@octokit/app` directly, which is what Probot uses internally. This gives you:
- `app.webhooks.on()` for event routing (same DX as Probot)
- `app.getInstallationOctokit()` for per-installation API calls
- `app.webhooks.verify()` for HMAC-SHA256 signature verification
- Full control over HTTP layer (Fastify routes, not Express middleware)

**Fastify integration pattern:**
```typescript
// Register webhook route in existing Fastify daemon
fastify.post('/webhooks/github', {
  config: { rawBody: true } // needed for HMAC verification
}, async (request, reply) => {
  await app.webhooks.verifyAndReceive({
    id: request.headers['x-github-delivery'],
    name: request.headers['x-github-event'],
    signature: request.headers['x-hub-signature-256'],
    payload: request.rawBody,
  });
  reply.send({ ok: true });
});
```

No middleware adapter needed. Direct Fastify route handler calling Octokit's verify/receive directly.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@fastify/raw-body` | ^3.1.0 | Raw body access in Fastify | Required for GitHub webhook HMAC-SHA256 verification. Fastify parses JSON by default -- you need the raw bytes to verify the signature. |

**Confidence:** MEDIUM -- need to verify exact package name and version. Fastify 5 may have built-in `rawBody` support via route config. Check Fastify 5 docs before adding this dependency.

### Event Sourcing / Flight Recorder

**No new dependencies needed.** The event sourcing pattern for the flight recorder is implemented with:
- `drizzle-orm` + `better-sqlite3` (already added above) for the append-only event store
- `zod` (already in project) for event payload validation
- Standard SQLite features: auto-increment IDs for ordering, timestamps, JSON columns for event payloads

**Architecture notes:**
- Events table: `id`, `run_id`, `event_type`, `payload` (JSON), `created_at`, `sequence_number`
- Append-only: never UPDATE or DELETE event rows. Use a DB trigger or application-level enforcement.
- State snapshots: periodic materialized state stored in a separate `state_snapshots` table for fast reconstruction without replaying full history.
- SQLite JSON functions (`json_extract`, `json_each`) handle querying into event payloads when needed.

### Governance / Approval State Machine

**No new dependencies needed.** The approval state machine and budget enforcement use:
- `zod` (existing) for approval/budget config validation
- `drizzle-orm` + `better-sqlite3` (added above) for approval records, budget tracking
- Existing orchestrator state machine patterns from v1.0 extend naturally

**Architecture notes:**
- Approvals table: `id`, `type`, `status` (pending/approved/rejected), `requested_by`, `decided_by`, `reason`, `created_at`, `decided_at`
- Budget tracking: `cost_events` table with running aggregation queries
- State transitions enforced in application code (TypeScript discriminated unions + Zod), not DB triggers
- `BEGIN IMMEDIATE` transactions for atomic budget checks (check-then-deduct pattern)

### Durable Execution

**No new dependencies needed.** Session persistence and crash recovery use:
- `drizzle-orm` + `better-sqlite3` (added above) for session state, checkpoints
- Existing workspace manager and agent session interfaces from v1.0

**Architecture notes:**
- `sessions` table: `id`, `agent_id`, `issue_id`, `status`, `checkpoint_data` (JSON), `last_heartbeat`, `created_at`
- On daemon restart: query `sessions WHERE status IN ('running', 'paused')`, reconcile against actual container state
- Checkpoint data serialized as JSON blob -- contains enough context to rebuild agent prompt with prior work
- Execution locks via SQLite `BEGIN IMMEDIATE` + unique constraint on `(issue_id, status='running')`

### Browser-Use Integration (Deferred Assessment)

| Technology | Version | Purpose | Notes |
|------------|---------|---------|-------|
| `browser-use` (Python) | 0.12.1 | Browser automation agent | Python package, NOT a Node.js dependency. Would run as a separate Docker container with a thin HTTP API wrapper. |

**Confidence:** LOW -- browser-use does NOT have a built-in REST API server (there is an open feature request, GitHub issue #166). Integration requires building a custom Python FastAPI/Flask wrapper around the browser-use Agent class and running it as a sidecar service.

**Recommendation:** Defer browser-use integration to v2.1+. The integration effort is non-trivial (custom Python service, Docker orchestration, API contract design) and is not listed in the v2.0 roadmap phases. If needed earlier, the simplest approach is a Docker container running a FastAPI app that exposes `/run` endpoint wrapping `browser_use.Agent`.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| SQLite driver | `better-sqlite3` | `libsql` / `@libsql/client` | libsql is Turso's fork -- adds features forgectl doesn't need (embedded replicas, HTTP protocol). better-sqlite3 is simpler, faster for local-only use, and the standard choice for embedded SQLite in Node.js. |
| ORM | `drizzle-orm` | `prisma` | Prisma generates a query engine binary, adds significant bundle size, and has its own migration system that conflicts with the lightweight approach. Drizzle is SQL-like (less magic), TypeScript-native, and 10x smaller. |
| ORM | `drizzle-orm` | `kysely` | Kysely is query-builder only (no migrations, no schema introspection). Drizzle provides the full package: schema definition, migrations, query builder, and prepared statements. |
| ORM | `drizzle-orm` | Raw SQL via `better-sqlite3` | Possible but loses type safety on queries, requires manual migration management, and increases maintenance burden as schema grows to 10+ tables. |
| GitHub App framework | `@octokit/app` | `probot` | Probot bundles Express, its own logging, and app lifecycle. forgectl already has Fastify + structured logger + daemon. Using Probot creates architectural conflicts. `@octokit/app` provides the same webhook/auth primitives without the framework baggage. |
| GitHub App framework | `@octokit/app` | Raw `@octokit/rest` + manual JWT | Too much boilerplate. `@octokit/app` handles JWT generation, installation token refresh, and webhook verification -- all things you'd have to reimplement. |
| Event store | SQLite (Drizzle) | EventStoreDB | Overkill for single-machine. EventStoreDB is a separate server process, adds operational complexity, and forgectl's event volume (thousands, not millions) is well within SQLite's capabilities. |
| Event store | SQLite (Drizzle) | Kafka / NATS | Distributed streaming is out of scope. forgectl is single-process. SQLite append-only table is the event log. |
| State machine | Application code | `xstate` | xstate adds complexity for state machines that are simple enough to express as TypeScript discriminated unions + transition functions (pattern already used in v1.0 orchestrator). The governance state machine has ~4 states and ~6 transitions -- xstate is overkill. |
| Durable execution | Custom (SQLite checkpoints) | `temporal` SDK | Temporal requires a separate server cluster. forgectl needs durable execution semantics, not the full Temporal infrastructure. Borrow the patterns (checkpointing, idempotent steps, replay), implement with SQLite. |
| Durable execution | Custom (SQLite checkpoints) | `trigger.dev` | Trigger.dev is a hosted service / self-hosted server. Same problem as Temporal -- adds infrastructure forgectl doesn't need. |

## What NOT to Add

| Dependency | Why Skip |
|------------|----------|
| `probot` | Bundles Express server. Architectural conflict with existing Fastify daemon. Use `@octokit/app` instead. |
| `xstate` | Overkill for the state machines in this project. Existing pattern (discriminated unions + transition functions) works. |
| `prisma` | Heavy ORM with binary engine. Drizzle is lighter, faster, more SQL-like. |
| `temporal` / `@temporalio/worker` | Requires separate server infrastructure. Borrow patterns, don't import the framework. |
| `eventemitter3` or `mitt` | Node.js built-in `EventEmitter` is sufficient. Already used in v1.0. |
| `bull` / `bullmq` | Requires Redis. forgectl's RunQueue is in-memory with SQLite persistence -- no need for a separate job queue. |
| `pg` / `postgres` | Out of scope. Single-machine deployment uses SQLite. Postgres migration is a v3+ concern if ever. |
| `express` | Already using Fastify. Don't introduce a second HTTP framework via Probot or otherwise. |
| `smee-client` | Probot's webhook proxy for development. Use `ngrok` or Cloudflare Tunnel instead if needed for local webhook testing -- don't add a dependency for it. |
| `jsonwebtoken` | `@octokit/app` handles JWT internally. Don't add a separate JWT library. |
| `cron` / `node-cron` | Existing setTimeout chain pattern from v1.0 scheduler works. Don't add a cron library. |
| `uuid` | Node.js 20+ has `crypto.randomUUID()` built-in. |
| `date-fns` / `dayjs` | Not needed. Use `Date` and ISO strings. Budget periods use simple epoch math. |
| `browser-use` (npm) | Doesn't exist as an npm package. The Python package requires a custom sidecar service -- defer. |

## Installation

```bash
# Core new dependencies
npm install drizzle-orm better-sqlite3 @octokit/app @octokit/webhooks @octokit/rest

# Dev dependencies
npm install -D drizzle-kit @types/better-sqlite3 @octokit/types
```

**Total new production dependencies:** 5
**Total new dev dependencies:** 3

This is a minimal surface area for the scope of v2.0. Every dependency earns its place.

## Integration Points with Existing Stack

| Existing | New | Integration |
|----------|-----|-------------|
| Fastify daemon (`src/daemon/`) | `@octokit/app` webhooks | New route group `/webhooks/github` in Fastify. Octokit's verify/receive called from Fastify handler. No middleware adapter needed. |
| Fastify daemon (`src/daemon/`) | `better-sqlite3` | Database opened on daemon start, closed on shutdown. Connection passed to repository layer. |
| Zod (`src/config/`) | `drizzle-orm` schema | Zod validates runtime config/input. Drizzle defines DB schema. They complement, don't overlap. |
| Orchestrator state machine (`src/orchestration/`) | SQLite sessions/checkpoints | State machine transitions write to SQLite. On restart, state is recovered from DB instead of lost. |
| Tracker adapters (`src/tracker/`) | GitHub App webhooks | GitHub tracker adapter gains a second input path: webhooks in addition to polling. Polling remains fallback for users who can't receive webhooks. |
| RunLog JSON writer (`src/logging/`) | Flight recorder (SQLite events) | RunLog writes become event inserts. Existing RunLog format can be a compatibility layer that reads from the event store. |
| Commander CLI (`src/cli/`) | SQLite queries | New CLI commands (`forgectl approval list`, `forgectl costs summary`, `forgectl run inspect`) query SQLite directly. |
| Agent sessions (`src/agent/`) | Durable execution | Session state serialized to SQLite. On resume, session context rebuilt from checkpoint + event replay. |

## Database Schema Preview

Tables needed across all v2.0 phases:

| Table | Phase | Purpose |
|-------|-------|---------|
| `companies` | 2 | Tenant identity, config |
| `agents` | 2 | Agent identity, role, status, budget scope |
| `runs` | 1 | Run metadata (replaces file-based run logs) |
| `events` | 3 | Append-only event ledger (flight recorder) |
| `state_snapshots` | 3-4 | Materialized state at step boundaries |
| `sessions` | 4 | Durable execution sessions |
| `checkpoints` | 4 | Step-boundary state for crash recovery |
| `approvals` | 5 | Approval requests and decisions |
| `cost_events` | 5 | Token/cost tracking per run/agent |
| `budgets` | 5 | Agent/company budget limits and usage |
| `conversations` | 6 | GitHub comment threads for clarification |
| `webhook_deliveries` | 6 | Idempotency tracking for webhook deduplication |

All tables defined in `src/storage/schema.ts` using Drizzle's TypeScript schema DSL. Migrations generated by `drizzle-kit generate` and applied via `drizzle-kit migrate` (or programmatically on daemon start).

## Sources

- [drizzle-orm on npm](https://www.npmjs.com/package/drizzle-orm) -- v0.45.1
- [drizzle-kit on npm](https://www.npmjs.com/package/drizzle-kit) -- v0.31.9
- [better-sqlite3 on npm](https://www.npmjs.com/package/better-sqlite3) -- v12.6.2
- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite)
- [@octokit/app on npm](https://www.npmjs.com/package/@octokit/app) -- v16.1.2
- [@octokit/app GitHub](https://github.com/octokit/app.js/) -- GitHub App toolkit
- [@octokit/webhooks on npm](https://www.npmjs.com/package/@octokit/webhooks) -- v14.2.0
- [@octokit/rest on npm](https://www.npmjs.com/package/@octokit/rest) -- v22.0.1
- [Probot on npm](https://www.npmjs.com/package/probot) -- v14.2.4 (evaluated, not recommended)
- [SQLite WAL mode](https://sqlite.org/wal.html) -- concurrent read/write
- [Event sourcing with SQLite](https://www.sqliteforum.com/p/building-event-sourcing-systems-with) -- append-only patterns
- [browser-use on PyPI](https://pypi.org/project/browser-use/) -- v0.12.1 (Python, no REST API)
- [browser-use REST API feature request](https://github.com/browser-use/browser-use/issues/166) -- open, not implemented
