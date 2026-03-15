# Feature Research

**Domain:** LLM-driven task decomposition, lightweight agent runtimes, rate limit resilience, run outcome learning — forgectl v5.0 Intelligent Decomposition
**Researched:** 2026-03-14
**Confidence:** MEDIUM-HIGH (WebSearch verified against official repos and multiple credible sources; training data cross-checked)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features the forgectl operator assumes exist once "intelligent decomposition" is the milestone goal. Missing these makes the milestone incoherent.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| LLM planner produces structured sub-task list | Decomposition is meaningless without a machine-readable output; a flat JSON list of titled, described, atomic tasks is the minimum | MEDIUM | Must use structured output / tool-call schema — no regex parsing of freeform prose; each task needs `{id, title, description, files_hint[], depends_on[]}` |
| Each sub-task maps to one agent invocation | Users expect atomicity — one sub-task, one agent, one branch; not a planner that dumps everything on a single agent | MEDIUM | "Atomic" = completable in one session without coordinating with another agent; planner must enforce this constraint in its prompt |
| Sub-tasks capture dependency edges (DAG) | Without topological ordering, parallel agents step on each other immediately | MEDIUM | `depends_on: [id, id]` syntax; forgectl already has pipeline DAG executor — sub-task DAG feeds into it directly |
| Human approval gate before dispatch | Any non-trivial decomposition needs sign-off before spawning N agents; users who have used governance already expect this pattern | LOW | Maps to existing `governance` autonomy `semi` or `supervised`; slash-command `/approve-decomposition` in GitHub App (already built) |
| Single-agent fallback when decomposition is declined | If human declines or quality check fails, the issue must still make progress | LOW | Fallback is a dispatcher mode toggle; no new subsystems — just skip decomposition and dispatch original issue |
| Sub-task failure re-planning | When a sub-task fails, users expect a decision point: re-plan remaining work or just retry the failed node | HIGH | Two distinct behaviors; requires a feedback loop back to the planner with failure context; planner must be callable mid-run, not just once upfront |
| Anthropic 429 detection and scheduled retry | Claude API returns `Retry-After` on 429; users expect the orchestrator to park the issue and resume automatically, not crash | LOW | HTTP 429 + `Retry-After` header is well-documented; scheduling a resume at the right wall-clock time is the new part |
| Workspace preserved across rate-limit suspension | If an agent is mid-execution when rate-limited, workspace state must survive the suspension window | MEDIUM | Forgectl already has crash-recovery and workspace lifecycle (v2.0); wire rate-limit pause into the same code path |

### Differentiators (Competitive Advantage)

