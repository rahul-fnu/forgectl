# forgectl — Vision & Plan (v2)

> *A self-hosted, autonomous software delivery engine that understands your codebase, learns from its own runs, orchestrates multiple agents, enforces quality gates, and improves itself over time.*

-----

## Origin: What Problem Are We Solving?

Every coding agent today — Devin, Copilot Workspace, Claude Code — is a **tool**. A human decides what to build, breaks it down into tasks, assigns them, and reviews outputs. The AI executes individual tasks. The human is still the operating system.

**The vision for forgectl is different.** It takes *goals* as input, not tasks. The system decides what work needs to happen, in what order, at what granularity, with what validation criteria. The human's role collapses to: specify intent, accept or reject outputs.

```
TODAY:
  Goal → [human decomposes] → Linear issue → forgectl → Code

VISION:
  Goal → [forgectl decomposes] → Tasks → [forgectl executes] → Code
                ↑                                                │
                └────────── learns from outcomes ◄──────────────┘
```

The execution layer is built. The decomposition layer (v1) and the learning layer (v1) are shipped and running. Refinement continues through real usage.

-----

## The One-Line Pitch

> **"Point it at your backlog. It empties it."**

Self-hosted. Runs on your infra against your codebase. Learns your conventions, your test patterns, your architecture. Gets better every run. Full observability and control — not a black box. Human-in-the-loop when you want it.

-----

## Approach: Dogfood-First, Product Later

This is a personal engine first. The primary user for the next 1.5–2 years is the author, running forgectl against every project they build. The goal is hundreds of real runs on real codebases before any external users touch it.

This changes the development philosophy:

- **No premature optimization for scale.** Single-user, single-machine is fine.
- **The learning loop doesn't need to be autonomous from day one.** Manual observation → manual correction → gradual automation. Let the data reveal which patterns the system catches correctly on its own and which it gets wrong.
- **The decomposition engine will go through 3–4 rewrites.** That's expected. Keep it behind a swappable interface.
- **The meta-loop (forgectl building forgectl) is safe** because the human is reviewing every PR, catching regression spirals early, and manually course-correcting. The human is the validation layer.
- **The roadmap emerges from real usage**, not from architecture diagrams. Ship the foundation, run it hard, and let the next priority reveal itself.

The standalone product is a possible future. If the engine works well enough after 1.5–2 years of dogfooding, open-source the core, offer a hosted version for teams. But the product ambition doesn't drive the build — the dogfooding drives the build.

-----

## Infrastructure Decision: Claude Max 20x + Opus Everywhere

**Subscription:** Claude Max 20x ($200/month). All agent execution runs through Claude Code authenticated against this subscription. No API keys, no per-token billing.

**Model:** Opus for everything — planning, execution, review. No model routing strategy. The quality uplift from Opus on decomposition and review is worth more than any rate limit savings from cheaper models. One execution model, one model tier, one less moving part.

**Why this matters for architecture:**

- **Kill dollar-based cost tracking.** No budget gates, no per-run dollar estimates, no cost insertion gaps to fix. Track turns, token counts, and task duration for observability and the learning loop — but money is a flat $200/month regardless.
- **No model routing complexity.** The workflow definition format doesn't need `agent: claude-haiku` vs `agent: claude-opus` routing. Everything is Opus.
- **One execution model.** Spec interpretation, decomposition, review, implementation — all run as Claude Code invocations. No separate API-calling path for "lighter" operations.
- **The flywheel metric is quality, not cost.** Track: tasks completed without human intervention, review comments per run trending down, decomposition accuracy, retry rates. "Percentage of tasks where your review is a rubber stamp" is the north star.

**Rate limits:** Max 20x provides the highest available rate limits. For a single-user dogfooding engine, this is sufficient. If parallelism becomes constrained, serialize tasks — the scheduler should understand that concurrent sessions share a rate limit pool, but this is unlikely to be a real bottleneck.

-----

## Core Architecture: Four Layers

### Layer 1: The Codebase Knowledge Graph

Every other layer depends on this. Before you can plan work, validate specs, estimate complexity, or understand what's safe to change — the system needs to understand the codebase as a *semantic entity*, not a pile of files.

