# Feature Landscape

**Domain:** Durable AI agent runtime with persistent state, GitHub App interaction, audit trail, governance, and browser-use integration
**Researched:** 2026-03-09

---

## 1. SQLite-Backed Persistent State with Migrations

### Table Stakes

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Schema-driven migrations with up/down | Any production system with evolving schema needs reversible migrations | Low | None (foundational) |
| WAL mode for concurrent reads during writes | Without WAL, the daemon blocks reads during agent state writes; users will see stalls | Low | None |
| Repository pattern (typed query/mutation functions) | Raw SQL scattered through business logic is unmaintainable; Drizzle's query builder handles this | Med | Schema design |
| Atomic transactions for state transitions | Orchestrator state machine transitions must be atomic (claim + lock + update) or you get double-dispatch | Low | Schema design |
| Connection pooling / singleton management | better-sqlite3 is synchronous; one connection per process, but must handle concurrent async callers safely | Low | None |
| Graceful migration on first run | Users should not run a separate migration command; `forgectl orchestrate` should auto-migrate on startup | Low | Migration infra |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Schema versioning with rollback | Lets users downgrade forgectl versions without data loss | Med | Drizzle Kit generates SQL files; rollback requires storing down-migrations |
| Query-level observability (slow query logging) | Debugging production issues when the daemon feels slow | Low | Log queries > N ms via better-sqlite3 verbose mode |
| Backup on migration (automatic `.bak` before schema change) | Safety net for users self-hosting; SQLite file copy is trivial | Low | Copy file before `migrate()` |
| Export/import (JSON dump of full DB state) | Disaster recovery, moving between machines | Med | Useful but not urgent |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| PostgreSQL / MySQL support | Adds operational complexity (connection management, hosting, config). SQLite handles single-machine workloads up to hundreds of thousands of runs. Scale later if needed. | Stick with SQLite via better-sqlite3. Abstract behind repository pattern so swapping drivers is possible but not planned. |
| ORM auto-sync (push schema without migrations) | Drizzle supports `push` for dev, but it is destructive in production. Generates no migration files, so you cannot audit what changed. | Always use `drizzle-kit generate` to produce migration SQL files. Use `push` only in dev/test. |
| Embedded migration runner as separate CLI | Adds friction. Users forget to run it. | Auto-migrate on daemon start with version check. |
| Multi-database sharding | Premature optimization for single-machine | Single SQLite file per installation |

### Complexity Assessment

**Overall: LOW-MEDIUM.** Drizzle ORM + better-sqlite3 is well-documented and widely adopted for exactly this use case. The main complexity is schema design (getting tables right for identity, runs, events, approvals, costs) rather than the infrastructure itself.

### Dependencies on Existing Features

- Replaces file-based `RunLog` JSON writer (`src/logging/run-log.ts`) as the primary persistence layer
- Replaces in-memory orchestrator state (`src/orchestrator/`) with SQLite-backed state
- Must preserve backward compatibility: existing `forgectl run` still works, just writes to SQLite instead of JSON files
- PID file management (`src/daemon/`) stays file-based (appropriate for PID lifecycle)

---

## 2. GitHub App Interaction Model

### Table Stakes

