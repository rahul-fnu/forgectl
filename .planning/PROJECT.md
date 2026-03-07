# forgectl v2 — AI Agent Orchestrator

## What This Is

forgectl is a CLI + daemon that orchestrates AI agents (Claude Code, Codex, raw LLM APIs) in isolated Docker containers. v2 evolves it from a task runner into a continuous autonomous orchestrator — a Symphony-style daemon that polls issue trackers, dispatches agents to isolated workspaces, validates results, and reports back. Think n8n but AI-native, code-first, and autonomous.

## Core Value

Continuously pull work from issue trackers, dispatch AI agents to execute it in sandboxed environments, validate results, and report back — with zero human intervention after setup.

## Requirements

### Validated

- CLI single-agent execution (Claude Code + Codex) — existing
- Docker container isolation with network modes — existing
- Validation loops with retry (run command → check → feed errors → retry) — existing
- Multi-agent review mode — existing
- DAG pipeline orchestration with checkpoints, fan-in, reruns — existing
- Daemon with REST API and SSE event streaming — existing
- Web dashboard (basic) — existing
- YAML configuration with zod validation — existing
- Output collection (git branches + files) — existing
- BYOK credential management — existing

### Active

- [ ] Pluggable issue tracker adapter (generic interface + GitHub Issues implementation)
- [ ] Orchestration state machine (claim/running/retry/released with reconciliation)
- [ ] Polling loop with candidate selection, concurrency control, dispatch priority
- [ ] In-repo WORKFLOW.md contract (repo-owned agent policy with YAML front matter + prompt template)
- [ ] Workspace persistence and lifecycle management (per-issue, reusable across runs)
- [ ] Workspace lifecycle hooks (after_create, before_run, after_run, before_remove)
- [ ] Hybrid agent session model (CLI calls for simple tasks + persistent subprocess sessions for multi-turn)
- [ ] Dynamic config reload (hot-reload WORKFLOW.md without restart)
- [ ] Exponential backoff retry queue with configurable caps
- [ ] Stall detection (kill agents with no activity past threshold)
- [ ] Active run reconciliation (stop agents when issue state changes to terminal/inactive)
- [ ] Startup terminal workspace cleanup
- [ ] Generic LLM adapter interface (OpenAI, Anthropic, Gemini APIs for non-coding tasks)
- [ ] Structured logging with issue/session context fields
- [ ] Cost tracking basics (token counts, runtime seconds per issue)
- [ ] End-to-end demo: GitHub issue → dispatch agent → validate → report back

### Out of Scope

- Visual drag-and-drop workflow builder — deferred to v3, developer dashboard first
- Distributed multi-worker execution — single machine first, scale later
- Multi-tenant RBAC — single-user for now
- Linear/Jira tracker adapters — GitHub first, others after adapter interface is proven
- Conditional/loop pipeline nodes — after core orchestrator is solid
- Persistent database (Postgres) for run history — file-based first, DB later
- Manual approval gates in pipelines — future milestone

## Context

forgectl v1 is a mature TypeScript project with 73 source files, 211+ passing tests, and full pipeline support. The codebase is well-structured with clear separation: CLI, config, container, agent, orchestration, validation, output, pipeline, daemon, and UI layers.

Key technical foundations already in place:
- Dockerode for container management
- Fastify daemon on port 4856 with SSE
- Commander CLI framework
- Zod config validation
- Agent adapters (Claude Code + Codex) with credential management
- Pipeline DAG executor with checkpoint/rerun

The v2 orchestrator builds on the existing daemon, adding the Symphony-style polling loop, state machine, and tracker integration on top of the current execution infrastructure.

Inspiration: OpenAI Symphony SPEC.md — a language-agnostic spec for a long-running automation service that polls issue trackers and dispatches coding agents. We borrow the architectural patterns (state machine, reconciliation, workspace management, WORKFLOW.md contract) while keeping forgectl's strengths (Docker isolation, multi-agent support, validation loops, pluggable adapters).

## Constraints

- **Tech stack**: TypeScript, Node.js 20+, existing dependencies (commander, fastify, dockerode, zod)
- **Agent model**: Must support both one-shot CLI calls and persistent subprocess sessions
- **Tracker agnostic**: Generic adapter interface — no hardcoded Linear/GitHub assumptions in core
- **Backward compatible**: Existing `forgectl run` and `forgectl pipeline` commands must keep working
- **Single process**: No distributed queue yet — single daemon process with in-memory state
- **Demo target**: Working end-to-end with GitHub Issues as the first tracker

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GitHub Issues as first tracker | Most accessible, everyone has GitHub, easy to demo | — Pending |
| Hybrid agent sessions (CLI + persistent) | Flexibility — simple tasks use CLI, complex use persistent sessions | — Pending |
| Symphony patterns adapted, not copied | Symphony is Codex-specific; forgectl is agent-agnostic | — Pending |
| Single machine first | Reduce complexity, prove the model before scaling | — Pending |
| In-repo WORKFLOW.md contract | Teams version-control their agent policy alongside code | — Pending |
| File-based state (no DB yet) | Matches Symphony's in-memory design, add persistence later | — Pending |

---
*Last updated: 2026-03-07 after initialization*
