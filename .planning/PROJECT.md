# forgectl — AI Agent Orchestrator

## What This Is

forgectl is a CLI + daemon that orchestrates AI agents (Claude Code, Codex) in isolated Docker containers. It continuously polls issue trackers, dispatches agents to sandboxed workspaces, validates results, and reports back — with zero human intervention after setup. Supports single-agent runs, multi-agent review mode, DAG pipelines, and autonomous orchestration from GitHub Issues and Notion.

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

### Active

(No active requirements — next milestone not yet defined)

### Out of Scope

- Visual drag-and-drop workflow builder — deferred to v3, developer dashboard first
- Distributed multi-worker execution — single machine first, scale later
- Multi-tenant RBAC — single-user for now
- Linear/Jira tracker adapters — GitHub + Notion first, others after adapter interface is proven
- Conditional/loop pipeline nodes — after core orchestrator is solid
- Persistent database (Postgres) for run history — file-based first, DB later
- Manual approval gates in pipelines — future milestone
- Generic LLM adapter interface (OpenAI, Gemini APIs) — deferred from v1.0

## Context

Shipped v1.0 with 11,413 LOC TypeScript (src) + 12,848 LOC tests. 667 tests passing across 56 test files. 9 phases, 24 plans executed in 8 days.

Tech stack: TypeScript, Node.js 20+, Commander, Fastify, Dockerode, Zod, Vitest, tsup.

Key subsystems: CLI, config, container, agent (Claude Code + Codex), orchestrator, tracker (GitHub + Notion), workspace, workflow, validation, output, pipeline, daemon, UI.

The v1 foundation covers the full orchestration loop. Areas for future work: real-world stress testing, additional tracker adapters, persistent state storage, and production hardening.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GitHub Issues as first tracker | Most accessible, everyone has GitHub | Good |
| Hybrid agent sessions (CLI + persistent) | Simple tasks use CLI, complex use persistent | Good |
| Symphony patterns adapted, not copied | Symphony is Codex-specific; forgectl is agent-agnostic | Good |
| Single machine first | Reduce complexity, prove the model before scaling | Good |
| In-repo WORKFLOW.md contract | Teams version-control their agent policy alongside code | Good |
| File-based state (no DB yet) | Matches Symphony's in-memory design, add persistence later | Good |
| Notion as second adapter | Validates adapter interface is truly pluggable | Good |
| Factory registry for stateful adapters | Adapters hold private state (ETag, cache, rate limits) | Good |
| TrackerIssue.id = API-addressable identifier | Issue number for GitHub, page UUID for Notion | Good (Phase 9 fix) |
| Polling-first (no webhooks yet) | Simpler, works everywhere, webhooks as future enhancement | Good |

## Constraints

- **Tech stack**: TypeScript, Node.js 20+, existing dependencies (commander, fastify, dockerode, zod)
- **Agent model**: Must support both one-shot CLI calls and persistent subprocess sessions
- **Tracker agnostic**: Generic adapter interface — no hardcoded assumptions in core
- **Backward compatible**: Existing `forgectl run` and `forgectl pipeline` commands must keep working
- **Single process**: No distributed queue yet — single daemon process with in-memory state

---
*Last updated: 2026-03-09 after v1.0 milestone*
