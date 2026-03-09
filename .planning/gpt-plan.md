# forgectl — Final Overall Plan

## Product Identity

forgectl should **not** be positioned primarily as an “AI company platform.”

It should be positioned as:

**A self-hosted, sandboxed runtime for BYOK coding agents that turns issues into validated outputs with approvals, budgets, and durable execution.**

That is the clearest and strongest product story.

The company / agent / org model can exist internally in the architecture, but it should not be the main external framing yet.

---

## Core Moat

The real moat is the combination of:

- sandbox isolation
- validation loops
- workspace lifecycle management
- tracker sync
- durable execution
- approvals and auditability
- cost controls

This is what makes forgectl different.

The moat is **not**:
- org charts
- “agent employees” as a marketing concept
- dashboard polish
- broad agent framework abstractions

---

## Product Wedge

The initial wedge should be:

**GitHub or Notion issue → isolated workspace → agent execution → validation / retry → reviewed output → PR / files / comment back**

This is the shortest path to repeated value.

The target reaction from users should be:

> “This safely gets real repo work done without babysitting.”

Not:

> “This is a cool autonomous company simulator.”

---

## Strategic Principles

1. **Runtime first, metaphor second**  
   Real execution guarantees matter more than organizational metaphors.

2. **Profiles, not pipeline DSL sprawl**  
   Keep `WORKFLOW.md` constrained and ergonomic. Do not reinvent CI/CD as a giant YAML language.

3. **Every run should be inspectable**  
   No opaque black-box automation.

4. **Trustworthiness beats autonomy theater**  
   Prioritize durability, auditability, approvals, and budgets.

5. **Single machine first**  
   Prove the model before distributed execution.

6. **External systems should remain source of truth when possible**  
   Sync with GitHub / Notion instead of replacing them too early.

7. **Company model in the schema, not on the billboard**  
   Use it internally early, market it externally later.

---

## Final v3 Roadmap

### Phase 1 — Persistent Storage

Ship SQLite + Drizzle + migrations.

Core tables should include:

- companies
- agents
- issues / tasks
- runs
- sessions
- approvals
- cost_events
- artifacts
- state_snapshots

This phase gives the platform durable memory and prepares the system for trust, replay, and resumability.

---

### Phase 2 — Company / Agent Schema (Internal Architecture)

Add the internal schema for:

- company identity
- agent identity
- roles
- `reportsTo` hierarchy
- permissions
- budget scopes

This should be treated as **internal architecture**, not the main marketed feature.

Why do it early:
- clean multi-tenancy
- cleaner budget scoping
- future delegation
- coherent permissions model
- durable identity for agents and sessions

Why not lead with it:
- it muddies the wedge
- it risks sounding gimmicky
- it can distract from the stronger runtime story

---

### Phase 3 — Flight Recorder / Run Ledger

Make every run replayable and inspectable.

Persist:

- prompt inputs
- model / runtime used
- tool calls
- container lifecycle events
- validation outputs
- diffs / commits
- retries
- approvals / human interventions
- costs
- final result
- state snapshots

This is one of the most important investments for making the system production-grade.

This is the difference between “demo-ready” and “trustworthy.”

---

### Phase 4 — Durable Execution

This is the phase that makes forgectl genuinely reliable.

Add:

- checkpointing
- resume after crash or restart
- persistent sessions
- reconciliation on daemon restart
- heartbeat scheduling
- idempotent reruns
- explicit run state transitions

Goal:
A run should survive interruption and continue coherently instead of collapsing into ambiguity.

---

### Phase 5 — Governance, Approvals, Locks, and Budgets

Add production-safety controls:

- execution locks
- approval gates for risky actions
- budget ceilings
- pre-flight cost checks
- auto-pause on budget exhaustion
- rollback / retry semantics
- config / policy version tracking

This phase makes the system safe enough for higher-trust use cases.

---

### Phase 6 — Mirrored Task Model / Tracker Normalization

Do **not** build a full first-party issue tracker yet.

Instead:

- mirror GitHub / Notion tasks into an internal normalized task model
- support parent / child task relationships
- store internal execution metadata
- sync status and write-backs outward

