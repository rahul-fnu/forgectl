# forgectl v3 — Final Consolidated Plan

*Synthesized from three independent analyses (Claude + two rounds of ChatGPT feedback)*

---

## Product Positioning

**Lead with this externally:**

> A self-hosted, sandboxed runtime for BYOK coding agents that turns issues into validated outputs with approvals, budgets, and durable execution.

**Internal design metaphor (not the pitch):**

Agents as employees in a company. Use this to guide schema design, multi-tenancy, and budget scoping — but don't lead marketing with "AI company" or "autonomous org chart."

**Why this positioning wins:**
- Your moat is sandbox + validation + workspace lifecycle + tracker sync — not org charts
- Paperclip already owns the "AI company" brand and has ~10k+ GitHub stars
- Composio's agent-orchestrator proves demand for repo-centric orchestration
- "Sandboxed durable runtime" is a lane no one fully owns yet

---

## The North Star Test

> Can one engineer trust this to run 20 real coding tasks a day without babysitting?

Every phase decision filters through this question. If a feature doesn't move this metric, defer it.

---

## Your Moat (Protect at All Costs)

These are the pieces that make forgectl differentiated. Do not regress on any of them:

1. **Docker sandbox isolation** — real container boundaries, not bare processes
2. **Universal validation loop** — run → check → feed errors → retry
3. **Tracker adapter abstraction** — GitHub Issues, Notion, extensible
4. **Workspace lifecycle** — per-issue workspaces with hooks and path safety
5. **WORKFLOW.md contract** — workflows are profiles, not pipelines
6. **Git/file output modes** — branch-with-commits or directory collection
7. **Agent-agnostic** — Claude Code, Codex, raw LLM APIs

---

## v3 Phase Order (Revised)

The key insight all three analyses converge on: build durability and governance before org charts. The company/agent data model should exist early as internal schema but surface late as a product feature.

### Phase 1: Persistent Storage Layer
**Priority: MUST BUILD — Foundation for everything**

- SQLite via Drizzle ORM + better-sqlite3
- Tables: `companies`, `agents`, `issues`, `runs`, `cost_events`, `audit_log`
- Migration infrastructure
- Include company/agent schema now (for multi-tenancy and budget scoping), but don't expose company management UI yet

**Study:** Paperclip's Drizzle schema and local DB ergonomics (they use embedded Postgres/PGlite — adapt the data model patterns, not necessarily the DB choice). OpenHands' state/event separation.

---

### Phase 2: Run Ledger + Cost Events + Audit Trail (the "Flight Recorder")
**Priority: MUST BUILD — This is what makes the system trustworthy**

Explicitly model as first-class persisted artifacts:
- Prompt inputs
- Tool calls and agent actions
- Validation outputs (pass/fail, error text)
- Diffs / commits produced
- Approval decisions
- Cost events (provider, model, tokens, cents)
- State snapshots at each step boundary

This becomes your replay/debug/explain layer. It matters more than dashboard polish.

**Study:** Temporal's event history and replay model. Trigger.dev's observability approach. LangGraph's checkpointer pattern.

---

### Phase 3: Persistent Sessions + Resume
**Priority: MUST BUILD — Core durability story**

