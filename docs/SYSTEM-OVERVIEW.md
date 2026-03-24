# forgectl — System Overview

*For brainstorming what to build next. Written for an AI agent to consume.*

---

## What forgectl Is

forgectl is a CLI + daemon that runs AI coding agents (Claude Code, Codex, browser-use) inside isolated Docker containers. Users bring their own AI API keys (BYOK). forgectl provides the sandbox, orchestration, validation, code review, and output collection.

Think of it as **"CI/CD for AI agents"** — you give it a task (or an issue tracker full of tasks), and it autonomously dispatches agents, validates their work, creates PRs, reviews them, and merges.

## Infrastructure

The system runs on a dedicated always-on server:
- **12 cores, 32GB RAM, 1TB SSD**
- Ubuntu Linux, Docker installed
- Runs 24/7 as an autonomous agent factory

## What It Does Today

### Core Loop (Single Task)
```
User gives task → forgectl builds Docker container → injects agent (Claude/Codex)
→ agent writes code → validation loop (tests, lint, typecheck) → retry on failure
→ collect output (git branch or files) → PR creation → done
```

### Autonomous Factory (Orchestrator)
```
Poll issue tracker (GitHub Issues, Linear, Notion) → scheduler picks candidates
→ triage gate (LLM-based: should we work on this?) → dispatch to Docker container
→ agent works → validation → PR creation → review daemon (LLM reviews diff)
→ self-address review comments → auto-merge → close issue → next issue
```

### Key Capabilities

