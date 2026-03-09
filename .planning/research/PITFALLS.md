# Pitfalls Research

**Domain:** Adding durable runtime features (SQLite, event sourcing, webhooks, governance, browser-use) to an existing TypeScript orchestrator
**Researched:** 2026-03-09
**Confidence:** HIGH (most pitfalls verified via official docs + multiple sources)

## Critical Pitfalls

### Pitfall 1: SQLite Migration 12-Step Dance

**What goes wrong:**
SQLite's ALTER TABLE is severely limited compared to PostgreSQL. You cannot DROP COLUMN (in older versions), ADD CONSTRAINT, change column types, or rename constraints. Drizzle Kit generates migrations that assume richer ALTER TABLE support, producing SQL that fails silently or errors at runtime. Teams discover this mid-migration when a schema change that worked in development breaks in production because the migration attempts an unsupported operation.

**Why it happens:**
Developers coming from PostgreSQL/MySQL expect standard ALTER TABLE operations. SQLite requires a 12-step workaround for most schema changes: create new table, copy data, drop old, rename new. Drizzle Kit's `push:sqlite` hides this in development but `generate` may produce migrations that don't handle the 12-step correctly, especially for constraint changes.

**How to avoid:**
- Design the initial schema carefully in Phase 1 -- adding columns is cheap, changing them is expensive
- Use `drizzle-kit generate` and manually inspect every generated migration SQL before committing
- Write integration tests that run migrations against a populated test database, not just an empty one
- Never use `drizzle-kit push` in production; always use versioned migration files
- For constraint changes, write custom migration SQL using the 12-step pattern (BEGIN, CREATE new table, INSERT INTO new FROM old, DROP old, ALTER TABLE RENAME)
- Set `PRAGMA foreign_keys = OFF` before migration, re-enable after

**Warning signs:**
- Migration files with ALTER TABLE DROP COLUMN or ALTER TABLE ALTER COLUMN
- Drizzle Kit generating empty or suspiciously short migration files for schema changes
- Tests passing against empty databases but failing with populated data

**Phase to address:** Phase 1 (Persistent Storage Layer)

---

### Pitfall 2: better-sqlite3 Synchronous API Confusion with Drizzle

**What goes wrong:**
better-sqlite3 is synchronous (blocking the event loop), but Drizzle ORM exposes both async and sync APIs. Developers write `await db.select(...)` thinking it's non-blocking, but the underlying better-sqlite3 call blocks the Node.js event loop. Under load -- especially during agent runs where the daemon must handle webhook deliveries, REST API requests, and database writes simultaneously -- the event loop starves. Webhook signature verification times out, API responses lag, and the system appears hung even though it's just blocked on a synchronous SQLite call.

**Why it happens:**
Drizzle's API returns Promises for better-sqlite3, but the Promise resolves synchronously on the same tick. This looks async but isn't. The forgectl daemon handles concurrent concerns (Fastify HTTP, webhook receiver, orchestrator polling, agent process management) on a single event loop.

**How to avoid:**
- Enable WAL mode immediately: `PRAGMA journal_mode=WAL` -- this allows concurrent reads while writing
- Set `PRAGMA busy_timeout=5000` to wait on lock contention instead of throwing immediately
- Keep transactions short -- never hold a transaction open across async boundaries (agent calls, HTTP requests)
- For write-heavy paths (event sourcing appends, cost event recording), batch inserts using `db.transaction()` with prepared statements
- Profile event loop lag with `monitorEventLoopDelay()` from `perf_hooks` during integration tests
- Consider `worker_threads` for heavy queries if event loop lag exceeds 50ms under load

**Warning signs:**
- HTTP API response times increasing under concurrent agent runs
- Webhook delivery failures due to slow response (GitHub expects response within 10 seconds)
- Event loop lag spikes correlating with database write bursts

**Phase to address:** Phase 1 (Persistent Storage Layer)

---

### Pitfall 3: Webhook Signature Verification Against Parsed Body