Studied: Dependabot, Renovate, GitHub Copilot coding agent, Probot framework.

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Webhook receiver with HMAC-SHA256 verification | Any GitHub App must verify webhook signatures. Without this, anyone can POST fake events. | Low | Fastify route |
| Bot identity (`forgectl[bot]` comments) | Users expect a recognizable bot persona. Dependabot and Copilot both do this. | Low | GitHub App registration |
| Label-based triggers (`issues.labeled`) | The simplest trigger model. Dependabot uses config, Copilot uses assignment. Label is most explicit. | Low | Webhook receiver |
| Structured issue comments (status, result, cost) | Dependabot and Copilot both post structured markdown. This IS the UI for mobile users. | Med | Flight recorder (for data), template engine |
| Basic slash commands (`/run`, `/rerun`, `/stop`, `/status`) | Copilot uses `@copilot` mentions. Renovate uses checkboxes in its dashboard issue. Slash commands are the standard for bots. | Med | Comment webhook + command parser |
| Permission checks (only collaborators can issue commands) | Without this, any commenter can trigger expensive runs. Dependabot restricts to maintainers. | Low | GitHub API `get collaborator` |
| PR creation with structured description | Copilot creates PRs with plans. Dependabot creates PRs with changelogs. The PR body IS the audit trail for reviewers. | Med | Git output mode, template engine |
| Check runs on created PRs | Standard for any bot that creates PRs. Shows validation status inline in the PR. | Med | GitHub Checks API |
| Webhook event deduplication | GitHub retries webhooks on timeout. Without dedup, you dispatch the same issue twice. | Low | Run ID + idempotency key |
| Fallback to polling for self-hosted without webhooks | Not everyone can expose a public endpoint. Existing polling must keep working. | Low | Already built in v1.0 |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Reactions as approvals (thumbs-up = approve) | Phone-friendly. One tap to approve. No bot in the market does this well for autonomous agents. | Med | Reaction webhook + approval system integration |
| Conversational clarification (mid-run questions) | The agent asks a question in a comment, pauses, resumes when you reply. This is the "from your phone" killer feature. Copilot does a version of this but limited to plan review. | High | Durable execution (pause/resume), context serialization |
| Dynamic autonomy escalation | Agent running in `full` mode encounters something unexpected, auto-escalates to ask. No existing bot does this. | High | Governance system, agent state machine |
| `/forgectl decompose` (break issue into sub-issues) | Manager agent creates sub-issues. Unique to multi-agent orchestration. | High | Multi-agent delegation (Phase 9) |
| Comment templates customizable per workflow | Different workflows need different comment styles. WORKFLOW.md controls the bot's voice. | Med | Template engine in WORKFLOW.md |
| Auto-close issue on PR merge | Full lifecycle: issue -> agent -> PR -> merge -> auto-close with summary. Dependabot does this for dependency PRs. | Low | PR merge webhook |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Probot as a framework dependency | Probot adds opinions about app lifecycle, logging, and configuration that conflict with forgectl's existing Fastify daemon. It was valuable in 2018-2022 but modern GitHub App development is straightforward with octokit + raw webhooks. | Use `@octokit/app` + `@octokit/webhooks` directly. Handle webhook routing in Fastify. |
| Dependency Dashboard issue (Renovate-style) | Renovate creates a persistent "Dependency Dashboard" issue that lists all pending updates. This pattern becomes noisy for general-purpose agent work. | Use per-issue comments. Status lives where the work lives. |
| Excessive slash commands at launch | Every command is a maintenance burden. Renovate has dozens of checkbox options; it overwhelms new users. | Ship 6 commands: `/run`, `/rerun`, `/stop`, `/status`, `/approve`, `/help`. Add more based on real usage. |
| GitHub Actions as the runtime | Some bots run inside Actions. This limits execution to 6 hours, provides no persistent state, and is expensive at scale. | forgectl IS the runtime. The GitHub App is just the interaction surface. |
| Bidirectional issue sync | Syncing issue state between GitHub and an internal tracker adds enormous complexity (conflict resolution, ordering). Linear does this and it is their entire product. | One-way: GitHub issues trigger work. forgectl writes results back as comments and PRs. Internal state is in SQLite. |

### Complexity Assessment

**Overall: HIGH.** The GitHub App is the most complex feature in the milestone. Sub-phasing (6a-6e) is essential. The core bot (6a) is medium complexity. Conversational clarification (6c) is the hardest part -- it requires durable execution, context serialization, and reliable webhook-to-run matching.

### Dependencies on Existing Features

- **Fastify daemon** (`src/daemon/`): webhook receiver is a new route group (`/webhooks/github`)
- **Tracker adapter** (`src/tracker/`): GitHub App replaces polling for repos where it is installed; polling remains as fallback
- **Orchestrator** (`src/orchestrator/`): webhook events enqueue into the existing RunQueue
- **Output** (`src/output/`): PR creation extends the existing git output mode
- **Durable execution**: conversational clarification requires pause/resume (Phase 4)
- **Governance**: reactions-as-approvals requires the approval system (Phase 5)