Features that make forgectl's decomposition mode meaningfully better than manually creating sub-issues or using ComposioHQ's agent-orchestrator.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Decomposition quality scoring before dispatch | Validate planner output against heuristics: task count bounds, file-scope overlap, dependency cycle detection — before any agent runs | MEDIUM | Score prevents pathological decompositions (50 sub-tasks for a 20-line fix) without requiring human review every time; score gates auto-approve vs prompt for review; cycle detection DFS already built in pipeline DAG validator |
| Worktree runtime alongside Docker runtime | Docker overhead (image pull + container start) adds 10-30s per spawn; worktree runtime gives sub-1s spawn for trusted in-repo sub-tasks | HIGH | ComposioHQ agent-orchestrator uses worktrees natively (confirmed via GitHub); Docker remains for untrusted/external work; runtime choice lives in WORKFLOW.md, not in the planner |
| Rate-limit-aware concurrency throttling | When a 429 is received, back-pressure the entire slot manager — not just the failed agent — to avoid all N concurrent agents hitting the limit simultaneously | MEDIUM | Shared counter across active sessions; existing slot manager is the right hook point; prevents the "$1.6M weekend" runaway loop documented in production post-mortems |
| Re-plan vs re-execute decision after failure | Feed failure output back to the planner and ask "does this failure mean the plan is wrong?" — planner can re-decompose remaining nodes rather than blindly retrying | HIGH | This is the "stateful orchestration with error-handling branches" ComposioHQ describes; most systems only retry, never re-plan; key differentiator for complex multi-file issues |
| Early merge conflict detection across worktrees | When N agents modify overlapping files in parallel, conflicts surface only at merge without proactive detection; scheduled `git merge-tree` scan across active worktrees catches them early | HIGH | `clash-sh/clash` uses `git merge-tree` (via gix) across worktree pairs without modifying the repo; forgectl can run this as a reconciliation check on a schedule |
| Run outcome learning — persist what worked | After each run, extract structured lessons: which decomposition shapes succeeded, which file patterns caused failures, which approaches hit dead-ends — store as playbook hints for future prompts | HIGH | Inspired by greyhaven-ai/autocontext; fills the "Layer 3 belief extraction" gap that no production coding agent tool has fully shipped; even simple pattern logging gives compounding ROI across runs |
| Dead-end detection and blacklisting | If an agent loops on the same file/approach across retries, detect the pattern and annotate the issue with "dead-end context" to inject into the next attempt's system prompt | HIGH | Prevents the runaway loop failure mode; must be coupled with hard iteration caps; requires loop pattern recognizer on top of flight recorder events |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Recursive decomposition (sub-tasks decompose further) | "Let the planner keep breaking things down until trivially small" | Exponential node explosion; cycle risk increases with depth; coordination overhead grows faster than parallelism benefit | Cap at one level: parent issue → atomic sub-tasks; if a sub-task is still too large, flag it for human split rather than auto-recurse |
| Fully automatic decomposition with no human gate | Speed — skip the approval step | Pathological decompositions spawn 50 agents before anyone notices; wasted tokens + merge disaster | Default to `semi` autonomy for decomposition; auto-approve only when quality score exceeds threshold AND issue is labeled `auto-decompose` |
| LLM chooses runtime per sub-task (worktree vs Docker) | "The planner knows best" | LLM hallucination on runtime choice bypasses the security boundary; worktree shares host filesystem, Docker doesn't — this is a trust decision, not a planning decision | Runtime is set by the workflow definition (`runtime: worktree | container`), never by the planner |
| Cross-run learning that auto-modifies agent behavior globally | "Make every future run smarter automatically" | Poisoned playbooks (one bad run contaminates all future runs); no rollback path; subtle quality degradation is hard to detect | Outcome learning is additive and reviewed before promotion; weak signals stay in draft state until a curator step confirms |
| Merge-on-success auto-squash of all sub-task branches | "Just merge everything when done" | Conflicts surface at worst possible moment (all N branches at once); no rollback granularity if one branch has a problem | Merge sequentially in topological order after each sub-task passes validation; stop on first conflict and surface it |

---

## Feature Dependencies

```
[LLM planner — structured JSON output]
    └──requires──> [Structured output schema (JSON tool-call)]
    └──feeds──> [Decomposition quality scoring]
                    └──requires──> [Cycle detection DFS — already in pipeline DAG validator]
                    └──requires──> [File-scope overlap heuristic (new)]
                    └──gates──> [Human approval OR auto-approve]
                                    └──gates──> [Sub-task dispatch]

[Sub-task dispatch]
    └──requires──> [LLM planner produces sub-task list]
    └──requires──> [Approval gate result]
    └──branches──> [Worktree runtime] OR [Container runtime]

[Worktree runtime]
    └──requires──> [git worktree create/cleanup lifecycle]
    └──requires──> [Process spawn — no dockerode]
    └──hooks──> [Workspace manager (already exists)]

[Parallel sub-task execution]
    └──requires──> [Sub-task dispatch]
    └──requires──> [Pipeline DAG executor (already built) — sub-task DAG as input]
    └──enhances──> [Early conflict detection across worktrees]

[Re-plan feedback loop]
    └──requires──> [Sub-task failure detection]
    └──requires──> [LLM planner callable mid-run (not just upfront)]
    └──requires──> [Failure context serialization to inject into planner prompt]

[Rate limit detection + scheduled retry]
    └──requires──> [HTTP 429 / Retry-After parsing in agent adapter]
    └──requires──> [Workspace preservation on suspend (crash-recovery path — already built)]
    └──enhances──> [Rate-limit-aware slot manager throttling]

[Run outcome learning]
    └──requires──> [Flight recorder (already built — append-only event log)]
    └──requires──> [SQLite storage (already built)]
    └──requires──> [Structured lesson schema (new table)]
    └──enhances──> [Re-plan feedback loop (lessons feed future planner prompts)]
    └──enables──> [Dead-end detection]

[Dead-end detection]
    └──requires──> [Flight recorder]
    └──requires──> [Loop pattern recognizer (retry count + file fingerprint)]
    └──enhances──> [Run outcome learning (dead-end = lesson type)]
```