**What goes wrong:**
The webhook receiver verifies the HMAC-SHA256 signature against a re-serialized JSON body instead of the raw request body. `JSON.stringify(JSON.parse(body))` does not produce the same bytes as the original payload (e.g., `1.0` becomes `1`, whitespace changes, key ordering differs). Signature verification fails intermittently depending on payload content. The team adds a workaround to skip verification "temporarily" and forgets to fix it, leaving the webhook endpoint unauthenticated.

**Why it happens:**
Fastify (forgectl's HTTP framework) parses JSON bodies by default before route handlers run. By the time the webhook handler sees the request, `request.body` is a parsed JavaScript object. Developers compute the HMAC against `JSON.stringify(request.body)` instead of the raw bytes. This works for simple payloads but fails when JSON serialization is not round-trip stable.

**How to avoid:**
- Register a `preParsing` hook or use Fastify's `addContentTypeParser` to capture the raw body buffer before JSON parsing
- Store the raw buffer on the request object (e.g., `request.rawBody = buf`) and verify the signature against that
- Use `crypto.timingSafeEqual()` for the comparison, never `===` (prevents timing attacks)
- Use SHA-256 exclusively (`X-Hub-Signature-256` header), not the deprecated SHA-1 (`X-Hub-Signature`)
- Test with actual GitHub webhook payloads that contain floating point numbers, unicode, and nested objects

**Warning signs:**
- Signature verification passes in unit tests with hand-crafted payloads but fails with real GitHub deliveries
- Intermittent 401/403 responses on the webhook endpoint
- Comments in code like "// TODO: fix signature verification"

**Phase to address:** Phase 6 (GitHub App)

---

### Pitfall 4: Webhook Event Deduplication Omitted

**What goes wrong:**
GitHub delivers webhooks with at-least-once semantics. Network issues, timeouts (your server took >10s to respond), or GitHub retries cause duplicate deliveries. Without deduplication, the same issue gets dispatched to two agents simultaneously, or an approval is processed twice, or a cost event is double-counted.

**Why it happens:**
Developers test against GitHub's webhook delivery UI which sends each event once. The retry behavior only manifests under production conditions (slow responses, network blips). The `X-GitHub-Delivery` header (unique per delivery) is ignored because it's not part of the event payload.

**How to avoid:**
- Store every `X-GitHub-Delivery` ID in SQLite before processing the event
- Use `INSERT OR IGNORE` with the delivery ID as a unique key -- if the insert fails, skip processing
- Return HTTP 200 immediately after persisting to a queue, before doing any processing (GitHub retries if your response takes >10s)
- Set a TTL-based cleanup for delivery IDs (7 days is sufficient, GitHub retries within minutes)
- Make all webhook handlers idempotent regardless -- deduplication is defense-in-depth, not the only protection

**Warning signs:**
- Duplicate bot comments on the same issue
- Two agents working on the same issue simultaneously
- Cost events showing double charges for single runs

**Phase to address:** Phase 6 (GitHub App)

---

### Pitfall 5: Event Sourcing Over-Engineering -- Full CQRS From Day One

**What goes wrong:**
The team implements full event sourcing with separate read/write models, projections for every query, event versioning, and saga orchestration from the start. The flight recorder becomes the most complex subsystem in the codebase, taking weeks instead of days. Simple queries like "show me the last 10 runs" require maintaining a separate projection instead of a direct table query. Schema changes require event migration strategies. Development velocity collapses.

**Why it happens:**
Event sourcing literature emphasizes CQRS, projections, and aggregate patterns. Teams treat these as requirements rather than tools to apply selectively. The flight recorder's purpose (audit trail) gets conflated with the system's state management (orchestrator state machine).

**How to avoid:**
- The flight recorder is an append-only audit log, NOT the system's source of truth for runtime state
- Keep the orchestrator state machine as the source of truth for current state (runs table, agent status)
- The event ledger records what happened (append-only `events` table) for audit, replay, and debugging
- Do NOT derive current state from event replay -- query the `runs` table directly
- Use typed events with discriminated unions, but keep the event schema simple: `{ type, runId, timestamp, data }`
- Only add projections when a specific query pattern demands it, not speculatively
- Events are immutable and append-only, but current state tables are mutable and directly queryable

**Warning signs:**
- Every read query goes through event replay or a projection
- Adding a simple status field requires creating an event type, updating a projection, and adding a reducer
- The events table has more code than the feature it records
- Team debates aggregate boundaries before shipping any feature

**Phase to address:** Phase 3 (Flight Recorder / Run Ledger)

---

### Pitfall 6: Context Serialization Failure on Pause/Resume

**What goes wrong:**
When an agent enters `waiting_for_input` state, the system serializes the execution context to SQLite for later resume. The context contains objects that don't survive JSON serialization: Docker container references (with socket connections), file handles, Promises, closures, class instances with private fields, circular references, or Buffer objects. On resume, `JSON.parse()` produces a plain object missing methods and prototypes. The resumed agent crashes or behaves incorrectly.

**Why it happens:**
TypeScript classes and runtime objects contain far more than their data -- they have prototypes, closures, private symbols, and opaque handles. `JSON.stringify` silently drops functions, undefined values, Symbols, and circular references. Developers test serialization with simple objects and miss the edge cases that appear with real orchestrator state.

**How to avoid:**
- Define a strict `SerializableContext` type that only contains JSON-safe primitives, arrays, and plain objects
- Separate "resumable state" (serializable: task description, conversation history, checkpoint data, workspace path, agent config) from "runtime handles" (not serializable: container reference, process handle, database connection)
- On resume, reconstruct runtime handles from serializable identifiers (container ID string, workspace path, etc.)
- Write a `serialize()` / `deserialize()` pair with explicit round-trip tests
- Test round-trip serialization in CI: `assert.deepEqual(deserialize(serialize(context)), context)`
- Never store the Docker container object -- store the container ID and re-attach via dockerode on resume

**Warning signs:**
- `JSON.stringify()` calls on objects without round-trip tests
- Serialized state missing fields that were present before serialization
- Resume failures that only happen after the daemon restarts (not just pause/unpause within same process)

**Phase to address:** Phase 4 (Durable Execution)

---

### Pitfall 7: Container Lifecycle Mismatch with Suspended Runs

**What goes wrong:**
A run pauses for human clarification (`waiting_for_input`). The container is left running, consuming resources. After 24 hours with no response, there are now 15 idle containers consuming RAM and Docker resources. Alternatively: the container is stopped on pause, but on resume the workspace state is lost because the container was removed by Docker's cleanup or forgectl's own `container/cleanup.ts`.

**Why it happens:**
The v1 model assumes runs are short-lived: start container, run agent, collect output, destroy container. Durable execution breaks this assumption. There's no clear policy for container lifecycle during suspension, and the existing cleanup logic treats idle containers as candidates for removal.

**How to avoid:**
- On pause: stop the container (not remove) and commit the container state if needed, OR rely on workspace bind-mounts (which persist on the host)
- On resume: start a new container with the same workspace bind-mount -- the workspace directory is the durable state, not the container
- Set a maximum suspension duration per workflow (configurable in WORKFLOW.md) after which the run is marked stalled
- Add container resource limits to the pause policy: if total suspended containers exceed N, oldest are reclaimed first
- The existing `container/cleanup.ts` must be updated to exclude containers associated with `waiting_for_input` runs
- Never store ephemeral container state (installed packages, runtime state) that isn't captured in the workspace or checkpoint

**Warning signs:**
- Docker `ps` showing many stopped or idle containers
- Resume failures with "container not found" errors
- Disk space growing from unreclaimed container layers

**Phase to address:** Phase 4 (Durable Execution)

---

### Pitfall 8: Approval Gate Deadlocks and Zombie Pending States

**What goes wrong:**
An approval is required but no human is available. The run sits in `pending_approval` indefinitely. Other runs that depend on the same workspace or issue are blocked. The approval queue grows silently. Alternatively: a race condition where two concurrent processes both check "is approval pending?" and both proceed, bypassing the gate.

**Why it happens:**
Human-in-the-loop systems must handle the reality that humans are slow, unavailable, or forget. The state machine has clean transitions on paper (`pending -> approved -> executing`) but doesn't account for timeouts, escalation, or the approval never arriving. Budget checks without atomic compare-and-swap allow two runs to each check "budget remaining: $5" and both proceed with $4 costs, exceeding the budget.

**How to avoid:**
- Every `pending_approval` state MUST have a configurable timeout (default: 24h) with an explicit timeout transition (-> `timed_out` or -> `auto_rejected`)
- Use `BEGIN IMMEDIATE` transactions in SQLite for budget checks: read balance, check threshold, deduct, commit -- all in one atomic transaction
- The approval state machine must handle: approve, reject, timeout, cancel, and escalate transitions
- Implement escalation: if no response in X hours, notify a secondary approver or auto-reject
- Use the dehydration pattern: serialize the run state, remove from memory, rehydrate when approval arrives via webhook/polling
- Never block an event loop waiting for approval -- approvals are events that trigger state transitions

**Warning signs:**
- Runs stuck in `pending_approval` for days with no timeout
- Budget overruns despite budget enforcement being "enabled"
- The approval queue has entries but no mechanism to discover or act on them except the CLI

**Phase to address:** Phase 5 (Governance, Approvals & Budget Enforcement)

---

### Pitfall 9: Budget Race Conditions Under Concurrent Dispatch

**What goes wrong:**
Two runs start simultaneously. Both check the agent's remaining budget ($10 remaining). Both estimate $6 cost. Both pass the pre-flight budget check. Both run. Total spend: $12, exceeding the $10 budget by 20%. With 5 concurrent slots, the overrun could be 5x.

**Why it happens:**
The v1 orchestrator uses in-memory state and fire-and-forget dispatch. Budget checks that read the balance and deduct in separate operations are not atomic. Even with SQLite, a `SELECT balance` followed by a separate `UPDATE balance` in different transactions allows the race.

**How to avoid:**
- Use SQLite `BEGIN IMMEDIATE` for budget operations (prevents concurrent writers)
- Atomic budget reservation: `UPDATE budgets SET remaining = remaining - ? WHERE agent_id = ? AND remaining >= ?` -- if zero rows affected, budget insufficient
- Pre-flight budget reservation (not just check): deduct estimated cost before starting, refund the difference on completion
- Track both `reserved` and `spent` amounts: `remaining = total - reserved - spent`
- On run failure or cancellation, release the reservation
- Add a budget margin/buffer (e.g., 10%) to prevent exact-boundary races

**Warning signs:**
- Budget overruns that only happen when multiple runs execute concurrently
- Budget checks that use `SELECT` followed by separate `UPDATE`
- No concept of "reserved" vs "spent" in the cost tracking schema

**Phase to address:** Phase 5 (Governance, Approvals & Budget Enforcement)

---

### Pitfall 10: Browser-Use Python Subprocess Zombies and Resource Leaks

**What goes wrong:**
The TypeScript daemon spawns a Python subprocess for browser-use. The subprocess launches Chromium via Playwright. If the TypeScript process crashes, the Python process and Chromium browser are orphaned -- still running, consuming RAM, and holding ports. If the Python process crashes, Chromium is orphaned. Three layers of process management (Node -> Python -> Chromium) means three layers of cleanup that can each fail independently.

**Why it happens:**
`child_process.spawn()` creates a subprocess but Node.js doesn't automatically kill children on exit. Python's browser-use internally manages Playwright browser instances that also spawn their own processes. Each layer has its own lifecycle management that doesn't know about the others.

**How to avoid:**
- Run browser-use inside a Docker container (forgectl already has container infrastructure), not as a bare subprocess on the host
- If subprocess is necessary: use `spawn()` with `{ detached: false }` and register cleanup handlers on `process.on('exit')`, `SIGTERM`, `SIGINT`, and `uncaughtException`
- Implement a health check: the Python process exposes an HTTP endpoint, and the TypeScript side polls it; if unresponsive for 30s, kill and restart
- Use a thin HTTP/JSON API between TypeScript and Python (FastAPI or Flask), not stdio pipes -- stdio is fragile for structured data and hard to debug
- Set resource limits on the subprocess (memory, CPU time) via Docker or `ulimit`
- Track all spawned PIDs and kill the entire process group (`process.kill(-pid)`) on cleanup
- Browser-use requires Python >=3.11 and Chromium -- validate these exist before spawning, not after

**Warning signs:**
- Orphaned Python or Chromium processes visible in `ps aux` after daemon restart
- Memory usage growing over time without corresponding active runs
- "Address already in use" errors when restarting the browser-use service

**Phase to address:** Phase 6+ (Browser-Use Integration, if included)

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip migration tests, use `push:sqlite` in prod | Faster iteration | Silent data loss on schema changes, impossible rollbacks | Never in production |
| Store raw JSON blobs instead of normalized tables | Faster initial schema design | Can't query, index, or validate blob contents; schema drift | Only for truly unstructured metadata |
| Single events table without partitioning | Simple schema | Table grows unbounded, queries slow down after 100K+ events | OK for first 6 months, plan partitioning by Phase 3 |
| Process webhook events synchronously in handler | Simpler code | Blocks webhook response, GitHub retries, duplicate events | Never -- always queue first, respond 200, process async |
| Skip deduplication, rely on idempotent handlers | Less infrastructure | Idempotency is hard to guarantee across all handlers; subtle bugs | Only if every handler is provably idempotent |
| Use stdio pipes for Python subprocess communication | No HTTP server needed | Fragile framing, hard to debug, blocks on buffer fills, no concurrent requests | Only for single-request-response patterns |
| Auto-approve everything during development | Faster testing | Governance code never tested; production enables governance and it's broken | OK in dev, must have governance integration tests |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| GitHub Webhooks | Parsing body before signature verification | Capture raw body in `preParsing` hook, verify against raw bytes |
| GitHub Webhooks | Using `===` for signature comparison | Use `crypto.timingSafeEqual()` to prevent timing attacks |
| GitHub Webhooks | Processing in the HTTP handler | Return 200 immediately, enqueue event, process asynchronously |
| GitHub App Auth | Using personal access tokens instead of app installation tokens | Generate short-lived installation tokens via JWT + app ID |
| GitHub App Auth | Caching installation tokens without checking expiry | Tokens expire after 1 hour; cache with TTL, refresh proactively |
| Drizzle + SQLite | Using async patterns expecting non-blocking I/O | better-sqlite3 is synchronous; Drizzle's async wrapper still blocks the event loop |
| Drizzle Migrations | Trusting auto-generated migration SQL without inspection | Manually review every migration, especially for constraint changes |
| SQLite Transactions | Holding transactions open across async operations | Keep transactions synchronous and short; do all I/O outside the transaction |
| browser-use (Python) | Spawning without cleanup handlers | Register process group kill on all exit signals; use Docker when possible |
| browser-use (Python) | Sending complex data via stdio | Use HTTP API (FastAPI) for structured communication |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded events table | Queries slow, disk grows, WAL file bloats | Partition by month or archive old events; add indexes on (run_id, timestamp) | >100K events (~2-3 months of heavy use) |
| Full event replay to rebuild state | Run inspection takes seconds instead of milliseconds | Use snapshots at step boundaries; query current state from runs table, not events | >500 events per run |
| Checkpoint starvation in WAL mode | WAL file grows without bound, disk fills up | Periodically run `PRAGMA wal_checkpoint(RESTART)` when WAL exceeds threshold | Sustained concurrent reads during heavy writes |
| Synchronous SQLite blocking event loop | API latency spikes, webhook timeouts, UI freezes | Batch writes, keep transactions <10ms, monitor event loop delay | >10 concurrent operations |
| Loading full conversation history into agent context | Token costs explode, agent performance degrades | Summarize older conversation turns, only send last N exchanges in full | >10 clarification rounds per issue |
| Polling + webhooks without deduplication | Same event processed twice, duplicate work | Store delivery IDs, make handlers idempotent | First week of webhook deployment |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Skipping webhook signature verification | Attacker can trigger arbitrary agent runs by posting fake events | Verify HMAC-SHA256 on every request; reject unsigned requests with 401 |
| Storing GitHub App private key in config file | Key leak exposes all installations | Use keytar (already in stack) or environment variable; never commit to repo |
| Budget bypass via direct API calls | User circumvents governance by calling daemon API directly | All execution paths (webhook, CLI, API, polling) must go through the same budget check |
| Overly broad GitHub App permissions | Compromised app can modify any repo content | Request minimum permissions; use `contents: write` only on repos that need it |
| Python subprocess running as root | browser-use + Chromium with root access is a sandbox escape vector | Run browser-use subprocess as unprivileged user; use Docker with `--user` flag |
| Approval bypass via race condition | Two concurrent requests both read "pending", both approve | Use SQLite `BEGIN IMMEDIATE` for all approval state transitions |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Noisy bot comments on every state change | Users mute the bot, miss important messages | Comment only on: run start, clarification needed, run complete/failed, approval needed |
| Unstructured bot comment formatting | Users can't quickly scan results | Use consistent markdown template: summary, files changed, validation results, cost, next steps |
| No acknowledgment after slash command | User unsure if command was received | Always react with eyes emoji immediately, then follow up with status comment |
| Approval request without context | Human doesn't know what they're approving | Include: what will be done, estimated cost, files that will be modified, why approval is needed |
| Timeout without notification | Run silently stalls, user doesn't know | Comment when approaching timeout: "Still waiting for your response. Will auto-reject in 4 hours." |
| Cost summary only at end | Budget surprise after expensive run | Include running cost in progress updates; warn when approaching budget cap |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **SQLite storage:** Often missing WAL mode, busy_timeout, and foreign key enforcement (`PRAGMA foreign_keys = ON`) -- verify all three PRAGMAs are set on every connection
- [ ] **Migrations:** Often missing rollback/down migrations -- verify every migration has both up and down, tested with data
- [ ] **Webhook handler:** Often missing deduplication, raw body capture, and async processing -- verify all three
- [ ] **Event ledger:** Often missing indexes on (run_id), (agent_id, timestamp), and (type) -- verify query plans for common access patterns
- [ ] **Approval flow:** Often missing timeout transition and escalation path -- verify what happens when no one responds for 48 hours
- [ ] **Budget enforcement:** Often missing reservation (only check, not deduct) -- verify concurrent budget checks with a race condition test
- [ ] **Pause/resume:** Often missing round-trip serialization tests -- verify context survives `JSON.parse(JSON.stringify(context))` and daemon restart
- [ ] **Container lifecycle:** Often missing cleanup exclusion for suspended runs -- verify `container/cleanup.ts` respects `waiting_for_input` state
- [ ] **GitHub App auth:** Often missing token refresh -- verify installation token is refreshed before expiry, not after 401
- [ ] **Slash commands:** Often missing permission checks -- verify non-collaborators cannot trigger runs or approve actions
- [ ] **Browser-use integration:** Often missing process cleanup on crash -- verify no orphaned Python/Chromium processes after forced daemon kill

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Broken migration applied to production | HIGH | Restore from backup; write compensating migration; test migration sequence from scratch on copy of production data |
| Event loop blocked by SQLite | LOW | Add `PRAGMA journal_mode=WAL` and `busy_timeout`; no data loss, just latency during the block |
| Webhook signature verification broken | MEDIUM | Audit webhook delivery log in GitHub App settings for failed deliveries; replay missed events manually; fix verification code |
| Duplicate events processed | MEDIUM | Deduplicate affected records; add delivery ID tracking; replay affected time window with deduplication enabled |
| Over-engineered event sourcing | HIGH | Refactor to simpler append-only log; keep events table but add direct query tables for current state; significant code rewrite |
| Context serialization failure on resume | MEDIUM | Mark affected runs as failed; add round-trip serialization tests; re-dispatch from issue (don't try to recover corrupted state) |
| Container zombies from suspended runs | LOW | Run cleanup script to remove orphaned containers; add cleanup policy; no data loss if workspaces use bind-mounts |
| Approval deadlock (stuck pending) | LOW | Add timeout sweep job; mark stale approvals as timed_out; notify users of the timeout |
| Budget overrun from race condition | MEDIUM | Reconcile actual spend vs budget; pause agent until budget reset; add atomic reservation pattern |
| Orphaned Python/Chromium processes | LOW | Kill process groups; add PID tracking and cleanup-on-startup routine; no data loss |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| SQLite migration 12-step dance | Phase 1 | Integration test: run all migrations against populated test database; verify constraint changes work |
| better-sqlite3 sync blocking | Phase 1 | Load test: 10 concurrent API requests + database writes; measure event loop lag stays <50ms |
| Event sourcing over-engineering | Phase 3 | Architecture review: current state is queryable without event replay; events are for audit only |
| Context serialization failure | Phase 4 | Unit test: round-trip serialize/deserialize for every context type; test survives daemon restart |
| Container lifecycle on suspend | Phase 4 | Integration test: pause run, kill daemon, restart daemon, resume run; workspace state preserved |
| Approval deadlocks | Phase 5 | State machine test: every state has a timeout transition; no terminal `pending` states |
| Budget race conditions | Phase 5 | Concurrency test: 5 simultaneous runs against budget that can only afford 3; verify exactly 3 run |
| Webhook signature verification | Phase 6 | Integration test: verify with real GitHub webhook payload; verify raw body preservation through Fastify |
| Webhook deduplication | Phase 6 | Test: send same delivery ID twice; verify only one run is dispatched |
| Slash command permissions | Phase 6 | Test: simulate non-collaborator issuing commands; verify rejection |
| Browser-use process cleanup | Phase 6+ | Test: force-kill daemon; verify no orphaned Python/Chromium processes after 30 seconds |

## Sources

- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) -- checkpoint starvation, WAL mode, busy timeout (HIGH confidence)
- [SQLite ALTER TABLE official docs](https://www.sqlite.org/lang_altertable.html) -- 12-step migration pattern, limitations (HIGH confidence)
- [GitHub webhook validation docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) -- HMAC-SHA256, raw body requirement (HIGH confidence)
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) -- common verification mistakes (HIGH confidence)
- [GitHub community discussion on webhook retries](https://github.com/orgs/community/discussions/151676) -- at-least-once delivery, X-GitHub-Delivery deduplication (HIGH confidence)
- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite) -- sync/async API, transaction handling (HIGH confidence)
- [Event Sourcing pitfalls - Baytechconsulting](https://www.baytechconsulting.com/blog/event-sourcing-explained-2025) -- over-engineering traps, when not to use (MEDIUM confidence)
- [3 Killer Event Sourcing Mistakes](https://junkangworld.com/blog/3-killer-event-sourcing-mistakes-you-must-avoid-in-2025) -- generic events, aggregate bloat, public vs internal events (MEDIUM confidence)
- [Temporal durable execution docs](https://temporal.io/blog/building-reliable-distributed-systems-in-node-js-part-2) -- determinism, serialization, replay (HIGH confidence)
- [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) -- checkpoint/replay, serialization patterns (HIGH confidence)
- [Cloudflare human-in-the-loop patterns](https://developers.cloudflare.com/agents/guides/human-in-the-loop/) -- dehydration pattern, timeout handling (MEDIUM confidence)
- [browser-use on PyPI](https://pypi.org/project/browser-use/) -- Python >=3.11, Chromium dependency, API shape (HIGH confidence)
- [SQLite event sourcing patterns](https://www.sqliteforum.com/p/building-event-sourcing-systems-with) -- snapshotting, table growth management (MEDIUM confidence)

---
*Pitfalls research for: forgectl v2.0 Durable Runtime*
*Researched: 2026-03-09*