---

## 3. Event-Sourced Audit Trail / Flight Recorder

### Table Stakes

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Append-only event log per run | Core of event sourcing. Every state change is an immutable event. This is what makes runs inspectable and replayable. | Med | SQLite storage (Phase 1) |
| Event types covering the full run lifecycle | `run_started`, `prompt_built`, `agent_invoked`, `tool_called`, `validation_started`, `validation_passed`, `validation_failed`, `retry_scheduled`, `cost_incurred`, `run_completed`, `run_failed` | Med | Schema design |
| Structured event payloads (not just strings) | Events need typed metadata: timestamps, durations, token counts, file paths, exit codes. Otherwise the audit trail is useless for debugging. | Med | Zod schemas for each event type |
| Query by run ID, agent, issue, time range | Operators need to filter runs. "Show me all failed runs for agent X in the last 24 hours." | Low | SQLite indexes |
| CLI inspection (`forgectl run inspect <run-id>`) | Operators should not need to query SQLite directly. | Low | CLI command + query layer |
| Cost event tracking (tokens, model, provider, cents) | Budget enforcement depends on accurate cost data. Every LLM call records its cost. | Med | Agent adapter hooks |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| State reconstruction from events | Rebuild the current state of any run from its event history (event sourcing, not just event logging). Enables time-travel debugging. | High | Requires event replay logic, projection functions |
| Rich write-back to GitHub/Notion | The audit trail IS the comment. Structured summaries with files changed, validation results, cost breakdown, PR link. This replaces the need for a dashboard for 80% of use cases. | Med | Template engine, tracker write-back |
| Conversation events (clarification Q&A in the event stream) | Questions asked and answers received become part of the audit trail. Full context of human-agent interaction is preserved. | Med | Durable execution (Phase 4) |
| Diff/commit recording | Record what the agent actually changed (git diff summaries, file list). Enables "what did the agent do?" without reading the PR. | Med | Git integration in output module |
| Event streaming (SSE/WebSocket for live run monitoring) | Watch a run in real-time from the dashboard. Existing `RunEvent` emitter in v1 can feed this. | Med | Already have `RunEvent` emitter; need to bridge to SSE |
| Retention policies (auto-archive old events) | Without retention, the SQLite DB grows unbounded. Archive events older than N days to compressed files. | Low | Scheduled cleanup task |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full CQRS (separate read/write databases) | Massively over-engineered for a single-machine daemon. CQRS is for distributed systems with different scaling needs for reads vs writes. | Single SQLite database with append-only events table and materialized views (or denormalized query tables) for fast reads. |
| Event store as a separate service (EventStoreDB, Kafka) | External dependency for a self-hosted CLI tool is a non-starter. | SQLite events table with auto-incrementing sequence numbers. |
| Replaying events to rebuild entire system state on startup | Slow startup, complex replay logic. Fine for a bank, overkill for an agent runtime. | Maintain current state in separate tables. Events are the audit trail, not the primary state store. Use events for inspection and debugging, not for running the system. |
| Recording raw LLM responses | Token-for-token recording of model outputs is expensive (storage), potentially contains sensitive code, and rarely useful. | Record: prompt hash, model, token counts, cost, duration, tool calls. Not the full response body. |

### Complexity Assessment

**Overall: MEDIUM.** The event logging itself is straightforward (append rows to an events table). The complexity is in (a) designing event schemas that cover all cases without being too granular, and (b) rich write-back formatting that is actually useful and not noisy.

### Dependencies on Existing Features

- **Logging** (`src/logging/`): the existing `RunEvent` emitter and `RunLog` JSON writer are the starting point; flight recorder replaces RunLog as the persistence layer
- **Agent adapters** (`src/agent/`): must emit cost events after each invocation
- **Validation** (`src/validation/`): must emit validation pass/fail events with error details
- **Tracker** (`src/tracker/`): write-back uses tracker adapters to post comments

