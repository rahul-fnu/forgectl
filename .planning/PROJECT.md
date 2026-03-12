# forgectl — AI Agent Orchestrator

## What This Is

forgectl is a CLI + daemon that orchestrates AI agents (Claude Code, Codex, browser-use) in isolated Docker containers. It continuously polls issue trackers, dispatches agents to sandboxed workspaces, validates results, and reports back — with zero human intervention after setup. Now a durable runtime with crash recovery, governance gates, and a GitHub App for phone-first control via slash commands, reactions, and conversational clarification.

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
- ✓ SQLite persistent storage with Drizzle ORM, auto-migrations, typed repositories — v2.0
- ✓ Append-only flight recorder with event sourcing audit trail and state snapshots — v2.0
- ✓ CLI `forgectl run inspect <id>` for full audit trail — v2.0
- ✓ Rich write-back: structured GitHub comments with changes, validation, cost — v2.0
- ✓ Crash recovery: interrupted runs resume or fail cleanly on daemon restart — v2.0
- ✓ Checkpoint/resume at step boundaries with idempotent replay — v2.0
- ✓ Pause for human input with persistent context and resume on reply — v2.0
- ✓ Atomic execution locks per issue/workspace via SQLite — v2.0
- ✓ Configurable autonomy levels (full/semi/interactive/supervised) per workflow — v2.0
- ✓ Approval state machine with auto-approve rules — v2.0
- ✓ GitHub App: webhook receiver, HMAC verification, slash commands, permission checks — v2.0
- ✓ Conversational clarification: agent asks question, pauses, resumes on reply — v2.0
- ✓ Check runs on PRs and auto-generated PR descriptions — v2.0
- ✓ Browser-use agent adapter with Python sidecar for web research workflows — v2.0

### Active

## Current Milestone: v2.1 Autonomous Factory

**Goal:** Enable forgectl to autonomously decompose complex issues into subtasks, delegate to child agents, and self-correct through conditional/loop pipeline nodes.

**Target features:**
- Multi-agent delegation (lead → worker, depth 2, per-issue maxChildren budget, failure retry with updated instructions)
- Conditional pipeline nodes (if/else branches, loop-until-condition, integrated with DAG executor)
- Pipeline self-correction (test fail → fix agent → retest, coverage drop → more tests, lint fail → reformat)

### Out of Scope

- Visual drag-and-drop workflow builder — deferred to v3, developer dashboard first
- Distributed multi-worker execution — single machine first, scale later
- Multi-tenant RBAC — single-user for now
- Linear/Jira tracker adapters — GitHub + Notion first, others after adapter interface is proven
- ~~Conditional/loop pipeline nodes~~ — promoted to v2.1
- Generic LLM adapter interface (OpenAI, Gemini APIs) — deferred from v1.0
- Notion App integration (database triggers, rich write-back) — deferred to v2.1
- Mirrored task model / tracker normalization — deferred to v2.1
- ~~Multi-agent delegation with org hierarchy~~ — promoted to v2.1 (depth-2, no org hierarchy)
- Dashboard v2 (power-user aggregate views) — deferred to v2.1+
- Slack/Discord bot — get GitHub + Notion right first
- Your own mobile app — GitHub and Notion apps are the UI
- Full CQRS / event replay for state — events are audit trail, not source of truth
- PostgreSQL support — SQLite sufficient for single-machine
- Per-tool budget granularity — budget per run and per agent/period is enough
- Temporal/BullMQ external dependencies — app-level checkpointing on SQLite

## Context

Shipped v2.0 with 14,700 LOC TypeScript (src) + 19,082 LOC tests. 1,021 tests passing across 91 test files. 19 phases, 46 plans executed across 2 milestones over 12 days.

Tech stack: TypeScript, Node.js 20+, Commander, Fastify, Dockerode, Zod, Vitest, tsup, Drizzle ORM, better-sqlite3, @octokit/app, @octokit/webhooks, @octokit/rest.

Key subsystems: CLI, config, container, agent (Claude Code + Codex + browser-use), orchestrator, tracker (GitHub + Notion), workspace, workflow, validation, output, pipeline, daemon, UI, storage (SQLite), flight recorder, governance, github-app.

v2.0 added 6 major subsystems: persistent storage, flight recorder, durable execution, governance/approvals, GitHub App, and browser-use integration. Four gap-closure phases (16-19) wired all subsystems into the execution lifecycle.

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

## Constraints

- **Tech stack**: TypeScript, Node.js 20+, existing dependencies (commander, fastify, dockerode, zod)
- **Agent model**: Must support one-shot CLI calls, persistent subprocess sessions, and HTTP sidecar
- **Tracker agnostic**: Generic adapter interface — no hardcoded assumptions in core
- **Backward compatible**: Existing `forgectl run` and `forgectl pipeline` commands must keep working
- **Single process**: No distributed queue yet — single daemon process with SQLite-backed state

---
*Last updated: 2026-03-12 after v2.1 milestone started*
