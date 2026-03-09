# Project Research Summary

**Project:** forgectl v2.0 Durable Runtime
**Domain:** Durable AI agent runtime with persistent state, event sourcing, governance, GitHub App interaction, and browser-use integration
**Researched:** 2026-03-09
**Confidence:** HIGH

## Executive Summary

forgectl v2.0 transforms the existing v1.0 orchestrator from an ephemeral, in-memory runtime into a durable, persistent system capable of surviving crashes, pausing for human input, enforcing budgets, and interacting natively through GitHub. The research confirms this is achievable with a minimal dependency footprint: 5 new production dependencies (drizzle-orm, better-sqlite3, @octokit/app, @octokit/webhooks, @octokit/rest) layered onto the existing stack. No frameworks need replacement. The architecture is additive -- existing subsystems gain persistence and new interaction surfaces without architectural rewrites.

The recommended approach is a strict bottom-up build order: storage layer first (SQLite + Drizzle), then identity, then the flight recorder (audit trail), then durable execution (crash recovery and pause/resume), then governance (budgets and approvals), and finally the GitHub App as the primary interaction surface. This order is dictated by hard dependencies: every subsystem above storage needs it, governance needs identity for budget scoping, the GitHub App needs both durable execution (for conversations) and governance (for approvals). Browser-use integration is architecturally independent and should be deferred to late v2.0 or v2.1.

The primary risks are: (1) context serialization for pause/resume -- when an agent resumes hours later with injected context, quality depends on serialization fidelity, which needs experimentation not just engineering; (2) SQLite synchronous blocking under concurrent load -- better-sqlite3 blocks the event loop, requiring WAL mode, short transactions, and careful batching; (3) webhook signature verification against parsed bodies instead of raw bytes -- a common Fastify pitfall that silently breaks authentication. All three are well-understood and have documented mitigations.

## Key Findings

### Recommended Stack

The v2.0 stack adds exactly 5 production dependencies and 3 dev dependencies to the existing v1.0 foundation. The key decision is using `@octokit/app` instead of Probot (which would conflict with the existing Fastify daemon) and `drizzle-orm` + `better-sqlite3` instead of heavier alternatives (Prisma, PostgreSQL, external event stores). No new dependencies are needed for event sourcing, governance state machines, or durable execution -- these are implemented with SQLite tables and existing patterns (discriminated unions, transition functions).

**Core technologies:**
- **drizzle-orm + better-sqlite3:** Embedded database with TypeScript-first ORM. SQLite handles single-machine workloads; WAL mode enables concurrent read/write. Drizzle provides typed queries and migration management without Prisma's binary engine overhead.
- **@octokit/app:** GitHub App toolkit (JWT auth, installation tokens, webhook verification). Replaces Probot, which bundles Express and would conflict with Fastify. Provides the same `webhooks.on()` DX without framework baggage.
- **@octokit/webhooks + @octokit/rest:** Type-safe webhook event handling and GitHub API client. Used via installation-scoped Octokit instances from @octokit/app.

**What NOT to add:** Probot (Express conflict), xstate (overkill for 4-state machines), Prisma (heavy), Temporal/Trigger.dev (require separate servers), BullMQ (requires Redis), EventStoreDB/Kafka (distributed overkill).

### Expected Features

**Must have (table stakes):**
- Schema-driven migrations with WAL mode and auto-migrate on daemon startup
- Repository pattern for all database access (typed query/mutation functions)
- Webhook receiver with HMAC-SHA256 verification and event deduplication
- Bot identity with structured issue comments (status, result, cost)
- Label-based triggers and basic slash commands (/run, /rerun, /stop, /status, /approve, /help)
- Append-only event log per run with typed event payloads
- Crash recovery (resume or fail interrupted runs on daemon restart)
- Idempotent step boundaries with checkpoint storage
- Autonomy levels per workflow (full/semi/interactive/supervised)
- Budget caps per workflow with pre-flight estimation
- PR creation with structured descriptions and check runs

**Should have (differentiators):**
- Conversational clarification (agent asks question mid-run, pauses, resumes on reply) -- the "from your phone" killer feature
- Reactions as approvals (thumbs-up = approve) -- mobile-first approval UX
- Dynamic autonomy escalation (agent self-escalates when uncertain)
- Budget periods with auto-reset (monthly, weekly)
- Container reclamation during pause (release resources, restore on resume)