---

## 4. Durable Execution with Pause/Resume and Crash Recovery

### Table Stakes

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Crash recovery (resume interrupted runs on daemon restart) | If the daemon crashes mid-run, it must detect interrupted runs and either resume or mark them failed. Without this, runs silently disappear. | Med | SQLite state (Phase 1), reconciliation logic |
| Idempotent step boundaries | Resuming a run must not re-execute completed steps. Each step records its completion status. | Med | Checkpoint storage |
| Execution locks (one agent per issue at a time) | Without locks, two daemon restarts can dispatch two agents to the same issue. SQLite `BEGIN IMMEDIATE` provides atomic locking. | Low | SQLite transactions |
| Heartbeat with stall detection | v1 has this in-memory. Must survive restarts: last heartbeat timestamp in SQLite, reconciler checks on startup. | Low | Existing stall detection + SQLite |
| Configurable timeout per workflow | Some tasks take 5 minutes, some take 2 hours. Timeout must be in WORKFLOW.md. | Low | WORKFLOW.md extension |
| State snapshot at step boundaries | Before each major step (prompt build, agent invoke, validation), snapshot current state so resume knows where to pick up. | Med | Event stream (Phase 3) |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Pause/resume for human clarification | Agent enters `waiting_for_input`, serializes context, releases container resources. Human replies (via GitHub comment), agent resumes with full context restored. This is the "conversation from your phone" feature. | High | Context serialization, container lifecycle, webhook-to-run matching |
| Container reclamation during pause | While waiting for human input (could be hours), release the Docker container to free resources. Restore workspace from persistent storage when resuming. | High | Workspace persistence, container rebuild |
| Invocation source tracking | Know whether a run was triggered by `timer`, `webhook`, `slash_command`, `label`, or `manual`. Affects priority and audit trail. | Low | Enum field on run record |
| Wakeup coalescing | If 3 webhooks fire for the same issue within 5 seconds, dispatch once, not three times. | Med | Dedup with time window |
| Graceful shutdown (drain active runs) | On `SIGTERM`, finish active runs (or checkpoint them) rather than killing mid-execution. | Med | Signal handling, checkpoint |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full Temporal-style workflow replay | Temporal replays the entire workflow history on every decision point. This requires deterministic workflow code and a Temporal server. Far too heavy for a single-process daemon. | Simple checkpoint-resume: save state at step boundaries, resume from last checkpoint. No replay, no determinism requirement. |
| CRIU-based container checkpointing (Trigger.dev-style) | CRIU freezes entire Linux processes. Requires root, kernel support, and is fragile across kernel versions. Trigger.dev runs their own infrastructure to support this. | Checkpoint at the application level: serialize run state to SQLite, not at the process/container level. |
| Distributed execution across workers | Multiple workers picking up checkpointed runs adds consensus, state transfer, and networking complexity. | Single daemon, single machine. One process owns all runs. |
| Persistent agent subprocesses across daemon restarts | Keeping a Claude Code subprocess alive across restarts requires PID management, signal forwarding, and is unreliable. | Kill agent subprocess on daemon stop. Resume by re-invoking agent with restored context (prior conversation, completed steps). |

### Complexity Assessment

**Overall: HIGH.** Crash recovery and idempotent steps are medium. Pause/resume for human clarification is the hardest feature in the milestone -- it requires clean context serialization (what does the agent need to know when it resumes?), container lifecycle management (keep warm vs. reclaim?), and reliable webhook-to-suspended-run matching.

**Risk:** The "resume with full context" problem. When an agent pauses and resumes hours later, it gets a fresh invocation with injected context. The quality of that context injection determines whether the agent can actually continue effectively. This needs experimentation, not just engineering.

### Dependencies on Existing Features

- **Orchestrator** (`src/orchestrator/`): state machine gains `paused`, `waiting_for_input` states
- **Agent** (`src/agent/`): session adapters need `serialize()` / `restore()` for context
- **Workspace** (`src/workspace/`): workspaces must persist across container reclamation
- **Container** (`src/container/`): must support "rebuild container for existing workspace"
- **Flight recorder** (Phase 3): state snapshots are events in the audit trail

