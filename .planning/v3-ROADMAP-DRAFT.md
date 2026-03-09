# Roadmap: forgectl v3 — Durable Sandboxed Agent Runtime

## Milestone Goal

Evolve forgectl from a task orchestrator into a **trusted, durable runtime for coding agents** that you control from your phone through GitHub and Notion. The forgectl GitHub App lives in your repos like Dependabot — you converse with it in issue comments, approve with reactions, re-run with slash commands, and come back to validated PRs. The Notion integration does the same for non-code workflows: research, content, ops tasks.

Every run is auditable, resumable, and budget-controlled. Autonomy is configurable per workflow — from fully autonomous to interactive back-and-forth.

## Product Positioning

**Lead with this:**

> forgectl is a GitHub App and Notion integration that runs sandboxed coding agents against your issues. Comment to ask questions, react to approve, slash-command to re-run — and come back to a validated PR.

**Secondary positioning (for infra-minded audiences):**

> A self-hosted, sandboxed runtime for BYOK coding agents that turns issues into validated outputs with approvals, budgets, and durable execution.

**Internal design metaphor (not the pitch):**

Agents as employees in a company. Use this to guide schema design, multi-tenancy, and budget scoping — but don't lead marketing with "AI company" or "autonomous org chart."

## The North Star Test

> Can one engineer label a GitHub issue from their phone, have a short back-and-forth with the agent in comments, and come back to a validated PR — 20 times a day, without anything breaking?

Every phase decision filters through this question. If a feature doesn't move this metric, defer it.

## The Demo That Writes Itself

Screen record your iPhone. Create a GitHub issue: "add dark mode to the settings page." Label it `forgectl`. The bot comments: "I'll add a dark mode toggle to SettingsPage. Should I use the existing theme context or create a new one?" You reply: "use existing theme context." The bot runs. 8 minutes later there's a PR with validated code, a cost summary, and a comment explaining what changed. You review the diff, tap "Approve" on the PR, done.

Second demo: open Notion on your phone. Tag a research task "forgectl." The agent picks it up, does the research, writes back structured findings into the Notion page properties and a linked "Runs" entry with cost and sources.

## Core Moat (Protect at All Costs)

1. **Docker sandbox isolation** — real container boundaries, not bare processes
2. **Universal validation loop** — run → check → feed errors → retry
3. **Tracker adapter abstraction** — GitHub Issues, Notion, extensible
4. **Workspace lifecycle** — per-issue workspaces with hooks and path safety
5. **WORKFLOW.md contract** — workflows are profiles, not pipelines
6. **Git/file output modes** — branch-with-commits or directory collection
7. **Agent-agnostic** — Claude Code, Codex, raw LLM APIs

---

## Phase 1: Persistent Storage Layer
**Goal:** Replace file-based state with SQLite for structured data, migrations, and queries.

**Priority: MUST BUILD — Foundation for everything**

**Why first:** Everything else (identity, costs, approvals, audit trail) needs reliable persistent storage. SQLite is zero-config, embeddable, and sufficient for single-machine v3.

**Deliverables:**
- `src/storage/` — Database layer with Drizzle ORM + better-sqlite3
- Schema: `companies`, `agents`, `runs`, `sessions`, `cost_events`, `approvals`, `artifacts`, `state_snapshots`, `conversations` tables
- Migrations infrastructure (Drizzle Kit)
- Repository pattern: typed query/mutation functions per entity
- Backward compat: existing file-based run logs still work alongside

**Study:** Paperclip's Drizzle schema (adapted to SQLite). OpenHands' state/event separation.

**Depends on:** v2 complete

---

## Phase 2: Company & Agent Identity (Internal Architecture)
**Goal:** Internal schema for multi-tenancy, agent identity, roles, and budget scoping.

**Priority: MUST BUILD — Everything needs agent/company identity for attribution**

This is **internal architecture**, not the main marketed feature. The schema exists so that budget scoping, audit attribution, and future delegation have clean identity primitives from day one.

**Deliverables:**
- `src/company/` — Company CRUD, tenant isolation, config per company
- `src/agent/identity.ts` — Agent entity with role, title, status, `reportsTo`, budget scope, permissions
- Agent lifecycle: `pending_approval → idle → running → paused → waiting_for_input → terminated`
- Basic permission model: `canCreateAgents`, `canAssignWork`, `canApproveHires`
- CLI: `forgectl company create/list`, `forgectl agent create/list/status`

