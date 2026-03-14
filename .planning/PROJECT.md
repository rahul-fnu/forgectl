# forgectl — AI Agent Orchestrator

## What This Is

forgectl is a CLI + daemon that orchestrates AI agents (Claude Code, Codex, browser-use) in isolated Docker containers. It continuously polls issue trackers, dispatches agents to sandboxed workspaces, validates results, and reports back — with zero human intervention after setup. Now an autonomous factory: agents can decompose complex issues into subtasks, delegate to child workers, self-correct through test-fail-fix loops, and route pipeline execution through conditional and iterative branches.

## Core Value

Continuously pull work from issue trackers, dispatch AI agents to execute it in sandboxed environments, validate results, and report back — with zero human intervention after setup.

## Requirements

### Validated

- Pluggable issue tracker adapter (GitHub Issues + Notion) — v1.0
- Orchestration state machine (claim/running/retry/released with reconciliation) — v1.0
- Polling loop with candidate selection, concurrency control, dispatch priority — v1.0
- In-repo WORKFLOW.md contract (YAML front matter + prompt template + hot-reload) — v1.0
- Workspace persistence and lifecycle management (per-issue, reusable, with hooks) — v1.0
- Hybrid agent session model (CLI one-shot + JSON-RPC persistent subprocess) — v1.0
- Dynamic config reload (hot-reload WORKFLOW.md without restart) — v1.0
- Exponential backoff retry queue with configurable caps — v1.0
- Stall detection and active run reconciliation — v1.0
- Structured logging with issue/session context fields — v1.0
- REST API for orchestrator state (/api/v1/state, /issues, /refresh) — v1.0
- Real-time dashboard with orchestrator monitoring — v1.0
- End-to-end demo: GitHub issue → dispatch → validate → comment → auto-close — v1.0
- Backward compatibility (forgectl run, forgectl pipeline still work) — v1.0
- SQLite persistent storage with Drizzle ORM, auto-migrations, typed repositories — v2.0
- Append-only flight recorder with event sourcing audit trail and state snapshots — v2.0
- CLI `forgectl run inspect <id>` for full audit trail — v2.0
- Rich write-back: structured GitHub comments with changes, validation, cost — v2.0
- Crash recovery: interrupted runs resume or fail cleanly on daemon restart — v2.0
- Checkpoint/resume at step boundaries with idempotent replay — v2.0
- Pause for human input with persistent context and resume on reply — v2.0
- Atomic execution locks per issue/workspace via SQLite — v2.0
- Configurable autonomy levels (full/semi/interactive/supervised) per workflow — v2.0
- Approval state machine with auto-approve rules — v2.0
- GitHub App: webhook receiver, HMAC verification, slash commands, permission checks — v2.0
- Conversational clarification: agent asks question, pauses, resumes on reply — v2.0
- Check runs on PRs and auto-generated PR descriptions — v2.0
- Browser-use agent adapter with Python sidecar for web research workflows — v2.0
- Conditional pipeline nodes with filtrex expression evaluation, if/else branching — v2.1
- Ready-queue executor with runtime condition evaluation, cascade skip, else_node activation — v2.1
- if_failed/if_passed YAML shorthand for condition expressions — v2.1
- Skipped node status visible in pipeline API and dry-run annotations — v2.1
- Condition evaluation errors treated as fatal (no silent skipping) — v2.1
- Loop pipeline nodes with until expression and configurable max_iterations — v2.1
- Global max_iterations safety cap (50) enforced regardless of YAML value — v2.1
- Per-iteration loop checkpointing for crash recovery mid-loop — v2.1
- Loop iteration counter exposed via REST API — v2.1
- Lead agent decomposes issues into structured subtask specs via sentinel-delimited manifest — v2.1
- Concurrent child worker dispatch with two-tier slot pool (top-level vs child) — v2.1
- Delegation depth hard-capped at 2, maxChildren budget from WORKFLOW.md — v2.1
- Parent/child run relationships persisted in SQLite, survive daemon restart — v2.1
- Failed child retry with updated instructions incorporating failure context — v2.1
- Lead agent synthesizes all child results into single aggregate summary — v2.1
- Self-correction: test-fail/fix/retest pipeline with progressive context across iterations — v2.1
- Fix agent exclusion enforcement (WORKFLOW.md exclude list) — v2.1
- Coverage self-correction with structured output parsing and _coverage variable — v2.1
- No-progress detection aborts loops when consecutive iterations produce identical output — v2.1

### Active

(None yet — define requirements for next milestone with `/gsd:new-milestone`)

### Out of Scope