---

## 5. Governance with Configurable Autonomy and Budget Enforcement

### Table Stakes

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Autonomy levels per workflow (`full`, `semi`, `interactive`, `supervised`) | Different work needs different oversight. A typo fix should be `full`. A DB migration should be `supervised`. | Med | WORKFLOW.md extension |
| Budget cap per workflow | "Don't spend more than $5 on this type of task." Without this, a runaway agent can burn $100 on a simple bug fix. | Med | Cost tracking (Phase 3), pre-flight check |
| Pre-flight cost estimation | Before starting a run, estimate cost based on task complexity signals (issue length, file count, historical data). Block if estimate exceeds budget. | Med | Historical cost data |
| Approval state machine (`pending -> approved/rejected`) | Approvals must be tracked, not ad-hoc. State machine prevents double-approval or approval after rejection. | Low | SQLite storage |
| Auto-approve rules (cost < $X, files < N, has specific label) | Most runs should not require manual approval. Auto-approve is what makes `full` autonomy viable. | Med | Rule engine in governance module |
| Budget exhaustion auto-pause | When a company/agent budget is depleted, pause all runs rather than silently failing or continuing to spend. | Med | Cost aggregation queries |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dynamic escalation (agent self-escalates when uncertain) | An agent in `full` mode encounters 200 test failures it didn't expect and pauses to ask. No other agent runtime does this automatically. | High | Agent adapter integration, confidence signals |
| Budget periods with auto-reset (monthly, weekly) | "$500/month for this agent" with automatic reset. Prevents one bad month from permanently blocking the agent. | Med | Scheduled budget reset |
| Cost attribution per agent and per company | Multi-agent setups need to know which agent is expensive. Company-level budgets scope costs to projects. | Med | Identity model (Phase 2) |
| Approval via GitHub reaction | Thumbs-up on the bot's "plan review" comment = approve. This is the mobile-first approval UX. | Med | GitHub App (Phase 6), reaction webhooks |
| Configurable approval types | `expensive_run`, `destructive_change`, `plan_review`, custom types. Each type can have different approvers and rules. | Med | Extensible approval system |
| Budget alerts (warn at 80%, pause at 100%) | Proactive warnings before budget is exhausted. Post a comment: "This agent has used 80% of its monthly budget." | Low | Threshold checks on cost events |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Role-based access control (RBAC) | Multi-user RBAC is a separate product concern. v2.0 is single-user. | Simple permission checks: is this person a repo collaborator? That is enough. |
| Complex approval workflows (multi-approver, quorum) | Enterprise approval chains are scope creep. | Single approver per action. The repo maintainer approves. |
| Real-time cost streaming from LLM providers | Most providers don't stream cost data. You get token counts after the call completes. | Calculate cost post-hoc from token counts and model pricing tables. |
| Granular per-tool budgets | "Limit search to $0.50, code generation to $2.00" is too fine-grained. Users cannot reason about costs at this level. | Budget per run and per agent/period. Not per tool. |

### Complexity Assessment

**Overall: MEDIUM.** The autonomy levels and approval state machine are straightforward. Budget enforcement is medium (accounting is fiddly but not algorithmically hard). Dynamic escalation is the hard part -- it requires the agent to signal uncertainty, which depends on prompt engineering and agent adapter support.

### Dependencies on Existing Features

- **WORKFLOW.md** (`src/workflow/`): gains `autonomy` and `budget_cap` fields
- **Config merge** (`src/config/`): governance settings participate in 4-layer merge
- **Identity** (Phase 2): budget scoping requires agent/company identity
- **Flight recorder** (Phase 3): cost events are audit trail events
- **Agent adapters** (`src/agent/`): must report token usage per invocation

---

## 6. Browser-Use Integration

### Table Stakes