| Capability | Description |
|-----------|-------------|
| **Multi-agent** | Claude Code, Codex, browser-use adapters. Single, review, or parallel orchestration modes. |
| **Docker sandbox** | Every task runs in an isolated container. Network modes: open, allowlist (iptables), airgapped. |
| **Validation loop** | Run any commands (tests, lint, typecheck), feed errors back to agent, retry up to N times. |
| **Knowledge Graph** | Merkle-tree-based KG of the codebase — files, imports, exports, test mappings, conventions. Budget-aware context assembly (token limits with compression tiers). |
| **Convention mining** | Auto-discovers coding patterns (naming, testing, error handling, exports) and injects them into agent prompts. |
| **Review daemon** | LLM reviews every PR diff. Posts MUST_FIX/SHOULD_FIX/NIT comments. Auto-addresses comments by dispatching fix agent. Escalates after 3 rounds. |
| **Merge daemon** | Polls for forge/* PRs, waits for CI, rebases, resolves conflicts, merges. Multi-repo support. |
| **Durable runtime** | SQLite persistence, crash recovery, checkpoint/resume, governance gates (approval workflows). |
| **Pipeline engine** | DAG-based task decomposition with conditional branching (filtrex), loop iteration, self-correction, multi-agent delegation. |
| **GitHub App** | Webhooks, slash commands (/forge), check runs, PR descriptions, conversational clarification. |
| **CI failure dispatch** | When CI fails on a forge/* branch, auto-dispatch agent with error logs to fix it. |
| **Post-merge test gen** | After PR merges, analyze changed files vs KG test mappings, create issues for coverage gaps. |
| **Triage gate** | Fast LLM evaluation before dispatch: duplicate detection, complexity estimation, should-we-work-on-this. |
| **Reproduce-first** | For bug issues, agent must reproduce the failure before fixing (expect_failure validation steps). |
| **Scheduled QA** | Cron-triggered codebase health checks — scan for coverage gaps, create issues automatically. |
| **Flight recorder** | Full audit trail — every agent invocation, validation result, PR action logged to SQLite. |
| **Cost tracking** | Token usage and estimated USD cost per run. |
| **Web dashboard** | React + Tailwind single-page dashboard served by daemon. Real-time SSE updates. |

## Architecture

```
~30K LOC TypeScript, Node.js 20+

src/
├── cli/              # Commander CLI handlers
├── workflow/          # Workflow profiles (code, research, content, data, ops)
├── config/            # Zod schema, YAML loader, 4-layer merge
├── auth/              # BYOK credential management (keychain + file fallback)
├── container/         # Docker sandbox (build, run, exec, network, workspace, secrets)
├── agent/             # Agent adapters (Claude Code, Codex, browser-use)
├── orchestration/     # Multi-agent modes (single, review, parallel)
├── orchestrator/      # Autonomous factory (scheduler, dispatcher, reconciler, triage, cron)
├── validation/        # Validation retry loop + reproduce-first
├── output/            # Output collection (git branch or files directory)
├── context/           # Context Engine v2 (KG-aware, budget-constrained prompt assembly)
├── kg/                # Knowledge Graph (Merkle tree, conventions, test-mapping, git-history)
├── task/              # Task specification (schema, loader, validator, scaffold)
├── planner/           # Planner agent (decomposition, validation)
├── analysis/          # Outcome analyzer (pattern detection, self-improvement)
├── logging/           # Structured logger, terminal UI, JSON run logs, SSE events
├── daemon/            # Fastify server, REST API, PID lifecycle, RunQueue
├── merge-daemon/      # PR processor (rebase, conflict resolution, review, merge)
├── github/            # GitHub App (webhooks, slash commands, check runs, comments)
├── tracker/           # Issue tracker adapters (GitHub Issues, Linear, Notion)
├── pipeline/          # DAG engine (parser, executor, checkpoint, conditions, coverage)
├── storage/           # SQLite + Drizzle ORM (runs, events, snapshots, delegations, costs)
├── flight-recorder/   # Event/snapshot audit trail
├── governance/        # Autonomy levels, approval state machine, auto-approve rules
├── ui/                # React dashboard (single HTML, CDN deps)
└── utils/             # Template expansion, slugs, timers, hashing
```

## What's Been Built (Timeline)

| Version | Milestone | Key Features |
|---------|-----------|-------------|
| v1.0 | Core Orchestrator | CLI, Docker sandbox, validation loop, agent adapters, output collection, basic orchestration |
| v2.0 | Durable Runtime | SQLite persistence, crash recovery, checkpoint/resume, governance gates, pipeline engine |
| v2.1 | Autonomous Factory | Scheduler, dispatcher, reconciler, multi-repo, delegation, two-tier slots |
| v3.0 | E2E GitHub Integration | GitHub App, webhooks, slash commands, check runs, PR descriptions, clarification |
| Current | Reactive Maintenance | CI dispatch, test gen, triage gate, reproduce-first, scheduled QA, review daemon hardening |

**Stats:** 120+ issues completed autonomously. 95+ PRs merged across 3 repos. 2100+ tests.

## Tech Stack

- **Language:** TypeScript (ESM, Node.js 20+)
- **Build:** tsup (bundler), vitest (tests), eslint + prettier
- **CLI:** commander
- **Config:** js-yaml + zod (runtime validation)
- **Docker:** dockerode (Docker Engine API)
- **HTTP:** Fastify + @fastify/cors
- **Database:** better-sqlite3 + Drizzle ORM
- **GitHub:** @octokit/app (GitHub App framework)
- **Globs:** picomatch
- **Credentials:** keytar (OS keychain) with file fallback
- **Expressions:** filtrex (safe eval for pipeline conditions)

## Current Gaps / Opportunities

1. **Not published to npm** — users must clone and build from source
2. **Docker images not on a registry** — users must build locally from Dockerfiles
3. **No Python/Go/Rust container images** — only Node.js and browser images exist
4. **No web UI for task submission** — dashboard is read-only, tasks submitted via CLI or API
5. **No multi-tenant support** — single-user daemon, no team features
6. **No cost budgets or rate limiting** — agents can run unlimited
7. **No notification system** — no Slack/email/webhook alerts when tasks complete or fail
8. **No artifact storage** — outputs are local files/branches, not uploaded anywhere
9. **Pipeline visualization is text-only** — no graphical DAG view in dashboard
10. **No marketplace for workflows** — custom workflows are local YAML files
11. **Agent Relay (npm dep) exists but not fully utilized** — could enable cross-container agent communication
12. **browser-use adapter exists but is experimental** — web research/scraping capability
13. **Board-based orchestration exists** — Kanban-style task management, underutilized
14. **No mobile/remote access** — daemon only listens on localhost

## How the Server is Used Today

The 12-core/32GB server runs the orchestrator daemon 24/7:
- Polls Linear for new issues
- Dispatches up to 2 concurrent Docker containers (each gets ~2 CPU, 4GB RAM)
- Each agent session runs Claude Code with full tool access inside the container
- Review daemon reviews and merges PRs automatically
- KG rebuilds incrementally on each scheduler tick
- SQLite database stores all run history, metrics, audit trail

The server has capacity for more — 12 cores can handle 4-6 concurrent agents, and 1TB SSD has plenty of room for KG databases, container images, and run artifacts.