**Depends on:** Phase 1

---

## Phase 3: Flight Recorder / Run Ledger
**Goal:** Make every run replayable and inspectable — and make the results readable from GitHub/Notion without opening a dashboard.

**Priority: MUST BUILD — The difference between "demo-ready" and "trustworthy"**

**Deliverables:**
- `src/audit/` — Append-only event ledger (design as event-sourcing from the start)
- Persist per run: prompt inputs, model/runtime used, tool calls, container lifecycle events, validation outputs (pass/fail + error text), diffs/commits produced, retries, approval decisions, cost events, clarification exchanges, final result
- State snapshots at each step boundary
- **Rich write-back formatting** — structured GitHub issue comments and Notion task updates that include: summary of changes, files modified, validation results, cost breakdown, link to PR/branch
- Query API: retrieve full run history, filter by agent/issue/time
- CLI: `forgectl run inspect <run-id>` — show full audit trail

**Design principle:** The audit trail is append-only and immutable. GitHub and Notion are your dashboard — the write-back is your UI.

**Study:** Temporal's event history. Trigger.dev's observability. LangGraph's checkpointer.

**Depends on:** Phase 1, Phase 2

---

## Phase 4: Durable Execution (Persistent Sessions + Resume)
**Goal:** Runs survive daemon restarts and crashes. Sessions persist across heartbeat cycles.

**Priority: MUST BUILD — Core durability story**