If you are going to offer web research as a capability, these are expected.

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Browser-use runs inside a Docker container (sandboxed) | Browser automation must be sandboxed. A rogue browser session accessing arbitrary URLs is a security risk. | Med | Docker sandbox (`src/container/`) |
| LLM-driven web navigation (search, read, extract) | The core value: agent can research topics by browsing the web, not just generating text. | Med | browser-use framework, LLM API key |
| Structured output extraction (not raw HTML) | The agent should return structured findings (JSON, markdown), not browser screenshots. | Med | browser-use output parsing |
| Configurable via WORKFLOW.md | A "research" workflow type that enables browser-use as a tool for the agent. | Low | WORKFLOW.md extension |
| Cost tracking for browser-use sessions | Browser-use calls an LLM for every navigation decision. These costs must be tracked like any other LLM invocation. | Med | Cost tracking (Phase 3/5) |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Browser-use as a tool available to coding agents | Not a separate workflow type -- the coding agent (Claude Code) can invoke browser-use as a tool when it needs to look something up. Research is embedded in the coding flow. | High | Tool registration, subprocess management, cross-language bridge |
| Pre-built research workflow template | "Here is a research task, go find the answer on the web." A WORKFLOW.md template that sets up browser-use with appropriate prompts. | Low | WORKFLOW.md template |
| Screenshot capture for audit trail | Record what the browser saw at each step. Useful for debugging and verification. | Med | Playwright screenshot API |
| URL allowlist/blocklist | Restrict which sites the browser agent can visit. Important for security and cost control. | Low | Browser-use config |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Building a custom browser automation framework | browser-use exists, is well-maintained (50k+ GitHub stars), and handles the hard problems (element detection, navigation, error recovery). | Integrate browser-use as a subprocess. Do not rebuild. |
| Browser-use in the same process as forgectl | browser-use is Python. forgectl is TypeScript. In-process integration is impossible. | Run browser-use as a Python subprocess inside the Docker container. Communicate via stdout/stdin JSON or a temporary file. |
| Browser-use Cloud (hosted service) | Adds an external dependency and network latency. forgectl's value proposition is self-hosted. | Run browser-use locally inside the container with a headless Chromium. |
| Real-time browser streaming to dashboard | Showing a live browser view in the web dashboard is cool but enormously complex (WebRTC, frame encoding). | Capture periodic screenshots and final page content. Display in audit trail. |
| Replacing Claude Code's built-in web search | Claude Code and Codex may have their own web search tools. browser-use is for cases where you need deeper web interaction (filling forms, navigating multi-page flows, extracting structured data). | Position browser-use as a complementary tool, not a replacement for built-in search. |

### Architecture Notes: Browser-Use Integration Model

Browser-use is a **Python** library (Python 3.11+, Playwright, Chromium). forgectl is TypeScript. The integration model is:

1. **Container image**: A `forgectl/research` Docker image that includes Python 3.11+, browser-use, Playwright, and Chromium alongside the standard forgectl agent tools.
2. **Invocation**: The agent (Claude Code) calls browser-use as a tool via a shell command inside the container: `python3 /opt/browser-use/research.py --task "find pricing for X" --output /workspace/research.json`
3. **Communication**: browser-use writes structured JSON output to a file. The agent reads the file and incorporates findings.
4. **LLM keys**: browser-use uses the same BYOK API keys already configured in forgectl. Passed as environment variables into the container.
5. **Cost tracking**: browser-use's LLM calls are tracked via a wrapper that logs token usage to a file, which forgectl collects post-run.

**Confidence: MEDIUM.** This integration model is viable but untested. The cross-language bridge (TypeScript -> Python subprocess) adds operational complexity. The main risk is that browser-use's LLM usage is opaque -- tracking costs requires instrumenting browser-use or wrapping the LLM client.

### Complexity Assessment

**Overall: MEDIUM-HIGH.** The browser-use framework itself handles the hard browser automation problems. The complexity is in the integration: building the Docker image with Python + Chromium + browser-use, making it available as a tool to agents, and tracking costs across the TypeScript/Python boundary.

### Dependencies on Existing Features