- Visual drag-and-drop workflow builder — deferred to v3, developer dashboard first
- Distributed multi-worker execution — single machine first, scale later
- Multi-tenant RBAC — single-user for now
- Linear/Jira tracker adapters — GitHub + Notion first, others after adapter interface is proven
- Generic LLM adapter interface (OpenAI, Gemini APIs) — deferred from v1.0
- Notion App integration (database triggers, rich write-back) — deferred
- Mirrored task model / tracker normalization — deferred
- Dashboard v2 (power-user aggregate views) — deferred
- Slack/Discord bot — get GitHub + Notion right first
- Your own mobile app — GitHub and Notion apps are the UI
- Full CQRS / event replay for state — events are audit trail, not source of truth
- PostgreSQL support — SQLite sufficient for single-machine
- Per-tool budget granularity — budget per run and per agent/period is enough
- Temporal/BullMQ external dependencies — app-level checkpointing on SQLite
- Unlimited delegation depth — depth=2 sufficient, each level multiplies cost
- Turing-complete condition expressions — security risk, safe expression subset only
- Runtime pipeline modification (adding nodes dynamically) — makes checkpoint fragile
- Parallel alternative fix attempts — merge conflicts from parallel fixes
- Agents weakening tests — fix agents excluded from test file modifications
- External API calls in conditions — non-deterministic, hard to checkpoint

## Context

Shipped v2.1 with 17,026 LOC TypeScript (src) + 22,248 LOC tests. 1,211 tests passing across 100 test files. 24 phases, 57 plans executed across 3 milestones over 14 days.

Tech stack: TypeScript, Node.js 20+, Commander, Fastify, Dockerode, Zod, Vitest, tsup, Drizzle ORM, better-sqlite3, @octokit/app, @octokit/webhooks, @octokit/rest, filtrex, picomatch.

Key subsystems: CLI, config, container, agent (Claude Code + Codex + browser-use), orchestrator (scheduler, dispatcher, reconciler, delegation), tracker (GitHub + Notion), workspace, workflow, validation, output, pipeline (condition evaluator, loop executor, checkpoint, coverage, exclusion), daemon, UI, storage (SQLite), flight recorder, governance, github-app.

v2.1 added conditional pipeline branching, loop iteration with safety caps, multi-agent delegation with two-tier slot management, and self-correction integration proving the composition of these primitives works end-to-end.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GitHub Issues as first tracker | Most accessible, everyone has GitHub | ✓ Good |
| Hybrid agent sessions (CLI + persistent) | Simple tasks use CLI, complex use persistent | ✓ Good |
| Symphony patterns adapted, not copied | Symphony is Codex-specific; forgectl is agent-agnostic | ✓ Good |
| Single machine first | Reduce complexity, prove the model before scaling | ✓ Good |
| In-repo WORKFLOW.md contract | Teams version-control their agent policy alongside code | ✓ Good |
| Notion as second adapter | Validates adapter interface is truly pluggable | ✓ Good |
| Factory registry for stateful adapters | Adapters hold private state (ETag, cache, rate limits) | ✓ Good |
| TrackerIssue.id = API-addressable identifier | Issue number for GitHub, page UUID for Notion | ✓ Good (Phase 9 fix) |
| SQLite over Postgres | Zero-config, embeddable, sufficient for single-machine | ✓ Good — WAL mode handles concurrent reads/writes |
| @octokit/app over Probot | Avoids Express conflict with Fastify | ✓ Good — clean plugin integration |
| Event-sourced audit trail (not CQRS) | Append-only for audit, RunQueue still source of truth | ✓ Good — simpler, EventRecorder swallows errors |
| Autonomy per workflow, not global | Different work needs different oversight; in WORKFLOW.md | ✓ Good — auto-approve rules add flexibility |
| GitHub App as primary UI | Slash commands, reactions, conversations from phone | ✓ Good — full lifecycle control from GitHub |
| HTTP sidecar for browser-use | Bridge TypeScript adapter to Python library | ✓ Good — clean process isolation |
| Gap closure phases (16-19) | Audit found wiring gaps between subsystems | ✓ Good — all 32 integration points verified |
| filtrex for condition expressions | Zero deps, ESM, boolean-first, sandboxed — safe for user YAML | ✓ Good — reused for loop until expressions too |
| Ready-queue executor over static topo-sort | Runtime branching requires dynamic scheduling | ✓ Good — enabled conditions, loops, and skip propagation |
| Two-tier slot pool for delegation | Prevents child agents from starving top-level work | ✓ Good — independent Maps, strict pool separation |
| Loops as opaque meta-nodes | No DAG back-edges, compatible with cycle detector | ✓ Good — executeLoopNode handles iteration internally |
| Crash-safe row-before-dispatch | Insert delegation row before dispatch, not after | ✓ Good — survives daemon crash mid-delegation |
| extractCoverage returns -1 sentinel | Safe for numeric filtrex comparisons (no null/undefined) | ✓ Good — _coverage >= 80 evaluates false cleanly |
| checkExclusionViolations as standalone module | Extracted from inline executor code for testability | ✓ Good — real git repo tests instead of mocking execSync |

## Constraints

- **Tech stack**: TypeScript, Node.js 20+, existing dependencies (commander, fastify, dockerode, zod)
- **Agent model**: Must support one-shot CLI calls, persistent subprocess sessions, and HTTP sidecar
- **Tracker agnostic**: Generic adapter interface — no hardcoded assumptions in core
- **Backward compatible**: Existing `forgectl run` and `forgectl pipeline` commands must keep working
- **Single process**: No distributed queue yet — single daemon process with SQLite-backed state
- **Pipeline safety**: Condition expressions sandboxed via filtrex, no arbitrary code execution

---
*Last updated: 2026-03-14 after v2.1 milestone*