**Deliverables:**
- `src/agent/task-session.ts` — Persistent session storage per agent/task/adapter
- Checkpointing: save state at step boundaries, resume from last checkpoint
- Idempotent step boundaries (don't re-run completed steps)
- Reconciliation on daemon restart (detect interrupted runs, resume or mark failed)
- Session resume: agent picks up where it left off across heartbeat cycles
- Heartbeat scheduler: configurable per-agent timer (interval, enabled, max concurrent)
- Execution locks: atomic claim per issue/workspace (SQLite `BEGIN IMMEDIATE`)
- Wakeup coalescing: deduplicate concurrent wakes to same agent/issue
- State recovery from audit trail (Phase 3)
- **Pause/resume for clarification:** agent can enter `waiting_for_input` state, persist context, and resume when human responds
- Invocation sources: `timer`, `assignment`, `on_demand`, `automation`, `webhook`, `slash_command`

**Study:** Temporal for durable execution. Trigger.dev for long-running tasks. OpenSandbox for pause/resume.

**Depends on:** Phase 1, Phase 2, Phase 3

---

## Phase 5: Governance, Approvals & Budget Enforcement
**Goal:** Production-safety controls so you can leave forgectl running overnight without worry.

**Priority: MUST BUILD — Required for "trigger and forget" trust**

**Deliverables:**
- `src/governance/` — Approval system with configurable gates
- **Auto-approve rules:** approve automatically when estimated cost < $X, files changed < N, issue has specific label, or matches workflow pattern
- **Configurable autonomy per workflow** in WORKFLOW.md:
  ```yaml
  autonomy: full          # never ask, just do it
  autonomy: semi          # ask before expensive/destructive actions
  autonomy: interactive   # always ask for confirmation before executing
  autonomy: supervised    # plan first, wait for approval, then execute
  ```
- Approval types: `hire_agent`, `expensive_run`, `deploy`, `plan_review`, custom
- Approval flow: `pending → approved/rejected/revision_requested` (enforced state machine)
- Human-in-the-loop interrupts that don't break the state machine
- `src/costs/` — CostEvent recording (provider, model, tokens, cents, agent, issue, project)
- Agent-level and company-level budgets with pre-flight enforcement
- Auto-pause on budget exhaustion, monthly/period resets
- Config revision tracking: versioned before/after snapshots with rollback
- CLI: `forgectl approval list/approve/reject`, `forgectl costs summary/by-agent`

**Study:** Paperclip's approval gates and budget auto-pause. LangGraph's human-in-the-loop.

**Depends on:** Phase 2, Phase 3

---

## Phase 6: GitHub App
**Goal:** A proper GitHub App that makes forgectl a first-class citizen in your repos — like Dependabot or Copilot, but for autonomous coding tasks.

**Priority: MUST BUILD — This is the product's primary interaction surface**

This is the single most important phase for the mobile-trigger story. Everything before this phase builds the engine. This phase builds the interface people actually touch from their phone.

### 6a: Core Bot (weeks 1-2)

**Deliverables:**
- `src/github-app/` — GitHub App with webhook receiver and bot account
- **App registration:** installable via GitHub Marketplace or self-hosted (private app)
- **Webhook events:** `issues.labeled`, `issues.opened`, `issue_comment.created`, `pull_request_review`, `check_run`
- **Trigger rules:** configurable which labels/events start a run (e.g., label `forgectl`, label `auto-fix`)
- **Bot comments:** structured markdown comments on issues/PRs with run status, results, cost summary
- **Bot identity:** posts as `forgectl[bot]` with app avatar
- Deduplication: don't dispatch twice for the same event
- Signature verification on all incoming webhooks (HMAC-SHA256)

### 6b: Slash Commands (weeks 2-3)

**Deliverables:**
- Parse slash commands from issue/PR comments:
  - `/forgectl run` — trigger a run on this issue
  - `/forgectl rerun` — re-run the last failed attempt
  - `/forgectl status` — show current run status, cost so far
  - `/forgectl stop` — cancel the active run
  - `/forgectl approve` — approve a pending action
  - `/forgectl reject [reason]` — reject with feedback
  - `/forgectl config set autonomy=semi` — change workflow config for this issue
  - `/forgectl decompose` — ask the agent to break this issue into sub-issues
  - `/forgectl help` — list available commands
- Command parsing with error handling (unknown commands get a helpful response)
- Permission checks: only repo collaborators can issue commands

### 6c: Conversational Clarification (weeks 3-4)

**Deliverables:**
- **Mid-run questions:** agent pauses execution, comments on the issue asking a clarification question, enters `waiting_for_input` state
- **Human replies:** user replies in a normal comment, bot detects it's a response to its question, resumes the run with the answer injected into context
- **Timeout:** configurable timeout for clarification (default: 24h), after which the run is marked `stalled` and the bot comments that it's still waiting
- **Conversation threading:** maintain conversation history per issue in the audit trail, so the agent has full context of prior exchanges
- **Smart prompting:** agent's clarification questions include options when possible ("Should I use approach A or B?") to make phone replies quick

### 6d: Reactions as Approvals (week 4)

**Deliverables:**
- 👍 reaction on a bot comment = approve the pending action
- 👎 reaction = reject (bot asks for reason in a follow-up comment)
- 🚀 reaction on an issue = trigger a run (alternative to labeling)
- 🔄 reaction on a bot "run failed" comment = re-run
- Reaction handling is idempotent (multiple thumbs-up don't trigger multiple approvals)

### 6e: Check Runs + PR Integration (week 5)

**Deliverables:**
- **Check runs:** forgectl posts check run status on PRs it creates (pending → in_progress → success/failure)
- **PR descriptions:** auto-generated PR body with: what was changed, why (linked to original issue), validation results, cost summary, files modified
- **PR reviews:** if review workflow is configured, the reviewer agent posts a PR review (approve/request changes) as the bot account
- **Issue auto-close:** when PR is merged, the originating issue is auto-closed with a summary comment

### Architecture Notes

- The GitHub App webhook receiver runs inside the existing Fastify daemon (new route group: `/webhooks/github`)
- All webhook payloads are verified via HMAC-SHA256 before processing
- Webhook events are enqueued into the existing RunQueue, not processed synchronously
- The bot's comment formatting is templated and customizable per workflow
- Self-hosted users who can't receive webhooks fall back to polling (existing v2 behavior)
- The app needs these GitHub permissions: `issues: write`, `pull_requests: write`, `checks: write`, `contents: write`, `metadata: read`

**Study:** Dependabot's interaction model. GitHub's Probot framework. Linear's GitHub integration for bidirectional sync patterns.

**Depends on:** Phase 4, Phase 5

---

## Phase 7: Notion Integration
**Goal:** Notion as a first-class trigger and result surface for non-code workflows (research, content, ops).

**Priority: SHOULD BUILD — Extends the product beyond code-only workflows**

### 7a: Core Integration (weeks 1-2)

**Deliverables:**
- `src/notion-app/` — Notion integration via Notion API
- **Database trigger:** watch a configured Notion database for tasks tagged with a trigger property (e.g., status → "Ready for Agent" or a "forgectl" checkbox)
- **Faster polling:** configurable poll interval per database (default: 30s, min: 10s)
- **Result write-back:** update task properties with run results:
  - Status property → "In Progress" → "Done" / "Failed"
  - "Cost" number property → total cents
  - "Agent" text property → which agent handled it
  - "Run ID" text property → for audit trail lookup
- **Linked Runs database:** a separate "Runs" database that relates to the tasks database, with one entry per run attempt containing: status, cost, duration, validation result, output summary, error details

### 7b: Rich Content Write-Back (weeks 2-3)

**Deliverables:**
- **Page content updates:** for research/content workflows, the agent writes structured results directly into the Notion page body (headings, bullets, callouts, tables)
- **File attachments:** upload generated files (reports, docs, data) as Notion file blocks
- **Sub-task creation:** agent can create child pages or linked tasks in the same database for decomposed work
- **Comment thread:** agent posts updates as Notion comments on the page for progress tracking

### 7c: Notion Commands (week 3)

**Deliverables:**
- **Property-based commands:** change a Notion select property to trigger actions:
  - "Rerun" → re-triggers the last failed run
  - "Stop" → cancels active run
  - "Approve" / "Reject" → governance response
- **Comment-based commands:** reply to the agent's Notion comment with instructions (mirrors GitHub slash command model but more natural)
- **Config overrides:** a "Config" text property on the task can override workflow settings (autonomy level, budget cap, specific agent)

### Architecture Notes

- Notion API has rate limits (3 requests/second). Batch reads, debounce writes.
- Notion doesn't support webhooks natively — polling is the only option. Consider Notion's "webhook" beta if available, otherwise optimize polling with `last_edited_time` filters.
- The Notion integration runs as a separate polling loop inside the daemon, alongside the existing tracker adapter polling.
- Notion page content write-back uses the Notion blocks API, which requires careful handling of block limits and nested structure.

**Study:** Notion API docs. Notion's database automations. Linear's Notion integration for sync patterns.

**Depends on:** Phase 4, Phase 5

---

## Phase 8: Mirrored Task Model / Tracker Normalization
**Goal:** Normalize external issues from both GitHub and Notion into a unified internal task model.

**Priority: SHOULD BUILD — Required once you have two trigger sources**

With both GitHub App and Notion integration, you need a unified internal task model so the engine doesn't care where the task came from.

**Deliverables:**
- `src/task/` — Internal task model (mirrored from GitHub/Notion via tracker adapters)
- One-way sync: external issues create/update internal tasks
- Parent/child task hierarchy for decomposition (maps to GitHub sub-issues and Notion child pages)
- Internal execution metadata (assigned agent, lock status, attempt count, last result, conversation history)
- Status write-back to external trackers (bidirectional status sync)
- Priority dispatch: priority → age → identifier sorting
- Cross-tracker linking: a GitHub issue can reference a Notion task and vice versa (metadata only, not full sync)

**Depends on:** Phase 1, Phase 6, Phase 7

---

## Phase 9: Multi-Agent Delegation
**Goal:** Manager agents create subtasks, implementers execute, reviewers validate — with explicit handoff states.

**Priority: DEFER — Only after runtime is durable and trustworthy**

**Deliverables:**
- Org chart: `reportsTo` hierarchy drives actual work assignment (not cosmetic)
- Manager agents can create sub-tasks and assign to reports
- Work bubbles up through reporting chain for review
- Explicit handoff states between agents
- Bounded delegation rules (max depth, max fan-out)
- `/forgectl decompose` creates sub-issues via the GitHub App and assigns to appropriate agents
- CLI: `forgectl agent org-chart`, `forgectl agent delegate`

**Design note:** Most users will start with one implementer + one reviewer. The system supports richer hierarchy without requiring it.

**Depends on:** Phase 2, Phase 4, Phase 5

---

## Phase 10: Dashboard v2
**Goal:** Web dashboard for power users who need aggregate views beyond what GitHub/Notion show.

**Priority: DEFER — GitHub App + Notion are the primary UI. Dashboard is secondary.**

Build in order of value:
1. **First:** Run explorer + audit trail viewer + cost dashboard
2. **Then:** Approval queue + active session monitor
3. **Later:** Agent detail pages + task board (Kanban)
4. **Much later:** Org chart visualization + company switcher + WebSocket upgrade

**Depends on:** Phases 3-5 (incrementally)

---

## Phase 11: E2E Integration & Demo
**Goal:** Prove the full autonomous loop end-to-end — and record the demos.

**Deliverables:**
- **GitHub demo:** screen recording of iPhone GitHub app → create issue → label it → bot asks clarifying question → reply → PR appears with enriched comment → approve with reaction → merged
- **Notion demo:** tag a research task in Notion mobile → agent picks it up → page updated with structured findings → linked Runs entry shows cost/status
- **Slash command demo:** `/forgectl decompose` on a complex issue → bot creates 3 sub-issues → agents work them in parallel → results merge back
- Full flow: external trigger → dispatch → workspace → validation loop → output → cost tracking → approval → write-back → auto-close
- Backward compat verification: `forgectl run`, `forgectl pipeline`, `forgectl orchestrate` all still work
- Example WORKFLOW.md configs showing all four autonomy levels
- E2E tests with mock GitHub/Notion APIs

**Depends on:** All previous phases

---

## WORKFLOW.md Autonomy Extension

The WORKFLOW.md contract gains a new `autonomy` field that controls how far the agent goes before asking:

```yaml
---
name: bugfix
agent: claude-code
autonomy: semi
budget_cap: 5.00
triggers:
  github_labels: [bug, forgectl]
  notion_status: "Ready for Agent"
validation:
  command: npm test
  retry: 3
---

## Prompt

Fix the bug described in the issue. Run the test suite to verify.
If more than 5 files need changes, ask for confirmation before proceeding.
```

**Autonomy levels:**

| Level | Behavior | Best for |
|---|---|---|
| `full` | Never ask. Execute, validate, open PR, write back. | Well-defined tasks with good test coverage |
| `semi` | Ask before expensive actions (> budget threshold), destructive ops (file deletes, schema changes), or when confidence is low | Default for most workflows |
| `interactive` | Always present a plan first, wait for approval, then execute. Comment with progress at each step. | Complex or risky changes |
| `supervised` | Present a detailed plan with cost estimate. Wait for explicit `/forgectl approve`. Execute exactly the approved plan. | Production deployments, security-sensitive changes |

The agent can also **dynamically escalate**: a `full` autonomy workflow can pause and ask if it encounters something unexpected (e.g., the test suite has 200 failures it didn't expect). This is a safety valve, not a mode change.

---

## Phase Summary

| Phase | Name | Priority | Depends On | Core Value |
|-------|------|----------|------------|------------|
| 1 | Persistent Storage | MUST | v2 complete | Durable memory for everything |
| 2 | Company & Agent Identity | MUST | Phase 1 | Multi-tenancy, budget scoping, audit attribution |
| 3 | Flight Recorder / Run Ledger | MUST | Phase 1, 2 | Every run inspectable and replayable |
| 4 | Durable Execution | MUST | Phase 1-3 | Survive crashes, resume, pause for input |
| 5 | Governance + Budgets | MUST | Phase 2, 3 | Configurable autonomy, approvals, cost control |
| **6** | **GitHub App** | **MUST** | **Phase 4, 5** | **Primary interaction surface — slash commands, reactions, conversation** |
| **7** | **Notion Integration** | **SHOULD** | **Phase 4, 5** | **Non-code workflows — research, content, ops** |
| 8 | Mirrored Task Model | SHOULD | Phase 6, 7 | Unified model across GitHub + Notion |
| 9 | Multi-Agent Delegation | DEFER | Phase 2, 4, 5 | Org hierarchy for complex workflows |
| 10 | Dashboard v2 | DEFER | Phase 3-5 | Power-user aggregate views |
| 11 | E2E Integration | LAST | All | Prove the loop, record the demos |

**Phases 1-5 = the engine.** Durable, auditable, budget-controlled.
**Phase 6 = the product.** This is what people actually interact with.
**Phase 7 = expansion.** Non-code workflows via Notion.
**Phases 8-11 = platform and polish.**

**Parallelizable:** Phase 5 alongside Phase 4. Phase 7 alongside Phase 6 (different integration surface, same engine). Phase 10 incrementally after Phase 3.

---

## Architecture: How It Layers

```
┌─────────────────────────────────────────────┐
│  Dashboard v2 (power users only)            │  ← Phase 10
├─────────────────────────────────────────────┤
│  Multi-Agent Delegation                     │  ← Phase 9
├─────────────────────────────────────────────┤
│  Mirrored Task Model (unified GitHub+Notion)│  ← Phase 8
├──────────────────┬──────────────────────────┤
│  GitHub App      │  Notion Integration      │  ← Phase 6, 7
│  (slash commands,│  (database triggers,     │
│   reactions,     │   property write-back,   │
│   conversations, │   linked Runs DB,        │
│   check runs)    │   content write-back)    │
├──────────────────┴──────────────────────────┤
│  Governance + Approvals │  Budget Enforce.  │  ← Phase 5
│  (configurable autonomy per workflow)       │
├──────────────────────────────────────────────┤
│  Durable Execution (sessions, locks,        │  ← Phase 4
│  pause/resume, waiting_for_input)           │
├─────────────────────────────────────────────┤
│  Flight Recorder / Run Ledger               │  ← Phase 3
├─────────────────────────────────────────────┤
│  Company & Agent Identity (internal)        │  ← Phase 2
├─────────────────────────────────────────────┤
│  SQLite Storage Layer (Drizzle ORM)         │  ← Phase 1
├─────────────────────────────────────────────┤
│  ═══════════ v2 Orchestrator ═══════════    │
│  Tracker Adapters │ Workspace │ WORKFLOW.md │
│  Agent Sessions   │ State Machine │ Retry   │
├─────────────────────────────────────────────┤
│  ═══════════ v1 Core ═══════════════════    │
│  Docker Sandbox │ Validation │ Output       │
│  CLI + Daemon   │ Pipelines  │ Auth/BYOK    │
└─────────────────────────────────────────────┘
```

---

## What NOT to Build

| Don't Build | Why |
|---|---|
| Your own mobile app | GitHub and Notion apps are your UI. Your value is the backend + bot. |
| Full internal issue tracker | GitHub and Notion are your issue systems. Mirror, don't replace. |
| General-purpose agent framework | CrewAI, LangGraph, AutoGen own that lane. |
| Deep org-chart-heavy UX | Build the data model, don't push it on users early. |
| Many agent runtime adapters | Claude Code + Codex covers the cases. |
| Distributed execution | Single machine first. |
| Large WORKFLOW.md DSL | Keep it small. `autonomy` + `triggers` + `validation` + `budget_cap` is enough. |
| Dashboard before GitHub App | The GitHub App IS the product. Dashboard is for power users. |
| Notification system | GitHub and Notion already notify you. |
| Slack/Discord bot (yet) | Get GitHub + Notion right first. Same architecture extends later. |

---

## Architecture Decisions

### GitHub App as primary interaction surface
The GitHub App is not a notification channel — it's the product's UI. Slash commands, reactions, and conversational comments replace the need for a dashboard for most workflows. Design the comment templates with the same care you'd give a web UI.

### Conversational state machine
The agent's `waiting_for_input` state is first-class. When the agent asks a question in a GitHub comment, the run is persisted, the container can be reclaimed, and the full context is restored when the human replies. This is not "blocking" — it's durable suspension.

### Autonomy is per-workflow, not global
Different types of work need different levels of oversight. A bugfix with good test coverage can be `full` autonomy. A database migration should be `supervised`. This lives in WORKFLOW.md so it's version-controlled with the repo.

### GitHub/Notion as pluggable interaction surfaces
The GitHub App and Notion integration are both implementations of an `InteractionSurface` interface:
- `postMessage(issueId, content)` — comment/update
- `askQuestion(issueId, question, options?)` — pause and wait
- `onResponse(issueId, callback)` — handle human reply
- `onReaction(issueId, reaction, callback)` — handle approval
- `onCommand(issueId, command, callback)` — handle slash commands

This means adding Slack, Discord, or Linear later is just another implementation.

### Make sandboxes pluggable
Local Docker stays the default. Leave room for remote Docker, Daytona/E2B, OpenSandbox, Firecracker later.

### Security from day one
- Phase 5: authorization model, privilege escalation prevention
- Phase 6: webhook signature verification (HMAC-SHA256), command permission checks (only collaborators)
- Phase 7: Notion API token scoping, database access controls
- Phase 9: multi-tenant isolation, delegation boundaries

### Event-sourced audit trail
Phase 3 flight recorder is append-only and immutable. Conversations (clarification Q&A) are part of the event stream.

---

## Reference Projects

### Tier 1: Directly borrow from

| Project | What to take |
|---|---|
| **Dependabot** | GitHub App interaction model — bot comments, check runs, PR integration, auto-merge |
| **Composio agent-orchestrator** | Plugin slot architecture, runtime/tracker abstraction, repo-centric task model |
| **OpenHands** | Agent/Controller/State/EventStream separation, Docker runtime design |
| **Paperclip** | Company/agent/budget schema, approval gates, heartbeat scheduling |
| **Probot** | GitHub App framework — webhook handling, event routing, auth |

### Tier 2: Study for execution model

| Project | What to take |
|---|---|
| **Temporal** | Durable workflow execution, replay, signals, approval interrupts |
| **Trigger.dev** | TypeScript-first long-running tasks, retries, queues, observability |
| **LangGraph** | Checkpointer, human-in-the-loop state recovery |
| **Dagger** | Code-first container workflows, CLI ergonomics |

### Tier 3: Study for integration patterns

| Project | What to take |
|---|---|
| **Linear's GitHub integration** | Bidirectional issue sync patterns |
| **Notion API** | Database triggers, blocks API, rate limit handling |
| **OpenSandbox** (Alibaba) | Sandbox API shape, pause/resume |
| **sandboxed.sh** | Workspace isolation patterns |

---

## Key Strategic Risks

1. **GitHub App complexity.** A proper GitHub App with conversational state, slash commands, reactions, and check runs is a substantial engineering effort. Ship 6a (core bot + triggers) first and validate before building 6b-6e. The sub-phases are designed to be shippable independently.

2. **Conversational mid-run pause is hard.** The `waiting_for_input` flow requires clean context serialization, container lifecycle management (do you keep the container warm or reclaim it?), and reliable resume. Get this right with a simple "ask one question, get one answer" before supporting multi-turn conversation.

3. **Write-back quality.** If the GitHub comments are noisy, poorly formatted, or uninformative, people will mute the bot. The comment template is as important as the execution engine. Study Dependabot's comment style — concise, structured, scannable.

4. **Notion API limitations.** No native webhooks, aggressive rate limits (3 req/s), complex blocks API. The Notion integration will always feel slightly less responsive than the GitHub App. Set expectations accordingly.

5. **Autonomy calibration.** If `semi` autonomy asks too many questions, it's annoying. If it asks too few, it makes expensive mistakes. The threshold tuning will require real usage data. Start conservative (ask more), then tune down.

6. **Scope creep via slash commands.** Every slash command is a feature to maintain. Start with the minimal set (`run`, `rerun`, `status`, `stop`, `approve`, `help`) and add more only when users ask.

---

## Success Metrics

| Metric | What it measures |
|---|---|
| **Task completion rate** | Can the agent actually finish work? |
| **Validation pass rate** | Is the output correct? |
| **Recovery success after failure** | Does durability work? |
| **Average human touches per task** | How close to "trigger and forget"? |
| **Clarification round-trips per task** | Is the agent asking the right questions? |
| **Cost per successful task** | Economically viable? |
| **Issue-to-PR cycle time** | How fast from label to PR? |
| **Trigger-to-start latency** | How fast from phone action to agent running? |
| **Write-back readability** | Can you understand results without the dashboard? |
| **Slash command usage** | Which commands do people actually use? |
| **Autonomy escalation rate** | How often does `full` autonomy need to pause and ask? |
| **Bot mute rate** | Are people turning off notifications? (bad signal) |

---

*Updated: 2026-03-08 — GitHub App + Notion integration as core interaction surfaces*
*Synthesized from Claude analysis, two rounds of ChatGPT analysis, and final reconciliation*