### Dependency Notes

- **Worktree runtime is the unblocking dependency for fast sub-task spawning.** Without it, Docker startup overhead makes parallel decomposition slower than single-agent for small issues. This is a required P1.
- **Quality scoring must precede the human gate.** The gate needs a score to show the operator; blind approval requests get ignored.
- **Re-plan loop requires planner to be callable mid-run.** Planner cannot be a one-shot step; it must accept partial results and failure context as inputs.
- **Rate limit retry must reuse workspace preservation code.** Building a second persistence path creates inconsistency. The crash recovery path (v2.0) already handles workspace state — extend it with a `rate_limited` suspend state.
- **Run outcome learning depends on flight recorder.** The event log is the raw signal source; learning adds a distillation step on top of existing infrastructure.
- **Dead-end detection depends on outcome learning schema being defined first.** Dead-end is a lesson type, not a separate concept.

---

## MVP Definition

This is a subsequent milestone on a mature (v3.0) system. "MVP" = the smallest set that makes v5.0 coherent and valuable.

### Launch With (v5.0 core)

- [ ] **LLM planner with structured JSON output** — without this, nothing else can be built; must produce `{id, title, description, files_hint[], depends_on[]}` per sub-task via tool-call schema
- [ ] **Decomposition quality scoring** — cycle detection + task count bounds + file-scope overlap; gates auto-approve vs human review; prevents pathological outputs before any agent runs
- [ ] **Human approval gate + single-agent fallback** — integrates with existing governance system; decline = fallback dispatch to single agent; approval via existing slash-command infrastructure
- [ ] **Worktree runtime** — `git worktree add`, process-based agent spawn, cleanup on completion; enables sub-1s spawn without Docker overhead
- [ ] **Parallel sub-task execution with branch-per-node** — each sub-task gets its own branch; sub-task DAG fed into existing pipeline DAG executor; topological merge order after validation
- [ ] **Rate limit detection with scheduled retry** — 429 + `Retry-After` parsing in agent adapter; suspend workspace; schedule resume; back-pressure slot manager
- [ ] **Re-plan vs re-execute on sub-task failure** — feed failure output back to planner; planner decides whether to re-decompose remaining nodes or just retry the failed one

### Add After Validation (v5.x)

- [ ] **Early merge conflict detection** — add after worktree runtime is stable; scheduled `git merge-tree` scan across active worktrees; borrowing clash pattern
- [ ] **Run outcome learning (basic)** — structured lesson append after run completes; feed lessons into future planner prompts; add after decomposition loop is stable and generating outcome data
- [ ] **Dead-end detection and blacklisting** — add after outcome learning schema is defined; loop pattern recognizer on top of flight recorder events

### Future Consideration (v6+)