```
KnowledgeGraph {
  // Structure
  modules: Map<path, Module>           // parsed AST, exports, imports
  callGraph: DirectedGraph             // who calls what
  dependencyGraph: DirectedGraph       // module dependencies (1-hop + transitive)
  testCoverage: Map<path, Coverage>    // which tests cover which code paths

  // History
  changeGraph: Map<path, ChangeHistory>    // git log → what changed together
  couplingMetrics: Map<pair, float>        // files that always change together
  flakyTests: Set<testId>                  // tests that fail non-deterministically

  // Outcomes (from run history)
  taskOutcomes: Map<taskType, Outcomes>    // what kinds of tasks succeed/fail
  retryRates: Map<module, float>           // which modules cause the most retries

  // Conventions (extracted, not just CLAUDE.md)
  namingPatterns: Pattern[]
  testingPatterns: Pattern[]
  errorHandlingPatterns: Pattern[]
  architecturalBoundaries: Boundary[]     // "auth never imports from billing"
}
```

**This graph is the moat.** Cloud coding agents can't have it — they don't persist deep semantic knowledge of your codebase across sessions. A system that has run 500 tasks on your codebase knows things about it that no other tool does: which modules are fragile, which tests are flaky, which architectural patterns you use, what kinds of changes tend to break things.

**Build strategy:** Start with the pieces that immediately make runs better — import graph, test coverage mapping, and change coupling from git history. Convention extraction and architectural boundary detection emerge later once there's enough run history to know which fields are actually predictive. Resist building the full schema upfront.

**Technically:** tree-sitter for multi-language AST parsing, SQLite graph for storage, incremental updates via git hooks. Build this first.

-----

### Layer 2: The Planning System

With the knowledge graph, the planner becomes genuinely powerful. Without it, the planner is just prompting Claude and hoping.

**Honest caveat:** Automated task decomposition that accounts for risk isolation, dependency ordering, and blast radius is genuinely hard — closer to a research problem than an engineering task. Expect 3–4 rewrites of the decomposition engine. Keep it behind a swappable strategy interface. Let hundreds of real runs reveal what works and what doesn't.

#### A. The Spec Interpreter

Takes human intent (rough goal, feature description, anything) and produces a structured, validated spec:

```typescript
interface Spec {
  id: string
  intent: string                     // what the human wrote
  scope: {
    affectedModules: string[]        // from knowledge graph
    estimatedTouchpoints: number     // files likely to change
    riskLevel: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL'
    breakingChangeRisk: boolean      // touches public interfaces?
  }
  acceptance: AcceptanceCriterion[]  // auto-generated + human-specified
  constraints: string[]              // extracted from conventions
  decomposable: boolean
  atomicTasks?: Task[]               // if decomposable
}
```

#### B. The Decomposition Engine

The hardest piece. Decomposition isn't just about size — it's about **risk isolation**. The right decomposition minimizes the blast radius of any individual task failing.

```
Goal: "Add OAuth2 support"

BAD decomposition (high coupling):
  Task A: Add OAuth2 to auth middleware
  Task B: Update all protected routes
  Task C: Add OAuth2 tokens to DB schema
  → All three need to land together or nothing works

GOOD decomposition (risk-isolated):
  Task A: Add OAuth2 token model + DB migration  ← isolated, reversible
  Task B: Add OAuth2 provider abstraction         ← isolated, no routes change
  Task C: Wire abstraction into middleware         ← depends on A+B
  Task D: Update routes to use new middleware      ← depends on C, largest blast radius
```

The planner reads the knowledge graph, understands the dependency boundaries, and produces decompositions that minimize coupling between tasks. Early versions will get this wrong often — the human reviews and corrects, and those corrections feed the learning loop.

#### C. The Execution Planner

For each atomic task, decides: how much context to include, what validation steps are needed, estimated turn count. Uses outcome history: *"tasks that touch the auth module with >3 file changes historically need 40 turns."*

-----

### Layer 3: The Quality Gate — Lint-Driven Development + Review Agent

Code quality is enforced through a layered validation system: deterministic lint checks first (cheap, fast), then an Opus-powered review agent (semantic, expensive), with a self-addressing feedback loop.

#### The Validation Loop