- Sessions that survive daemon restarts and crashes
- Idempotent step boundaries (don't re-run completed steps)
- Pause/resume semantics
- State recovery from the audit trail (Phase 2)
- Timer-based autonomous scheduling (heartbeat wakeups)

**Study:** Temporal for durable workflow execution and exact resumption. Trigger.dev for long-running tasks with retries and queues. OpenSandbox for pause/resume sandbox semantics.

---

### Phase 4: Approvals + Governance Gates
**Priority: MUST BUILD — Required for production trust**

- Approval workflows for high-stakes actions
- Configurable thresholds (auto-approve under $X or under N files changed)
- Config revision tracking with rollback
- Human-in-the-loop interrupts that don't break the state machine

**Study:** Paperclip's approval gates and config rollback. LangGraph's human-in-the-loop patterns.

---

### Phase 5: Budget Enforcement
**Priority: MUST BUILD — Follows naturally from Phase 2 cost events**

- Agent-level and company-level budgets
- Pre-flight enforcement (refuse dispatch if budget would be exceeded)
- Warnings at configurable thresholds (e.g., 80%)
- Auto-pause on exhaustion
- Monthly/period resets
- Cost dashboard (simple, not fancy)

**Study:** Paperclip's budget auto-pause model.

---

### Phase 6: Execution Locks + Idempotency
**Priority: SHOULD BUILD — Prevents concurrent corruption**

- Atomic execution locks per issue/workspace
- Wakeup coalescing (don't double-dispatch)
- External tracker sync hardening (GitHub/Notion issues mirror into internal state)
- Priority dispatch refinement

**Study:** Composio's agent-orchestrator for task/runtime locking patterns.

---

### Phase 7: Company & Agent Model (User-Facing)
**Priority: DEFER — The schema exists from Phase 1, now surface it**

- Multi-tenant company isolation (data model already exists)
- Agent-as-employee with role, title, status, reportsTo
- Delegation logic — managers create sub-tasks for reports
- Permission system
- Company management CLI/API

**Note:** The data model for this was built in Phase 1. This phase is about surfacing it as a user-facing feature with CLI commands, API endpoints, and documentation. Don't build a full internal issue tracker — syncing GitHub/Notion is enough.

---

### Phase 8: Dashboard v2
**Priority: DEFER — Build incrementally, don't front-load**

Start simple, add pieces as the engine stabilizes:

1. First: cost dashboard + run history + audit trail viewer (these have the most value)
2. Then: approval queue + active session monitor
3. Later: org chart visualization + Kanban board
4. Much later: WebSocket upgrade (SSE is fine for now)

**Study:** sandboxed.sh's "Mission Control" UI for monitoring patterns.

---

### Phase 9: E2E Integration & Demo
**Priority: LAST — Prove the full loop**

Full autonomous loop: GitHub issue → dispatch agent → workspace setup → validation loop → output collection → cost tracking → approval gate → write-back → auto-close.

---

## What NOT to Build

| Don't Build | Why |
|---|---|
| Full internal issue tracker | Syncing GitHub/Notion is enough. Building your own pulls you into project-management software territory and will eat months. |
| General-purpose agent framework | CrewAI, LangGraph, AutoGen have massive communities. Your value is the opinionated combination, not agent primitives. |
| Deep multi-agent hierarchy UI | "CEO → manager → IC" looks cool in demos but isn't the shortest path to value. Most users need: one coding agent, one reviewer, maybe one validator. Build the data model for hierarchy, don't push it on users. |
| Many agent runtime adapters | Claude Code + Codex covers the important cases. Don't add Aider, OpenCode, Cursor etc. until the core is solid. Each new runtime is maintenance overhead. |
| Distributed execution | Single machine first. The K8s agent sandbox space is crowded (Google SIG Apps, cloud providers). Don't compete there until single-machine is battle-tested. |
| Large WORKFLOW.md DSL | Keep it opinionated and small. The minute it becomes a giant DSL, you've recreated a worse CI system. |
| Dashboard before engine | If the system can't reliably pause, resume, approve, retry, reconcile, and explain itself, a Kanban board just hides the problem. |

---

## Architecture Decisions

### Make sandboxes pluggable
Local Docker stays the default, but leave room in the abstraction for:
- Local Docker (current, default)
- Remote Docker host
- Daytona/E2B-style remote sandboxes
- OpenSandbox (Alibaba, Apache-2.0) as potential future backend
- Firecracker/microVM later

This gives optionality without forcing infra expansion now.

### Security from day one
As you add persistent sessions and remote control surfaces, the attack surface grows. Build threat modeling into each phase:
- Phase 3 (persistent sessions): authentication, session token management
- Phase 4 (approvals): authorization model, privilege escalation prevention
- Phase 7 (company model): multi-tenant isolation, data boundary enforcement
- Don't bolt security on after the fact

### Event-sourced audit trail
The Phase 2 flight recorder should be append-only and immutable. This becomes your debugging, compliance, and replay foundation. Design it as event-sourcing from the start, not as logging bolted on.

---

## Reference Projects — Ranked by Relevance

### Tier 1: Directly borrow architecture from

| Project | License | What to take |
|---|---|---|
| **Composio agent-orchestrator** | — | Plugin slot architecture, runtime/tracker/agent abstraction, repo-centric task model |
| **OpenHands** | MIT (core) | Agent/Controller/State/EventStream separation, Docker runtime design, image/runtime plugin conventions |
| **Paperclip** | MIT | Company/agent/budget schema design, goal ancestry, approval gates with rollback, heartbeat scheduling |

### Tier 2: Study for execution model

| Project | License | What to take |
|---|---|---|
| **Temporal** | MIT | Durable workflow execution, replay, signals, approval interrupts, timers |
| **Trigger.dev** | Apache-2.0 | TypeScript-first long-running tasks, retries, queues, observability, child task spawning |
| **LangGraph** | MIT | Persistence/checkpointer model, human-in-the-loop state recovery, durable execution patterns |
| **Dagger** | Apache-2.0 | Code-first container workflows, caching, composable modules, strong CLI ergonomics |

### Tier 3: Study for sandbox infrastructure

| Project | License | What to take |
|---|---|---|
| **OpenSandbox** (Alibaba) | Apache-2.0 | Sandbox API shape, lifecycle management, exec/file APIs, pause/resume |
| **sandboxed.sh** | — | Workspace isolation (systemd-nspawn), Mission Control monitoring UI |
| **Docker cagent** | — | YAML-driven agent config (compare against your WORKFLOW.md approach) |
| **E2B** | Apache-2.0 | Provider abstraction for local vs cloud sandboxes, snapshot/log/storage separation |

### Tier 3: Useful patterns, weaker direct fit

| Project | What to take |
|---|---|
| **CrewAI** (MIT) | Multi-agent abstractions if you need them later |
| **Mastra** (Apache-2.0 core) | TypeScript DX patterns |
| **n8n** (Sustainable Use License) | Workflow UX inspiration only |

---

## Key Strategic Risks

1. **Timing vs Paperclip.** Paperclip is getting mindshare now with an inferior execution model. Ship Phases 1-5 fast and write a clear comparison doc showing your Docker isolation and validation advantages. Don't position as "better Paperclip" — position as the production-grade option for teams that need agents to do real repo work safely.

2. **Three products in a trench coat.** The biggest architectural risk is that v3 becomes (a) a durable execution platform, (b) an AI company simulator, and (c) an internal ticketing system. Only (a) is broadly valuable. (b) is a useful internal abstraction. (c) should be deferred or killed.

3. **Surface area creep.** Each new agent runtime, tracker adapter, and dashboard feature is maintenance overhead. Keep the surface area minimal until the core loop (issue → sandbox → validate → output → approve) is rock solid.

4. **Security as afterthought.** Persistent sessions + remote access + multi-tenancy = large attack surface. Budget time for threat modeling in every phase.

---

## Summary: The Shortest Path to Value

```
Phase 1: Storage layer (foundation)
Phase 2: Flight recorder / audit trail (trustworthiness)  
Phase 3: Persistent sessions / resume (durability)
Phase 4: Approvals / governance (production readiness)
Phase 5: Budget enforcement (cost control)
Phase 6: Execution locks (correctness)
Phase 7: Company model UI (organizational layer)
Phase 8: Dashboard v2 (incremental polish)
Phase 9: E2E demo (prove the loop)
```

Phases 1-5 get you to "production-worthy sandboxed agent runtime."
Phases 6-7 get you to "multi-tenant agent platform."
Phases 8-9 are polish and proof.

All three analyses agree: the first five phases are your product. Everything after is expansion.