- [ ] **Full curator loop (autocontext-style)** — multi-role learning pipeline (Competitor/Analyst/Coach/Curator); sophisticated but requires stable outcome data corpus first; greyhaven-ai/autocontext is the reference implementation
- [ ] **Cross-run playbook promotion with human review** — governance workflow for promoting draft lessons to canonical playbook; defer until enough lessons accumulate to warrant the UX investment

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Existing Subsystem |
|---------|------------|---------------------|----------|--------------------|
| LLM planner (structured JSON output) | HIGH | MEDIUM | P1 | Agent adapters, context builder |
| Decomposition quality scoring | HIGH | LOW | P1 | Pipeline DAG validator (reuse DFS) |
| Human approval gate (decomposition type) | HIGH | LOW | P1 | Governance state machine (already built) |
| Single-agent fallback | HIGH | LOW | P1 | Dispatcher (already built) |
| Worktree runtime | HIGH | HIGH | P1 | Workspace manager, workspace hooks |
| Parallel sub-task execution | HIGH | HIGH | P1 | Pipeline DAG executor, slot manager |
| Rate limit detection + scheduled retry | HIGH | MEDIUM | P1 | Agent adapters, workspace lifecycle |
| Re-plan feedback loop | HIGH | HIGH | P1 | Planner (mid-run callable) |
| Rate-limit-aware slot throttling | MEDIUM | LOW | P2 | Slot manager (already built) |
| Early merge conflict detection | MEDIUM | HIGH | P2 | Worktree runtime (P1 dependency) |
| Run outcome learning (basic) | MEDIUM | MEDIUM | P2 | Flight recorder, SQLite (already built) |
| Dead-end detection | MEDIUM | MEDIUM | P2 | Flight recorder, outcome learning |
| Full curator loop | LOW | HIGH | P3 | Outcome learning (P2 dependency) |

**Priority key:**
- P1: Must have for v5.0 — milestone is incoherent without it
- P2: Should have — adds compounding value, builds on P1 foundation
- P3: Deferred until P2 data validates the need

---

## Existing Subsystem Integration Map

Key v3.0 subsystems that v5.0 features wire into, not replace:

| v5.0 Feature | Existing Subsystem | Integration Point |
|---|---|---|
| LLM planner | `src/agent/` adapters | New `DecompositionAgent` invocation mode; uses Claude Code adapter with structured output (tool-call) prompt |
| Quality scoring | `src/pipeline/` DAG validator | Reuse cycle-detection DFS; add task-count bounds and file-scope overlap heuristics alongside existing logic |
| Human approval gate | `src/governance/` approval state machine | New approval type `decomposition`; slash-command `/approve-decomposition` via existing GitHub App |
| Single-agent fallback | `src/orchestrator/` dispatcher | Mode toggle: decomposition declined → dispatch original issue via existing single-agent path |
| Worktree runtime | `src/workspace/` WorkspaceManager | New runtime path: `git worktree add` + process spawn instead of `dockerode` container create |
| Parallel execution | `src/pipeline/` DAG executor | Sub-task DAG is a pipeline; each node dispatched to worktree or container via runtime selection |
| Rate limit retry | `src/agent/` adapters + `src/orchestrator/` scheduler | Detect 429 in adapter; signal scheduler to suspend + re-enqueue at `Retry-After` wall-clock time |
| Workspace suspension | `src/workspace/` + `src/storage/` | Extend crash-recovery path with new `rate_limited` suspend state; workspace already persists across container stops |
| Re-plan loop | `src/orchestrator/` dispatcher + planner | Post-failure hook: invoke planner with failure context; replace remaining DAG nodes with re-planned sub-tasks |
| Outcome learning | `src/flight-recorder/` + `src/storage/` | New `lessons` table in SQLite; flight recorder events are raw input; distillation runs as a post-run job |
| Dead-end detection | `src/flight-recorder/` | Retry-count + file-fingerprint pattern matcher runs as a reconciliation check on the existing reconciler schedule |

---

## Competitor Feature Analysis

| Feature | ComposioHQ/agent-orchestrator | greyhaven-ai/autocontext | forgectl v5.0 Approach |
|---------|-------------------------------|--------------------------|------------------------|
| Task decomposition | Agent decides internally; no explicit planner output schema; orchestrator reads backlog and spawns agents (confirmed via GitHub README) | Not decomposition-focused; targets run-to-run learning | Explicit planner with structured JSON output + quality scoring gate; forgectl retains control of the plan shape |
| Runtime | Git worktree exclusively; no Docker fallback | N/A (strategy learning, not execution) | Dual runtime: worktree for trusted in-repo sub-tasks, container for untrusted; WORKFLOW.md chooses, not the planner |
| Validation gate | CI-based (GitHub Actions results); reaction-based escalation | Staged validation with curator gating; weak changes rolled back | Existing forgectl validation loop + new decomposition quality score gate before any agent runs |
| Failure handling | Reaction-based: ci-failed → auto-retry; changes-requested → re-run; escalation timeout | Competitor/Analyst/Coach/Curator roles; weak strategies not promoted | Re-plan vs re-execute decision; planner ingests failure context and chooses whether plan or execution was wrong |
| Outcome learning | Not present | Full multi-role learning loop; production-grade for strategy distillation | Start simple: structured lesson append (basic); evolve toward curator loop once outcome data accumulates |
| Human approval | Not present in orchestrator | Human review before playbook promotion | Governance state machine with slash-command approval; quality score gates auto-approve |
| Conflict detection | Not present | N/A | Scheduled `git merge-tree` across active worktrees; borrowing the clash pattern |
| Rate limit handling | Not documented | N/A | 429 detection + `Retry-After` scheduling + slot manager back-pressure |