**Defer to v2.1+:**
- Browser-use integration (cross-language bridge complexity, no built-in REST API)
- Multi-agent delegation (/forgectl decompose)
- Dashboard v2 (GitHub App is the primary UI)
- Full CQRS / event replay for state management
- PostgreSQL support, multi-database sharding
- RBAC, multi-approver workflows

### Architecture Approach

The v2.0 architecture layers six new subsystems onto the v1.0 foundation: Storage (SQLite + Drizzle), Identity (company/agent), Flight Recorder (append-only events), Durable Orchestrator (extended state machine with pause/resume/checkpoint), Governance (autonomy/approvals/budgets), and GitHub App (webhook receiver + bot). The guiding principle is that in-memory state becomes a cache of persistent state -- the scheduler and orchestrator keep their in-memory working sets for performance, but persist at state transitions and rebuild from the database on startup recovery.

**Major components:**
1. **src/storage/** -- SQLite connection singleton, Drizzle schema (12 tables), migrations, repository modules per entity
2. **src/company/** -- Company and agent identity, budget scoping, role assignment
3. **src/audit/** -- Flight recorder subscribing to existing RunEvent emitter, append-only event persistence, state snapshots, query API
4. **src/orchestrator/** (modified) -- Extended state machine with `paused`, `waiting_for_input`, `checkpointed` states; execution locks via SQLite; crash recovery from DB
5. **src/governance/** -- Autonomy enforcement as middleware wrapping dispatch, approval state machine, budget pre-flight checks with atomic reservation
6. **src/github-app/** -- Fastify plugin for webhook routes, slash command parser, bot comment templates, check run creation

**Key patterns:** Repository pattern for all storage access. Event subscriber pattern for cross-cutting concerns (recorder, cost tracking). Fastify plugin encapsulation for route groups. Governance as middleware wrapper (not embedded in orchestrator).

### Critical Pitfalls

1. **SQLite synchronous blocking** -- better-sqlite3 blocks the event loop. Drizzle's async wrapper is deceptive (resolves synchronously). Enable WAL mode, set busy_timeout=5000, keep transactions under 10ms, batch event inserts. Monitor event loop lag in integration tests.

2. **Webhook signature verification against parsed body** -- Fastify parses JSON before handlers run. HMAC must be computed against raw bytes, not `JSON.stringify(request.body)`. Use `@fastify/raw-body` or `preParsing` hook. Use `crypto.timingSafeEqual()`, never `===`.

3. **Context serialization failure on pause/resume** -- Docker container references, closures, Buffers, and class instances don't survive JSON round-trips. Define a strict `SerializableContext` type. Store container ID strings, not container objects. Write round-trip serialization tests.

4. **Event sourcing over-engineering** -- Do NOT build full CQRS. The flight recorder is an audit log, not the source of truth. Current state lives in the `runs` table. Events are for inspection, debugging, and write-back formatting.

5. **Budget race conditions** -- Two concurrent runs can both pass budget checks. Use `BEGIN IMMEDIATE` transactions with atomic reservation: deduct estimated cost before starting, refund difference on completion. Track `reserved` vs `spent` amounts.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Persistent Storage Layer
**Rationale:** Every other phase depends on SQLite storage. Zero user-visible change, pure foundation.
**Delivers:** src/storage/ with Drizzle schema, migrations, repository pattern, auto-migrate on daemon startup. Runs table replaces file-based RunLog as primary persistence.
**Addresses:** Schema-driven migrations, WAL mode, repository pattern, atomic transactions, connection management
**Avoids:** SQLite migration 12-step dance (design schema carefully upfront); synchronous blocking (WAL + busy_timeout from day one)

### Phase 2: Company and Agent Identity
**Rationale:** Budget scoping and audit attribution need identity. Lightweight phase that sets up the entity model.
**Delivers:** src/company/ with company and agent CRUD, roles, budget scope assignment. Extends agent module with identity.ts.
**Addresses:** Multi-agent identity, cost attribution, budget scoping foundations
**Avoids:** Over-designing RBAC (single-user for v2.0, just collaborator checks)

### Phase 3: Flight Recorder / Run Ledger
**Rationale:** Low-risk additive phase (subscriber pattern). Needed by Phase 4 for crash recovery and by Phase 5 for cost tracking.
**Delivers:** src/audit/ with append-only event persistence, cost event recording, CLI inspection (`forgectl run inspect`), rich write-back formatting.
**Addresses:** Event log per run, structured event payloads, cost tracking, query by run/agent/time
**Avoids:** Full CQRS (events are audit trail only, not source of truth); monolithic event types (typed discriminated union)

### Phase 4: Durable Execution
**Rationale:** Hardest engineering phase. Modifies the core state machine. Needs storage and events. Required by Phase 6 for conversational clarification.
**Delivers:** Crash recovery, checkpoint/resume, pause for human input, execution locks, heartbeat persistence, graceful shutdown.
**Addresses:** State machine extensions (paused, waiting_for_input, checkpointed), idempotent step boundaries, container lifecycle during suspension
**Avoids:** Context serialization failures (strict SerializableContext type, round-trip tests); container zombies (workspace bind-mounts as durable state, not containers); Temporal-style replay (simple checkpoint-resume)

### Phase 5: Governance, Approvals, and Budget Enforcement
**Rationale:** Can partially parallelize with Phase 4 (different code paths). Needs identity (Phase 2) and cost tracking (Phase 3).
**Delivers:** src/governance/ and src/costs/ with autonomy levels, approval state machine, budget pre-flight checks, auto-approve rules, budget periods.
**Addresses:** Configurable autonomy per workflow, budget caps, approval gates with timeout, cost attribution
**Avoids:** Approval deadlocks (mandatory timeouts on all pending states); budget race conditions (atomic reservation with BEGIN IMMEDIATE); granular per-tool budgets (budget per run and per agent/period)

### Phase 6: GitHub App
**Rationale:** The primary interaction surface. Depends on durable execution (conversations) and governance (approvals). Highest user-facing impact, should be last major phase.
**Delivers:** src/github-app/ with webhook receiver, slash commands, bot comments, PR creation with check runs, reactions-as-approvals.
**Sub-phases recommended:** 6a (core webhook + bot identity), 6b (slash commands + permissions), 6c (conversational clarification), 6d (reactions-as-approvals), 6e (check runs + PR lifecycle)
**Addresses:** Label-based triggers, structured comments, slash commands, permission checks, webhook deduplication
**Avoids:** Webhook signature verification bugs (raw body capture, timingSafeEqual); synchronous webhook processing (enqueue and return 200); excessive slash commands at launch (6 commands only)

### Phase 7 (Optional): Browser-Use Integration
**Rationale:** Architecturally independent capability extension. Cross-language bridge adds complexity. Defer unless time permits.
**Delivers:** Python sidecar in Docker container, BrowserUseSession adapter, research workflow template.
**Addresses:** LLM-driven web navigation, structured output extraction, cost tracking across TypeScript/Python boundary
**Avoids:** Process zombies (Docker container isolation, not bare subprocess); building custom browser automation (use browser-use framework)

### Phase Ordering Rationale

- **Bottom-up by dependency:** Storage -> Identity -> Events -> Durability -> Governance -> Interaction. Each phase has a clear dependency on the one before it.
- **Risk front-loading:** Phase 4 (durable execution) is the hardest engineering. Placing it mid-sequence means the foundation is solid but it's tackled before governance and GitHub App add more surface area.
- **Phase 5 parallelization opportunity:** Governance touches different code paths than durable execution. Teams with capacity can overlap Phases 4 and 5.
- **GitHub App last:** It depends on everything else and is the most user-visible. Building it last means it can leverage all infrastructure.
- **Browser-use deferred:** Low confidence on integration model (no REST API, cross-language bridge). Not a runtime requirement.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Durable Execution):** Context serialization for resume is under-documented. Needs experimentation with real agent sessions to validate that injected context produces useful agent behavior. Container lifecycle during suspension needs design spikes.
- **Phase 6 (GitHub App):** Sub-phase 6c (conversational clarification) is the hardest feature in the milestone. Webhook-to-suspended-run matching, conversation context management, and mobile UX need phase-level research.
- **Phase 6 (GitHub App):** Fastify 5 raw body support needs verification. May not need `@fastify/raw-body` if Fastify 5 has built-in support via route config.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Storage):** Drizzle + better-sqlite3 + SQLite is thoroughly documented. Standard setup.
- **Phase 2 (Identity):** Simple CRUD entity model. No novel patterns.
- **Phase 3 (Flight Recorder):** Append-only event log is well-documented. Event subscriber pattern already exists in v1.0.
- **Phase 5 (Governance):** State machine and budget enforcement are standard patterns. Existing v1.0 state machine patterns extend naturally.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All dependencies verified via npm with exact versions. Alternatives evaluated with clear rationale. Probot vs @octokit/app decision well-justified. |
| Features | HIGH | Studied Dependabot, Renovate, Copilot coding agent, Probot. Table stakes vs differentiators clearly separated. Dependency graph across features is well-mapped. |
| Architecture | HIGH | Component boundaries, integration points, and data flows are concrete with code examples. Schema design covers all 12 tables across phases. Patterns grounded in v1.0 codebase. |
| Pitfalls | HIGH | 10 critical pitfalls with specific prevention strategies and phase mapping. Most verified via official docs (GitHub webhook docs, SQLite ALTER TABLE docs, better-sqlite3 performance docs). |

**Overall confidence:** HIGH

### Gaps to Address

- **Fastify 5 raw body support:** STACK.md flags MEDIUM confidence on `@fastify/raw-body`. Verify during Phase 6 planning whether Fastify 5 has built-in `rawBody` support via route config, which would eliminate this dependency.
- **Context quality on resume:** The pause/resume feature depends on the agent producing useful output when given injected context about prior work. This is a prompt engineering problem, not a systems problem. Needs experimentation during Phase 4 with real Claude Code sessions.
- **browser-use integration model:** LOW confidence. No built-in REST API (open feature request). The sidecar HTTP bridge pattern is viable but untested. Verify during Phase 7 planning whether browser-use has shipped a REST API by then.
- **Cost tracking across TypeScript/Python boundary:** If browser-use is included, browser-use's LLM calls are opaque. Tracking costs requires instrumenting browser-use or wrapping its LLM client. No established pattern for this.
- **Migration strategy for existing v1.0 installations:** First-run migration from file-based state to SQLite needs design. Not complex, but must not lose existing run history.

## Sources

### Primary (HIGH confidence)
- [drizzle-orm on npm](https://www.npmjs.com/package/drizzle-orm) -- v0.45.1, TypeScript ORM
- [better-sqlite3 on npm](https://www.npmjs.com/package/better-sqlite3) -- v12.6.2, performance docs, WAL mode
- [SQLite ALTER TABLE docs](https://www.sqlite.org/lang_altertable.html) -- migration limitations
- [SQLite WAL mode](https://sqlite.org/wal.html) -- concurrent read/write
- [@octokit/app on npm](https://www.npmjs.com/package/@octokit/app) -- v16.1.2, GitHub App toolkit
- [@octokit/webhooks on npm](https://www.npmjs.com/package/@octokit/webhooks) -- v14.2.0, event handling
- [@octokit/rest on npm](https://www.npmjs.com/package/@octokit/rest) -- v22.0.1, REST API client
- [GitHub webhook validation docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) -- HMAC-SHA256
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite) -- setup and migrations
- [Temporal durable execution](https://temporal.io/blog/building-reliable-distributed-systems-in-node-js-part-2) -- patterns to borrow

### Secondary (MEDIUM confidence)
- [Event sourcing with relational databases](https://softwaremill.com/implementing-event-sourcing-using-a-relational-database/)
- [Event sourcing pitfalls](https://www.baytechconsulting.com/blog/event-sourcing-explained-2025) -- over-engineering traps
- [Cloudflare human-in-the-loop patterns](https://developers.cloudflare.com/agents/guides/human-in-the-loop/) -- dehydration pattern
- [TypeScript orchestration comparison](https://medium.com/@matthieumordrel/the-ultimate-guide-to-typescript-orchestration-temporal-vs-trigger-dev-vs-inngest-and-beyond-29e1147c8f2d)
- [Renovate bot comparison](https://docs.renovatebot.com/bot-comparison/)
- [GitHub Copilot coding agent interaction model](https://dev.to/pwd9000/using-github-copilot-coding-agent-for-devops-automation-3f43)
- [browser-use GitHub repository](https://github.com/browser-use/browser-use) -- 50k+ stars, Python 3.11+

### Tertiary (LOW confidence)
- [browser-use REST API feature request](https://github.com/browser-use/browser-use/issues/166) -- open, not implemented; integration model unverified

---
*Research completed: 2026-03-09*
*Ready for roadmap: yes*