```
Agent writes code
    │
    ▼
Lint pass (fast, cheap, deterministic)
    │ ← failures go straight back to agent with exact errors
    ▼
Review agent (Opus — semantic analysis)
    │ ← structured comments go back to executing agent
    ▼
Agent addresses comments (round 1)
    │
    ▼
Re-review (diff-scoped — only changed files + previously flagged issues)
    │ ← if still failing: escalate to human
    ▼
PR opened (or human review if high-risk)
```

**Key principle:** Don't waste an Opus call reviewing code that has ESLint errors or type failures. Deterministic checks filter first. The review agent only sees code that's already mechanically clean.

#### What the Review Agent Checks

The review agent is scoped to things linters **can't** catch:

- Does this match the architectural patterns in the knowledge graph?
- Are there edge cases the tests don't cover?
- Does the error handling match the conventions?
- Is the abstraction level right — over/under-engineered?
- Does this change have unintended coupling to other modules?

Things linters already handle (formatting, naming conventions, import ordering, type errors) are **not** reviewed by the LLM.

#### Structured Review Output

```yaml
comments:
  - file: src/auth/middleware.ts
    line: 47
    severity: MUST_FIX
    category: error_handling
    comment: "OAuth token refresh failure is silently swallowed — should propagate to caller"
    suggested_fix: "Wrap in try/catch and throw AuthRefreshError"
  - file: src/auth/middleware.ts
    line: 82
    severity: NIT
    category: convention
    comment: "Other middleware files use early-return pattern, this uses nested if"
summary:
  must_fix: 1
  should_fix: 0
  nit: 1
  overall: "Functional but needs error handling fix before merge"
```

This structured output pipes directly into the executing agent's context. The agent gets file, line, severity, and suggested fix — it acts on a checklist, not prose.

#### Self-Addressing Loop Guardrails

- **Max 2 review rounds.** If not clean after two rounds, escalate to human. Three rounds of LLM-to-LLM negotiation is almost always wasted turns.
- **Comment severity drives action.** `MUST_FIX` blocks merge. `SHOULD_FIX` is addressed if straightforward. `NIT` is ignored by the loop — only surfaced in PR for human awareness.
- **Diff-scoped re-review.** Second pass only looks at what changed in response to comments + verifies original comments were addressed. Don't re-review the entire file.

#### Feeding the Learning Loop

Every review interaction generates signal:

- **Common review findings → context engine.** If the review agent keeps flagging "missing error handling in database calls," that becomes a convention the executing agent gets upfront. The review agent stops needing to catch it.
- **Failed self-addressing attempts.** Track which review comments agents can't fix correctly. These reveal genuine LLM capability gaps on your codebase and should stay in the review checklist permanently.
- **Review agent false positive rate.** If you're overriding >30% of review comments during human review, the review agent is miscalibrated. Tune or constrain it.

-----

### Layer 4: The Learning and Self-Improvement Loop

After every run, an Outcome Analyzer extracts signal:

```typescript
interface RunOutcome {
  // What happened
  specQuality: 'CLEAR' | 'AMBIGUOUS' | 'CONTRADICTORY'
  decompositionAccuracy: number       // predicted vs actual subtasks
  contextQuality: number              // did agent have what it needed?
  validationAccuracy: number          // did validation catch real bugs?

  // Effort tracking (not dollar costs — flat subscription)
  estimatedTurns: number
  actualTurns: number
  reviewRounds: number                // how many review-address cycles
  lintFailuresBeforePass: number      // how many lint iterations

  // Failure analysis
  failureMode?: 'LOOP' | 'MISSING_CONTEXT' | 'AMBIGUOUS_SPEC' |
                'BRITTLE_VALIDATION' | 'WRONG_DECOMPOSITION' | 'MODEL_LIMIT'
  failureDetail: string

  // Quality
  prMergedWithoutRevision: boolean    // THE flywheel metric
  humanReviewComments: number
  reviewAgentAccuracy: number         // % of review comments human agreed with
  testsAddedCovered: number
}
```

**Honest caveat:** The leap from "pattern detected" to "root cause identified" to "correct remediation task generated" is harder than it looks. Most failure modes are multicausal. Early versions will produce bad self-improvement suggestions. That's fine in a dogfooding context — the human triages, the good suggestions get executed, the bad ones get discarded, and over time the system learns which kinds of suggestions actually work.

Over time this builds a dataset. From that dataset, the system generates **self-improvement tasks**:

```
Pattern detected: "Tasks touching src/billing/** have 60% retry rate"
→ Human confirms root cause: "Billing module has no tests"
→ Generate task: "Add unit tests for billing module core functions"

Pattern detected: "OAuth-related tasks always need the auth architecture doc"
→ Auto-fix: "Add auth architecture reference to CLAUDE.md"

Pattern detected: "Review agent keeps flagging missing error handling in DB calls"
→ Add to executing agent's default context as a convention
```

Note: Early on, the human confirms root causes and approves self-improvement tasks. Over time, high-confidence patterns (like convention extraction) can auto-execute.

-----

## The Meta-Loop: forgectl Building forgectl

forgectl runs on its own repository. Its own codebase is the primary dogfood environment.

```
forgectl's own backlog
        │
        ▼
  Planner reads forgectl's knowledge graph
  (knows which modules are flaky, which have low test coverage,
   which validation steps fail most often)
        │
        ▼
  Generates tasks like:
  - "Retry state is lost on crash — persist to SQLite"
  - "Context engine doesn't understand TypeScript generics"
  - "Review agent false positive rate on validation code is 40%"
        │
        ▼
  forgectl executes these tasks on its own codebase
  (human reviews every PR, catches regression spirals)
        │
        ▼
  Results feed back into outcome history
        │
        ▼
  Better forgectl → better runs → better data → better self-improvement tasks
```

**The human is the validation layer.** A self-modifying system is dangerous when running unsupervised at scale. When the author is reviewing every PR, catching regression spirals early, and manually course-correcting — it's just an unusually tight feedback loop. Over time, oversight relaxes as confidence builds.

-----

## Near-Term: What's Already Built & What Needs Fixing

### What's solid today