This gives you operational consistency without turning forgectl into project-management software.

---

### Phase 7 — Multi-Agent Delegation

Only after the runtime is durable and trustworthy.

Support:

- manager agent creates subtasks
- implementer agent executes
- reviewer agent validates
- validator agent runs checks
- explicit handoff states
- bounded delegation rules

Multi-agent hierarchy should be **supported**, but not forced on every workflow.

Most real users will start with:
- one implementer
- one reviewer
- maybe one validator

The system should support richer hierarchy without requiring it.

---

### Phase 8 — Dashboard v2

Improve the UI only after the engine earns it.

Add:

- run explorer
- task board
- cost dashboard
- approval queue
- agent detail pages
- org chart later
- optional WebSocket upgrade later if needed

Do **not** let dashboard complexity outrun core execution reliability.

SSE is fine until the system has stronger needs.

---

## What to Explicitly Defer

The following should **not** be early priorities:

- a full internal issue tracker
- org-chart-heavy UX
- distributed cluster execution
- too many runtime integrations
- giant workflow DSL complexity
- enterprise RBAC over-engineering
- frontend real-time complexity for its own sake

Keep the scope narrow and sharp.

---

## Runtime Support Scope

Early support should remain focused on:

- Claude Code
- Codex
- raw LLM API integrations

That is enough.

Do not rush to add:
- Aider
- Cursor
- OpenCode
- every new agent runtime that appears

Each runtime adds maintenance cost and strategic distraction.

---

## Recommended Architecture References

### Primary references to study

#### OpenHands
Use as inspiration for:
- Agent / Controller / State / Event separation
- runtime boundaries
- coding-agent execution patterns

#### Composio Agent Orchestrator
Use as inspiration for:
- tracker abstraction
- runtime abstraction
- issue-to-worktree orchestration
- swappable adapter patterns

#### Temporal / Trigger.dev
Use as inspiration for:
- durable execution
- retries
- long-running workflows
- child task orchestration
- resume semantics
- state-machine correctness

#### Dagger
Use as inspiration for:
- code-first container workflow ergonomics
- composability
- caching mindset
- strong CLI workflow design

---

### Secondary references

#### Paperclip
Study for:
- company / budget / governance schema ideas

Do **not** copy its identity or let it define the framing of forgectl.

#### OpenSandbox / Daytona / sandboxed.sh
Study for:
- sandbox backend ideas
- remote execution patterns
- workspace persistence concepts

Do not optimize for these until the local single-machine product is clearly working.

---

## Product Positioning

### Recommended product sentence

**forgectl is a self-hosted, sandboxed runtime for BYOK coding agents that takes issues to validated outputs with approvals, budgets, and durable execution.**

This is the sentence to anchor messaging around.

### Things not to lead with

Avoid making these the main pitch:

- “autonomous agent company”
- “agents as employees”
- “AI org charts”
- “replace your PM system”
- “general-purpose multi-agent platform”

Those can exist as downstream capabilities, but not as the initial wedge.

---

## Success Criteria

The north star question should be:

**Can one engineer trust forgectl to run 20 real coding tasks per day without babysitting?**

Track metrics like:

- task completion rate
- validation pass rate
- recovery success after failure
- average human touches per task
- cost per successful task
- issue-to-output cycle time
- percent of runs that are fully auditable
- percent of runs resumable after restart

These are better indicators of progress than stars, UI polish, or demo complexity.

---

## Immediate Next Build Plan

### Next build cycle
Ship:

- SQLite + migrations
- company / agent / run schema
- artifacts table
- state snapshots
- resume / reconcile basics

### Immediately after
Ship:

- approval gates
- cost event tracking
- budget enforcement
- execution locks
- policy / config version tracking

### Then
Ship:

- normalized mirrored task model
- reviewer / validator delegation
- minimal dashboard upgrades

This is the highest-leverage sequence.

---

## Final Strategic Conclusion

The final overall plan is:

**Build forgectl into the trusted runtime layer for coding agents.**

Use the company model early as internal structure.  
Delay the “agent company platform” framing until the execution engine is strong enough that users already trust it.

In one line:

**Own safe, durable issue-to-output execution first. Expand into company-style coordination later.**
