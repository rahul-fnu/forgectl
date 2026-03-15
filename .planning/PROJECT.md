# forgectl — AI Agent Orchestrator

## What This Is

forgectl is a CLI + daemon that orchestrates AI agents (Claude Code, Codex, browser-use) in isolated Docker containers. It continuously polls issue trackers, dispatches agents to sandboxed workspaces, validates results, and reports back — with zero human intervention after setup. A durable runtime with crash recovery, governance gates, GitHub App for phone-first control, sub-issue dependency ordering, skill mounting, and agent teams.

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
- ✓ GitHub sub-issue hierarchy parsed into DAG dependencies for dispatch ordering — v3.0
- ✓ Custom skill/config directories bind-mounted into agent containers — v3.0
- ✓ Agent teams enabled per workflow with memory scaling and slot weighting — v3.0
- ✓ Sub-issue progress rollup and synthesizer-gated auto-close — v3.0

### Active

## Current Milestone: v5.0 Intelligent Decomposition

**Goal:** Make forgectl handle complex, multi-file issues reliably by breaking them into focused sub-tasks, executing them in parallel on lightweight runtimes, and learning from outcomes over time.

**Target features:**
- LLM-driven task decomposition inside containers (agent analyzes issue, outputs DAG)
- Decomposition validation with human approval gate and single-agent fallback
- Lightweight worktree + process runtime (no Docker overhead for trusted sub-tasks)
- Parallel sub-task execution with branch-per-node merge and conflict detection
- Decomposition feedback loop (re-plan vs re-execute on failure)
- Rate limit detection with scheduled retry and workspace preservation
- Run outcome learning (persist lessons, dead-end tracking, feed into future prompts)

### Out of Scope

- Visual drag-and-drop workflow builder — developer dashboard first
- Distributed multi-worker execution — single machine first, scale later
- Multi-tenant RBAC — single-user for now
- Linear/Jira tracker adapters — GitHub + Notion first, others after adapter interface is proven
- Generic LLM adapter interface (OpenAI, Gemini APIs) — deferred from v1.0
- Notion App integration (database triggers, rich write-back) — deferred
- Slack/Discord bot — get GitHub + Notion right first
- Your own mobile app — GitHub and Notion apps are the UI
- Full CQRS / event replay for state — events are audit trail, not source of truth
- PostgreSQL support — SQLite sufficient for single-machine
- Per-tool budget granularity — budget per run and per agent/period is enough
- Temporal/BullMQ external dependencies — app-level checkpointing on SQLite
- Skills/team config in orchestrated (daemon) path via WORKFLOW.md — works in CLI, needs mapFrontMatterToConfig wiring for daemon

## Context

Shipped v3.0 with 16,662 LOC TypeScript (src) + 21,299 LOC tests. 1,162 tests passing across 101 test files. 30 phases, 57 plans executed across 3 milestones over 14 days. v5.0 focuses on intelligent decomposition — inspired by analysis of ComposioHQ/agent-orchestrator (LLM task decomposition, lightweight spawning) and greyhaven-ai/autocontext (run outcome learning, dead-end tracking).

Tech stack: TypeScript, Node.js 20+, Commander, Fastify, Dockerode, Zod, Vitest, tsup, Drizzle ORM, better-sqlite3, @octokit/app, @octokit/webhooks, @octokit/rest.

Key subsystems: CLI, config, container, agent (Claude Code + Codex + browser-use), orchestrator, tracker (GitHub + Notion), workspace, workflow, validation, output, pipeline, daemon, UI, storage (SQLite), flight recorder, governance, github-app, skills, sub-issue cache/DAG, rollup.

v3.0 added 3 features: GitHub sub-issue DAG dependencies, skill/config bind-mounting, and agent teams. Two gap-closure phases (29, 30) fixed composition wiring for sub-issue runtime features.

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
| Gap closure phases (16-19, 29-30) | Audit found wiring gaps between subsystems | ✓ Good — milestone audits catch integration bugs |
| Agent teams as prompt+env concern | Claude Code handles coordination internally | ✓ Good — forgectl just sets CLAUDE_NUM_TEAMMATES |
| GSD as mounted skill set | Bind-mount, not bake into image — user controls version | ✓ Good — credential exclusion prevents leaks |
| GitHub sub-issues as native deps | Leverage hierarchy rather than synthetic issues | ✓ Good — TTL cache + cycle detection handles edge cases |
| Standalone DFS for issue cycle detection | Pipeline validateDAG errors on unknown refs (valid in issues) | ✓ Good — clean separation of concerns |
| Optional injection for sub-issue deps | SubIssueCache/githubContext optional throughout | ✓ Good — Notion adapter unaffected |

## Constraints

- **Tech stack**: TypeScript, Node.js 20+, existing dependencies (commander, fastify, dockerode, zod)
- **Agent model**: Must support one-shot CLI calls, persistent subprocess sessions, and HTTP sidecar
- **Tracker agnostic**: Generic adapter interface — no hardcoded assumptions in core
- **Backward compatible**: Existing `forgectl run` and `forgectl pipeline` commands must keep working
- **Single process**: No distributed queue yet — single daemon process with SQLite-backed state

---
*Last updated: 2026-03-14 after v5.0 milestone started*