- **Container** (`src/container/`): needs a new Docker image with Python + browser-use + Chromium
- **Agent adapters** (`src/agent/`): agents must be able to invoke browser-use as a tool
- **WORKFLOW.md** (`src/workflow/`): new workflow type or tool configuration
- **Cost tracking** (Phase 3/5): must capture browser-use LLM costs

---

## Feature Dependencies (Cross-Cutting)

```
Phase 1: SQLite Storage
    |
    +---> Phase 2: Identity (needs storage)
    |         |
    |         +---> Phase 5: Governance (needs identity for budget scoping)
    |         |         |
    |         |         +---> Phase 6: GitHub App (needs governance for approvals)
    |         |
    |         +---> Phase 3: Flight Recorder (needs identity for attribution)
    |                   |
    |                   +---> Phase 4: Durable Execution (needs events for state recovery)
    |                             |
    |                             +---> Phase 6: GitHub App (needs pause/resume for conversations)
    |
    +---> Browser-Use: Can be built independently (container + workflow config)
          but cost tracking needs Phase 3/5
```

## MVP Recommendation

### Build first (foundation, no user-visible change):
1. **SQLite storage** -- everything else depends on it
2. **Identity model** -- budget scoping and audit attribution need it

### Build second (core value):
3. **Flight recorder** -- makes every run inspectable; enables rich write-back
4. **Durable execution** -- crash recovery, pause/resume

### Build third (the product):
5. **Governance** -- budget enforcement, autonomy levels (can parallelize with Phase 4)
6. **GitHub App** (sub-phased 6a-6e) -- the primary interaction surface

### Defer:
- **Browser-use integration**: Build after the core runtime is solid. It is a capability extension, not a runtime requirement. Could be a v2.1 feature or a late v2.0 addition if time permits.
- **Multi-agent delegation**: v2.1+
- **Dashboard v2**: v2.1+, GitHub App is the primary UI

## Sources

- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite)
- [Drizzle ORM Migrations](https://orm.drizzle.team/docs/migrations)
- [Drizzle vs Prisma comparison (2026)](https://www.bytebase.com/blog/drizzle-vs-prisma/)
- [Node.js ORM comparison (2025)](https://thedataguy.pro/blog/2025/12/nodejs-orm-comparison-2025/)
- [Probot framework](https://probot.github.io/docs/best-practices/)
- [Probot slash commands extension](https://github.com/probot/commands)
- [Renovate bot comparison](https://docs.renovatebot.com/bot-comparison/)
- [GitHub Copilot coding agent interaction model](https://dev.to/pwd9000/using-github-copilot-coding-agent-for-devops-automation-3f43)
- [Event sourcing as audit log (Event-Driven.io)](https://event-driven.io/en/audit_log_event_sourcing/)
- [Event sourcing with Node.js (RisingStack)](https://blog.risingstack.com/event-sourcing-with-examples-node-js-at-scale/)
- [Event sourcing explained (2025)](https://www.baytechconsulting.com/blog/event-sourcing-explained-2025)
- [Temporal durable execution](https://temporal.io/product)
- [Trigger.dev v3 checkpoint-resume](https://trigger.dev/docs/how-it-works)
- [TypeScript orchestration comparison (Temporal vs Trigger.dev vs Inngest)](https://medium.com/@matthieumordrel/the-ultimate-guide-to-typescript-orchestration-temporal-vs-trigger-dev-vs-inngest-and-beyond-29e1147c8f2d)
- [Agentic AI governance (McKinsey)](https://www.mckinsey.com/capabilities/risk-and-resilience/our-insights/trust-in-the-age-of-agents)
- [AI agent governance principles (2025)](https://www.arionresearch.com/blog/g9jiv24e3058xsivw6dig7h6py7wml)
- [browser-use GitHub repository](https://github.com/browser-use/browser-use)
- [browser-use website](https://browser-use.com/)
- [Agentic browser landscape (2026)](https://www.nohackspod.com/blog/agentic-browser-landscape-2026)
- [Best cloud browser APIs (2026)](https://scrapfly.io/blog/posts/best-cloud-browser-apis)