- `TrackerAdapter` abstraction (Linear, GitHub, Notion)
- Dispatcher → Worker → Agent execution loop
- Docker-isolated agent execution (Claude Code, Codex, browser-use)
- Validation loop with retry + feedback
- SQLite persistence (runs, events, snapshots, governance)
- Governance gates (autonomy levels, approval workflows)
- Crash recovery with workspace persistence and re-dispatch
- Sub-issue DAG with cycle detection (3-color DFS)
- Webhook-driven cache invalidation + SubIssueCache invalidation fixes
- SSE real-time event stream
- Knowledge Graph with Merkle tree (import graph, test mapping, git coupling, convention mining)
- Context Engine v2 (budget-aware assembly, compression tiers, learning feedback)
- Task Specification format (YAML + Zod validation)
- Lint validation gate (deterministic checks before LLM review)
- Review agent with structured YAML output and self-addressing loop (max 3 rounds)
- DAG-aware scheduler with critical path dispatch
- Loop detector (halt + emit event before turns are wasted)
- Planner agent (KG → ExecutionPlan, module-boundary decomposition)
- Outcome Analyzer with self-improvement task generation
- Integrated review daemon (inline PR comments, approval workflow, quality tracking)
- Integrated merge daemon (auto-review + auto-merge across multiple repos)
- Per-issue repo routing (multi-repo support from single orchestrator)
- Stacked PR support (dependent issues target blocker's branch)
- Rich PR descriptions with ticket context
- GitHub App token auto-refresh
- Convention mining and injection (extract patterns from code, inject into agent context)
- Context learning feedback (track agent file access, boost relevance)
- Per-workspace KG builds for stacked diffs

### Three bugs fixed (Month 1)

| Bug | Status | Resolution |
|-----|--------|------------|
| CostRepository insertion gap | **Fixed** | Write to both tables at the same emission point |
| OneShotSession zero token reporting | **Fixed** | Parse Claude's output as authoritative source |
| Retry state in-memory | **Fixed** | Persist retry state to SQLite |

-----

## What's Been Built (as of March 2026)

Four months of development, driven by dogfooding on real projects. The system has gone from an execution engine to an autonomous software delivery engine.

### By the numbers

- ~30K LOC TypeScript source
- 100+ Linear issues completed autonomously (RAH-1 through RAH-102)
- 60+ PRs merged across 3 repos (forgectl, forge-test-api, forge-test-cli)
- Multi-repo orchestration tested with diamond DAGs up to 10 issues
- Review daemon tested with self-addressing loop

### Key subsystems shipped

**Knowledge Graph (src/kg/):** Regex-based parser builds an import graph, test mapping, and git coupling metrics. Merkle tree extension enables content hashing and incremental invalidation — only reparse files whose content hash changed. Per-workspace KG builds support stacked diffs where each workspace sees an overlay of its blocker's changes.

**Context Engine v2 (src/context/):** Budget-aware context assembly using Merkle tree node sizes. Three compression tiers: full file content, signatures + docstrings only, names only. Learning feedback tracks which files the agent actually reads and boosts their relevance for future runs.

**Convention Mining:** Extracts naming patterns, testing patterns, and error handling conventions directly from the codebase. Injects discovered conventions into agent context so the review agent doesn't need to catch what the executing agent already knows.

**Task Specification (src/task/):** First-class YAML format with Zod validation. Agents and humans can both author task specs. CLI scaffolding for new tasks.

**Planner Agent (src/planner/):** Reads the Knowledge Graph and produces an ExecutionPlan. Module-boundary decomposition strategy isolates risk by respecting import graph boundaries.

**Outcome Analyzer (src/analysis/):** Pattern detection from run history. Generates self-improvement tasks (e.g., "module X has high retry rate — add tests"). Review calibration tracking measures false positive rate over time.

**Review Daemon:** Integrated inline PR comments with severity levels. Approval workflow with quality tracking. Self-addressing loop: agent fixes review comments, pushes, re-reviews, max 3 rounds before escalation.

**Merge Daemon:** Auto-review + auto-merge across multiple repos. Coordinates with review daemon for quality gates.

**Multi-Repo Orchestration:** Per-issue repo routing from a single orchestrator instance. Stacked PR support where dependent issues target their blocker's branch. Rich PR descriptions with ticket context.

**Reliability:** Crash recovery with workspace persistence and re-dispatch. GitHub App token auto-refresh. SubIssueCache invalidation fixes for reliable DAG execution.

-----

## What the Execution Engine Still Needs

### 1. Task Specification Format

A first-class YAML format that agents and humans can both author:

```yaml
id: refactor-auth
title: "Refactor auth middleware"
context:
  files: ["src/auth/**", "test/auth/**"]
  docs: ["docs/auth-design.md"]
constraints:
  - "Must not break existing JWT flow"
  - "New API key path must pass rate limit tests"
acceptance:
  - run: "npm test -- --grep auth"
  - run: "npm run lint"
  - assert: "no files in src/auth modified except middleware.ts"
decomposition:
  strategy: auto        # auto | manual | forbidden
  max_depth: 2
effort:
  max_turns: 40
  max_review_rounds: 2
```

Committed to the repo. Agents can generate tasks as outputs. Enables the task queue to be code.

### 2. Context Engine

The single biggest quality lever. Bad context = bad code.

```
ContextEngine.buildFor(task, executionPlan):
  ├── Static context:
  │   ├── CLAUDE.md / AGENTS.md (project conventions)
  │   ├── Files explicitly listed in task spec
  │   └── Files planner identified as relevant
  ├── Semantic context (retrieved from knowledge graph):
  │   ├── Functions/classes referenced in task description
  │   ├── Tests for files that will change
  │   ├── Recent git blame: what changed and why
  │   └── Common review findings for affected modules
  ├── Dependency context:
  │   ├── Import graph of files that will change (1-hop)
  │   └── Public interface of modules the code calls into
  └── Compression:
      ├── Files >10KB: extract signatures + docstrings only
      ├── Test files: extract test names + assertions only
      └── Budget: total context ≤ 60K tokens
```

### 3. DAG-Aware Scheduler

The sub-issue DAG exists but isn't used for scheduling intelligence. Needed:

- Only surface issues whose entire `blocked_by` set is in `terminal_states`
- Compute critical path — which issues unblock the most downstream work
- Dispatch critical-path issues first
- Respect rate limit pool: prefer sequential execution when concurrent sessions would thrash the rate limit window (unlikely with Max 20x, but good to have)
- ~300 lines of TypeScript, directly leverages existing 3-color DFS

### 4. Loop Detector (before turns are wasted)

Detect agent stalls before turns are wasted:

```typescript
function detectAgentLoop(recentTurns: AgentTurn[]): LoopSignal | null {
  // Same file being written repeatedly
  const fileWrites = recentTurns.flatMap(t =>
    t.toolCalls.filter(c => c.name === 'write_file')
  );
  if (fileWrites.length >= 4 && new Set(fileWrites.map(w => w.input.path)).size <= 2) {
    return { kind: 'WRITE_LOOP', ... };
  }

  // Same validation error repeating unchanged
  const errors = recentTurns.map(t => t.validationSummary);
  if (errors.length >= 3 && errors.slice(-3).every(e => e === errors.at(-1))) {
    return { kind: 'VALIDATION_STALL', error: errors.at(-1) };
  }

  return null;
}
```

On a flat subscription, a looping agent doesn't waste money — it wastes **rate limit window**. Every wasted turn is a turn other tasks can't use. On detected loop: halt, post specific Linear comment, emit `LOOP_DETECTED` event.

### 5. Review Agent Integration

Wire the review agent into the existing validation loop:

```typescript
interface ReviewComment {
  file: string
  line: number
  severity: 'MUST_FIX' | 'SHOULD_FIX' | 'NIT'
  category: string
  comment: string
  suggestedFix?: string
}

interface ReviewResult {
  comments: ReviewComment[]
  summary: string
  passesReview: boolean  // true if no MUST_FIX comments
}
```

The review agent runs as a Claude Code invocation with the diff, affected files, and knowledge graph context. Its structured output feeds back into the executing agent's next turn. Max 2 review-address rounds before escalation.

### 6. Workflow Definition Format

Multi-step, multi-agent workflows:

```yaml
name: feature
steps:
  - name: plan
    prompt_template: plan
    outputs: [execution_plan]

  - name: implement
    depends_on: [plan]
    context_from: plan.contextFiles
    effort: { max_turns: 40 }

  - name: lint
    depends_on: [implement]
    type: deterministic            # not an LLM step
    run: ["npm run lint", "npm run typecheck"]

  - name: review
    depends_on: [lint]
    prompt_template: code_review
    max_rounds: 2

  - name: self_address
    depends_on: [review]
    only_if: "review.mustFixCount > 0"
    context_from: review.comments

  - name: final_review
    depends_on: [self_address]
    prompt_template: code_review
    scope: diff_only              # only review changes from self_address
    gate: { autonomy: interactive }  # escalate to human if still failing
```

The `pipeline_runs` table with `nodeStates` JSON is already the right persistence shape for this.

### 7. Crash Recovery Upgrade

Currently marks interrupted runs but doesn't re-execute.

**Phase 1 (pragmatic, ~2 days):** On recovery, post a Linear comment ("Run interrupted at phase `after:execute` — branch exists. Requeueing with existing workspace."), then re-dispatch using persisted workspace. Agent gets partial work as context.

**Phase 2 (when justified):** Temporal. Each phase becomes a Temporal Activity with heartbeating. Checkpoints (`after:prepare`, `after:execute`, `after:validate`, `after:output`) map to Temporal Activity boundaries. Only build this when crash frequency justifies the infrastructure.

-----

## Outcome Tracking: Log Everything From Day One

**Critical:** Start logging every run outcome immediately, even before the Outcome Analyzer exists. Dump it into a SQLite table:

```sql
CREATE TABLE run_outcomes (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  status TEXT,              -- 'success' | 'failure' | 'escalated' | 'loop_detected'
  total_turns INTEGER,
  lint_iterations INTEGER,
  review_rounds INTEGER,
  review_comments_json TEXT, -- full structured review output
  failure_mode TEXT,
  failure_detail TEXT,
  human_review_result TEXT,  -- 'rubber_stamp' | 'minor_changes' | 'major_rework' | 'rejected'
  human_review_comments INTEGER,
  modules_touched TEXT,      -- JSON array
  files_changed INTEGER,
  tests_added INTEGER,
  raw_events_json TEXT       -- full event log for later analysis
);
```

The hardest part of building a learning system is not having enough historical data when you're ready to learn from it. Six months of outcome data sitting in this table will be invaluable when the Outcome Analyzer comes online.

-----

## The Flywheel

```
More runs
    │
    ▼
Richer knowledge graph + review history
    │
    ▼
Better planning + context + fewer review findings
    │
    ▼
Fewer failures, fewer turns per task
    │
    ▼
Higher percentage of rubber-stamp PRs
    │
    ▼
More runs you trust to run autonomously
    │
    ▼
More runs  ←──── (loop)
```

The flywheel metric: **percentage of tasks where your review is a rubber stamp.** When that crosses ~70%, the system is working. Everything before that is infrastructure investment.

-----

## Competitive Landscape & Market Gap

| Product | Type | Self-hosted | Learning loop | Multi-agent | Governance | Review agent |
|---------|------|-------------|---------------|-------------|------------|--------------|
| Devin | Cloud agent | ✗ | ✗ | ✗ | ✗ | ✗ |
| Copilot Workspace | Cloud tool | ✗ | ✗ | ✗ | ✗ | ✗ |
| Codex (OpenAI) | Cloud agent | ✗ | ✗ | ✗ | ✗ | ✗ |
| Cursor / Aider | Assistant | ✗ | ✗ | ✗ | ✗ | ✗ |
| **forgectl (today)** | **Autonomous engine** | **✓** | **✓** | **✓** | **✓** | **✓** |

*Note: This table reflects what's shipped as of March 2026. Competitors are also evolving fast. The gap is real but not permanent — execution speed matters.*

**Target customer (eventual):** Technical founders and small engineering teams (2–5 engineers) who want 10–50x output without 10–50x headcount. The self-hosted angle solves the data privacy problem that blocks cloud coding agents from touching production codebases.

**Business model (eventual):** Open-source core (execution engine, tracker adapters, validation loop). Paid cloud for teams who don't want to self-host. Knowledge graph + learning loop as the moat — they accumulate value on your specific codebase over time.

-----

## Roadmap

*Timeline is approximate. Priorities emerge from real usage. Expect rewrites.*

### Month 1 — Foundation + Observability

- [x] Fix token reporting (OneShotSession zero tokens)
- [x] Fix effort data insertion gap (write to both tables)
- [x] Persist retry state to SQLite
- [x] **Outcome logging table — log everything from day one**
- [x] Codebase Knowledge Graph v1 (regex parser, import graph, test mapping, git coupling)
- [x] Task Specification format (YAML + Zod + CLI)

### Month 2 — Quality Gate

- [x] Lint-driven validation (deterministic checks run first)
- [x] Review agent v1 (structured YAML output, severity levels)
- [x] Self-addressing comment loop (max 2 rounds, diff-scoped re-review)
- [x] DAG-aware scheduler (critical path first)
- [x] Loop detector (halt + emit event before turns are wasted)

### Month 3 — Planning Layer

- [x] Context Engine v2 (Merkle tree, budget-aware assembly, compression tiers)
- [x] Planner agent v1 (knowledge graph → ExecutionPlan)
- [x] Decomposition engine v1 (module-boundary strategy — expect rewrites)
- [x] Review findings → context engine feedback loop

### Month 4 — Learning Loop

- [x] Outcome Analyzer v1 (pattern detection from run history)
- [x] Self-improvement task generation (human-confirmed root causes)
- [x] Review agent calibration tracking (false positive rate)
- [x] forgectl running on forgectl (the meta-loop begins — human reviews all PRs)

### Month 5–6 — Hardening

- [x] Crash recovery upgrade (re-dispatch with persisted workspace)
- [ ] Workflow definition format (multi-step pipelines)
- [x] Convention extraction from codebase (mine patterns from code, inject into agent context)
- [ ] Decomposition engine v2 (informed by 4 months of outcome data)

### Month 7+ — If Productizing

- [ ] Web UI (run dashboard, approval queues, effort graphs)
- [ ] Multi-repo support
- [ ] Team features (shared task queues, approval workflows)
- [ ] Cross-repo knowledge (shared patterns across projects)

-----

## The Single Most Important Insight

**The knowledge graph is the moat.**

Cloud coding agents can't have it. Generic tools can't have it. A system that has run 500 tasks on your codebase knows things about it that no other tool does.

That knowledge makes every subsequent run faster and higher quality. It's compounding value that grows with every run, on your specific codebase, that no competitor can replicate without your history.

Build the knowledge graph first. Log outcomes from day one. Everything else follows.

-----

*Updated March 2026*
*Incorporates: Max 20x subscription model, Opus-everywhere execution, lint-driven development with review agent, dogfood-first development approach, honest assessment of research-hard problems.*
*Months 1–4 complete. Knowledge Graph, Context Engine v2, Planner, Review/Merge daemons, Outcome Analyzer all shipped and running.*