---

## Sources

- [ComposioHQ/agent-orchestrator — GitHub](https://github.com/ComposioHQ/agent-orchestrator) — worktree runtime pattern, CI-based validation, reaction-based failure handling; planner is implicit in agent, not explicit
- [greyhaven-ai/autocontext — GitHub](https://github.com/greyhaven-ai/autocontext) — outcome learning architecture (Competitor/Analyst/Coach/Curator roles), playbook persistence, staged validation with rollback
- [Composio Open Sources Agent Orchestrator — MarkTechPost](https://www.marktechpost.com/2026/02/23/composio-open-sources-agent-orchestrator-to-help-ai-developers-build-scalable-multi-agent-workflows-beyond-the-traditional-react-loops/) — planner/executor split rationale, stateful orchestration with error-handling branches
- [Git worktrees for parallel AI coding agents — Upsun Developer Center](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — worktree mechanics, shared resource pitfalls (ports, DB, Docker namespace)
- [Every AI Agent Tool Creates Git Worktrees — Medium](https://medium.com/@rohansx/every-ai-agent-tool-creates-git-worktrees-none-of-them-make-worktrees-actually-work-76d8f367e2c8) — practical failure modes: port conflicts, database collisions, Docker namespace clobber
- [clash-sh/clash — GitHub](https://github.com/clash-sh/clash) — `git merge-tree`-based early conflict detection across worktrees without modifying the repo
- [LLM Tool-Calling in Production — Medium](https://medium.com/@komalbaparmar007/llm-tool-calling-in-production-rate-limits-retries-and-the-infinite-loop-failure-mode-you-must-2a1e2a1e84c8) — $1.6M runaway loop failure mode, rate limit blast radius in agentic systems
- [The Memory Problem in AI Agents Is Half Solved — Medium](https://medium.com/data-unlocked/the-memory-problem-in-ai-agents-is-half-solved-heres-the-other-half-ebbf218ae4d5) — three-layer memory model; Layer 3 (belief extraction) gap confirmed as unshipped in production tools
- [LLM Agent Task Decomposition Strategies — apxml.com](https://apxml.com/courses/agentic-llm-memory-architectures/chapter-4-complex-planning-tool-integration/task-decomposition-strategies) — planner-executor pattern, DAG output format, atomic sub-task definition
- [Task Decomposition for Coding Agents — MGX Dev](https://mgx.dev/insights/task-decomposition-for-coding-agents-architectures-advancements-and-future-directions/a95f933f2c6541fc9e1fb352b429da15) — activity-on-vertex DAG, dynamic refinement, parallel execution patterns
- [Agents At Work: 2026 Playbook — promptengineering.org](https://promptengineering.org/agents-at-work-the-2026-playbook-for-building-reliable-agentic-workflows/) — deterministic pre/post-event validation gates; quality gate as standard pattern in 2026
- [Rate Limiting and Backpressure for LLM APIs — dasroot.net](https://dasroot.net/posts/2026/02/rate-limiting-backpressure-llm-apis/) — backpressure patterns, Retry-After header behavior, sliding window approach
- [Long-Running AI Agents and Task Decomposition 2026 — Zylos Research](https://zylos.ai/research/2026-01-16-long-running-ai-agents) — workspace preservation patterns for rate-limit suspension

---

*Feature research for: forgectl v5.0 Intelligent Decomposition*
*Researched: 2026-03-14*
