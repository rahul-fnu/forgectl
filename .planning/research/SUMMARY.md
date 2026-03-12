# Project Research Summary

**Project:** forgectl v2.1 Autonomous Factory
**Domain:** Multi-agent orchestration, conditional/loop pipeline execution, pipeline self-correction
**Researched:** 2026-03-12
**Confidence:** HIGH

## Executive Summary

forgectl v2.1 adds three tightly coupled capabilities to the existing v2.0 Durable Runtime: multi-agent delegation (a lead agent decomposes an issue and dispatches child workers), conditional/loop pipeline nodes (if/else branches and loop-until iteration in YAML-defined pipelines), and pipeline self-correction (a pipeline-level test-fail-fix-retest feedback loop distinct from the existing in-container validation loop). Research confirms that all three features are implementable with exactly one new npm dependency (`filtrex` ^3.1.0 for safe expression evaluation) and targeted extensions to existing subsystems. The v2.0 architecture — `executeWorker`, `PipelineExecutor`, `SlotManager`, SQLite/Drizzle storage, and `GovernanceSystem` — provides the correct primitives for all three features without requiring new frameworks or infrastructure.

The recommended build order is driven by hard dependencies: the SQLite schema migration must land first (all other work depends on it), followed by conditional pipeline node support (which loop nodes build on), followed by loop nodes (which self-correction pipelines compose), and delegation (which is architecturally independent of pipeline changes but shares the same schema migration). Self-correction is not a new subsystem — it is an integration milestone proving that loop nodes plus context piping produce the test-fail-fix-retest pattern. The industry-standard orchestrator-worker pattern (Anthropic, AWS, Azure AI guidance) maps directly onto forgectl's existing `dispatchIssue`/`executeWorker` machinery with minimal wiring changes.

The highest-severity risks are slot budget exhaustion (children contending with leads for global slots), workspace contamination between concurrent child agents, and the "loop of death" (self-correction without a hard iteration cap). All three are preventable with upfront design decisions: a two-tier slot pool, per-child isolated workspaces via subdirectories or Git worktrees, and a mandatory `max_iterations` field with no default. A secondary risk is that the existing static-DAG topological sort in `PipelineExecutor` must be refactored to a ready-queue model to support conditional branch skipping at runtime — this is a meaningful executor refactor, not a cosmetic change.

## Key Findings

### Recommended Stack

The v2.0 stack is entirely validated and carries forward unchanged. v2.1 adds a single new production dependency: `filtrex` ^3.1.0, a sandboxed boolean expression evaluator used for conditional node guard expressions and loop termination conditions. `filtrex` was chosen over alternatives (`jexl`, `expr-eval`, `node:vm`) because it is truly sandboxed (no process/global access), never throws on expression execution (returns an error value instead), is boolean-first by design, ships zero transitive dependencies, and has full ESM + TypeScript declarations compatible with the project's `"type": "module"` configuration. Multi-agent delegation and pipeline self-correction require no new libraries — they are implemented entirely using existing `executeWorker`, `SlotManager`, Drizzle ORM, and `runValidationLoop` primitives.

**Core technologies:**
- `filtrex` ^3.1.0: safe expression evaluation for conditional/loop node DSL — only truly sandboxed evaluator with ESM support, zero deps, and boolean-first design
- Drizzle ORM + better-sqlite3 (existing): schema extension for `delegations` table and `parentRunId`/`role`/`depth` columns on `runs` — self-referential FK pattern verified in Drizzle docs
- Zod (existing): validation for delegation manifest JSON, new `delegation:` WORKFLOW.md block, and new PipelineNode fields
- `picomatch` (existing): injected as a custom function into `filtrex` evaluation context for `matches(str, pattern)` expressions

**What NOT to add:**
- `xstate`: delegation state machine has 5 states, a TypeScript discriminated union is sufficient
- `p-limit`: child concurrency is controlled by the existing `SlotManager`, not a second primitive
- `vm2`: abandoned in 2023 after critical vulnerabilities
- `jexl`: last published 2020, async-first (unnecessary overhead), depends on `@babel/runtime`
- Any LLM SDK (LangChain, Vercel AI, etc.): forgectl agents are subprocess CLI invocations, not API clients
- Any workflow engine (Temporal, Conductor, Airflow): all require separate server infrastructure; in-process SQLite state is sufficient

### Expected Features

**Must have (P1 — table stakes for v2.1):**
- Lead agent produces structured subtask list (JSON manifest in stdout, sentinel-delimited) — delegation only works with structured output
- Child workers dispatched concurrently up to slot limit — parallelism is the primary ROI of multi-agent (Anthropic: 90% time reduction with 3-5 parallel subagents)
- `maxChildren` budget cap and `depth <= 2` enforcement in code, not just prompt instructions
- SQLite `parentRunId`/`depth` columns on `runs` table — parent/child relationships must survive daemon restarts
- `condition` field on `PipelineNode` with safe `filtrex` expression evaluator
- `loop` field with required `max_iterations` (no default) — cap enforced before condition is checked
- Failure output piped as context to fix node — without this, the fix agent cannot know what to fix
- Fix node `exclude` list guard for test files — agents take path of least resistance and weaken tests (confirmed anti-pattern)

**Should have (P2 — add after P1 validated):**
- Child failure retry with updated lead instructions
- `if_failed` / `if_passed` shorthand (syntactic sugar reducing to condition expression)
- Loop iteration count exposed in status API and dashboard
- Lead agent synthesis call (one final summary from all child results)
- Self-correction history accumulation across iterations in fix prompts

**Defer (P3 / v2.2+):**
- Lead creates sub-issues in GitHub/Notion tracker — requires `TrackerAdapter.createIssue()` not yet in interface
- Multi-trigger self-correction (lint + test + coverage in one composed loop)
- Governance gate per loop iteration (per-iteration approval flow)
- Parallel alternative fix attempts (anti-feature: creates merge conflicts)

### Architecture Approach

v2.1 extends three existing subsystems rather than introducing new ones. The `PipelineExecutor` gains three new node handlers (`executeConditionalNode`, `executeLoopNode`, and the existing `executeTaskNode` via type dispatch in `executeNode`). The core scheduling loop must move from a pre-computed topological order to a ready-queue model where nodes are scheduled only when all their dependencies complete and any conditional guard evaluates true. The Orchestrator gains a new `DelegationManager` component (`src/orchestrator/delegation.ts`) that parses lead agent stdout for a sentinel-delimited delegation manifest, validates it with Zod, and dispatches child workers via a child-scoped slot pool. Self-correction is a composition pattern (loop nodes + context piping) with no new files beyond integration tests.

**Major new and modified components:**
1. `src/orchestrator/delegation.ts` (NEW) — `DelegationManifest` Zod schema, manifest parser, `delegateSubtasks()`, `waitForChildren()`, child slot budget enforcement
2. `src/pipeline/condition.ts` (NEW) — Expression evaluator for `{{node.field}} op value` patterns using `filtrex`, under 100 lines
3. `src/storage/repositories/delegations.ts` (NEW) — CRUD for the new `delegations` table
4. `src/pipeline/executor.ts` (MODIFIED) — ready-queue scheduling model, `executeConditionalNode()`, `executeLoopNode()` with iteration checkpointing
5. `src/storage/schema.ts` (MODIFIED) — `delegations` table; `parentRunId`, `role`, `depth` columns on `runs`

**Key patterns to follow:**
- Depth guard at `dispatchIssue()` level in code (not just system prompt instruction to the agent)
- Sentinel-delimited manifest protocol (`---DELEGATE--- ... ---END-DELEGATE---`) — robust to agent explanation text surrounding the JSON
- Static DAG with dynamic branch skipping (all nodes declared in YAML, executor marks non-taken branches as `skipped`)
- Opaque loop meta-node (outer DAG sees a single `loop` node; inner mini-executor manages iterations with `max_iterations` hard cap)
- Children dispatched after lead's `executeWorker()` returns — no concurrent workspace access between lead and children

### Critical Pitfalls

1. **Slot budget exhaustion (children eat parent's slots)** — The existing single-pool `SlotManager` causes deadlock: lead holds 1 slot, dispatches children that contend for remaining slots. Prevention: two-tier slot system with child slots pre-reserved at lead dispatch time. Children draw only from the reserved child pool.

2. **Parent/child relationships lost on daemon restart** — `OrchestratorState` is in-memory; the existing crash recovery has no concept of parent/child runs. Prevention: `parentRunId`, `depth`, `maxChildren`, `childrenDispatched` columns in `runs` table before any delegation code is written. `DelegationRepository.claimChildSlot()` must be atomic (`UPDATE WHERE children_dispatched < max_children`).

3. **Workspace contamination between concurrent child agents** — `WorkspaceManager.ensureWorkspace(issue.identifier)` returns the same path for all children of the same issue. Prevention: each child gets an isolated subdirectory `{issueWorkspace}/children/{childId}/` or a Git worktree (Git worktree is the pattern used by parallel agent tools in 2025).

4. **Conditional branch evaluation breaks static DAG assumptions** — The executor's `topologicalSort`-then-iterate model schedules all nodes including false branches. Prevention: refactor to a ready-queue model where nodes become eligible only when dependencies complete AND conditional guard evaluates true. This is a structural refactor of the core scheduling loop, not a small addition.

5. **Loop nodes create implied cycles — DAG invariant violated** — `validateDAG` detects cycles as errors; loop nodes require re-execution. Prevention: model loops as opaque meta-nodes that own their internal iteration logic. The outer DAG sees a single `loop` node; `validateDAG` is not weakened.

6. **Self-correction "loop of death"** — Without a convergence guard, the fix agent runs indefinitely burning cost. Prevention: `max_iterations` is a required field with no default; implement a no-progress detector (abort when two consecutive iterations produce identical test output by hash comparison); track and report best score across iterations on exhaustion.

7. **Fix branch not carried forward between iterations** — Each loop iteration must explicitly build on the previous iteration's committed output. Prevention: the loop node's internal executor must maintain a `currentBase` branch that advances after each fix commit. Test runners in iteration N+1 must see cumulative state from iteration N.

## Implications for Roadmap

Based on the dependency graph established across all four research files, the mandatory build order is: schema first, then conditional nodes, then loop nodes, then delegation wiring, with self-correction as an integration milestone rather than a new feature phase. Five phases total.

### Phase 1: Schema Foundation and Type Extensions

**Rationale:** Every subsequent feature depends on the SQLite schema extension and PipelineNode type additions. Adding `parentRunId`, `role`, `depth`, `maxChildren`, `childrenDispatched` to `runs` and creating the `delegations` table must land before any delegation or recovery code. The PipelineNode type extension (`node_type`, `condition`, `loop` fields with Zod validation) must land before the executor refactor in Phase 2. This is a pure foundation phase — no behavioral change, only schema, types, migration, and one new dependency.

**Delivers:** Drizzle migration with `delegations` table and extended `runs` columns; updated `PipelineNode` interface and Zod schema in `src/pipeline/parser.ts`; `filtrex` installed and typed.

**Addresses:** Pitfall 2 (parent/child relationships lost on restart) — schema must precede all delegation code.

**Avoids:** The "implement delegation without schema" technical debt shortcut that PITFALLS.md marks as never acceptable.

**Research flag:** Standard patterns. No additional research needed.

### Phase 2: Conditional Pipeline Nodes

**Rationale:** Conditional nodes are the foundation for loop nodes and self-correction. The executor refactor from pre-computed topological order to a ready-queue model is the most architecturally significant change in this milestone and must be complete before loop nodes are added on top. Self-contained pipeline subsystem change — testable with unit tests against mock `NodeExecution` states without any delegation complexity.

**Delivers:** `src/pipeline/condition.ts` expression evaluator using `filtrex`; `executeConditionalNode()` in executor; ready-queue scheduling model replacing static topological sort; `skipped` status with `skipReason: "condition"` distinct from rerun-selection skips; dry-run support showing conditional logic.

**Addresses:** P1 features — `condition` field with expression evaluator; `else_node` routing; node type discriminant in PipelineExecutor.

**Avoids:** Pitfall 4 (conditional branching breaks static DAG assumptions); Pitfall 10 (condition field silently ignored by executor without type discriminant).

**Research flag:** The ready-queue scheduling refactor is the most architecturally novel change in this milestone. Recommend a focused plan that explicitly specifies the new scheduling contract before writing code — partial refactors leave inconsistent behavior.

### Phase 3: Loop Pipeline Nodes

**Rationale:** Loop nodes build directly on the type dispatch infrastructure from Phase 2. The opaque meta-node model must be validated independently before self-correction pipelines compose on top. Per-iteration checkpointing with `iterationIndex` is required for crash recovery and must be designed before any loop code lands.

**Delivers:** `executeLoopNode()` with iteration counter; `max_iterations` enforcement before condition evaluation; per-iteration checkpoint with `iterationIndex` (crash recovery resumes from last completed iteration); `loop-iterating` status in `NodeExecution`; loop exhaustion failure with full iteration history written to flight recorder.

**Addresses:** P1 features — `loop` field, `max_iterations`, hard safety cap. P2 — loop iteration count in status API.

**Avoids:** Pitfall 5 (loop nodes violate DAG acyclicity invariant); Pitfall 6 (loop of death without hard cap).

**Research flag:** Well-documented patterns (Google ADK LoopAgent, Haystack, AWS guidance). No additional research needed.

### Phase 4: Multi-Agent Delegation

**Rationale:** Delegation is architecturally independent of the pipeline node changes but shares the Phase 1 schema. Building delegation after the pipeline phases allows focused attention on the two highest-severity design decisions in the entire milestone: the two-tier slot pool and workspace isolation. Both have correctness implications for crash recovery and must be resolved in planning before any code is written.

**Delivers:** `src/orchestrator/delegation.ts` (manifest parser, `delegateSubtasks()`, `waitForChildren()`); `src/storage/repositories/delegations.ts`; modified `dispatchIssue()` with depth cap and child slot pool; modified `executeWorker()` with manifest parsing; child workspace isolation (`ensureChildWorkspace()`); governance inheritance (children default to `full` autonomy, gate fires once at lead dispatch); aggregate summary comment on parent issue after all children complete.

**Addresses:** P1 features — lead subtask list, concurrent child dispatch, `maxChildren` + depth=2, SQLite child tracking, child result aggregation. P2 — governance inheritance.

**Avoids:** Pitfall 1 (slot exhaustion); Pitfall 2 (restart relationship loss); Pitfall 3 (workspace contamination); Pitfall 8 (SQLite write contention from burst child completions); Pitfall 9 (governance gate fires N times for N children).

**Research flag:** The two-tier slot design and child workspace isolation strategy (subdirectory vs Git worktree) require explicit resolution in a plan phase before implementation. These are novel to the codebase with no direct v2.0 precedent.

### Phase 5: Self-Correction Integration and Validation

**Rationale:** Self-correction is not new code — it is a composition of loop nodes (Phase 3) plus the existing context piping mechanism and `ValidationResult` fields on `NodeExecution.result`. This phase proves the composition works end-to-end, adds the no-progress detector, validates fix-branch carry-forward, and documents the required WORKFLOW.md patterns. The primary deliverable is integration tests and documentation, not new subsystems.

**Delivers:** Integration tests proving test-fail-fix-retest pipeline; no-progress detector comparing test output hashes between consecutive iterations; iteration summary written to flight recorder on loop exhaustion; documented self-correction pipeline YAML patterns; fix node `exclude` list guidance in WORKFLOW.md documentation.

**Addresses:** P1 features — failure output piped to fix node; fix node exclude guard; clean exhaustion failure with iteration history. P2 — self-correction history in fix prompts.

**Avoids:** Pitfall 6 (loop of death — no-progress detector); Pitfall 7 (fix branch not carried forward between iterations).

**Research flag:** Standard composition pattern. No additional research needed. Primary work is integration tests and documentation.

### Phase Ordering Rationale

- Schema must be first because `parentRunId`/`depth` and the `delegations` table are prerequisites for delegation crash recovery, which is a correctness requirement — not an optimization
- Conditional nodes before loop nodes because loop node dispatch is built on the type-dispatch switch introduced in the conditional phase; attempting them in parallel creates integration conflicts
- Loop nodes before self-correction because self-correction is a composition of loop nodes — there is nothing to compose until loops exist
- Delegation after pipeline phases because the slot design and workspace isolation decisions are high-severity and warrant focused attention without concurrent pipeline complexity; delegation is also architecturally independent, so the sequencing has no penalty
- Self-correction as the final integration milestone because it validates the composition of every prior phase and has no new code requirements

### Research Flags

Phases needing focused pre-implementation design (plan phase recommended):

- **Phase 2 (Conditional Nodes):** The ready-queue scheduling refactor changes the core scheduling contract of `PipelineExecutor`. A plan phase should specify the new scheduling interface explicitly before implementation begins. Risk: partial refactor leaves inconsistent behavior that is hard to test.

- **Phase 4 (Multi-Agent Delegation):** Two design decisions need explicit resolution before code: (1) two-tier slot pool design — whether child slots are reserved eagerly at lead dispatch or lazily at first child dispatch (both have restart recovery implications); (2) workspace isolation strategy — subdirectory vs Git worktree (affects WorkspaceManager API, child agent prompts, and fan-in merge logic).

Phases with standard, well-documented patterns (skip additional research):

- **Phase 1 (Schema Foundation):** Drizzle self-referential FK pattern is verified; migration tooling is established from v2.0.
- **Phase 3 (Loop Nodes):** Opaque meta-node loop model is well-documented in Google ADK, Haystack, and AWS guidance.
- **Phase 5 (Self-Correction):** Pure composition and integration testing; no novel design decisions.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | `filtrex` verified against npm registry (zero deps, ESM, TypeScript, published Oct 2024). All "no new dependency" conclusions verified by direct codebase analysis. Alternatives (`jexl`, `expr-eval`, `node:vm`, `vm2`) ruled out with documented rationale. |
| Features | HIGH | P1 features confirmed by Anthropic engineering blog, Google ADK docs, AWS prescriptive guidance, Haystack docs. Anti-features (test weakening, parallel fix attempts, unlimited delegation depth) confirmed by 2026 practitioner reports. Dependency graph across features is fully mapped. |
| Architecture | HIGH | All component analysis based on direct v2.0 source code inspection (`src/pipeline/executor.ts`, `src/orchestrator/dispatcher.ts`, `src/storage/schema.ts`, `src/validation/runner.ts`). No speculative architecture — every integration point names the specific file and function. |
| Pitfalls | HIGH (code-verified) / MEDIUM (ecosystem) | Code-verified pitfalls (slot exhaustion model, static DAG assumptions, in-memory OrchestratorState, missing `parentRunId` column) are HIGH confidence from direct source analysis. Ecosystem pitfalls (SQLite write contention under burst, self-correction loop of death, test-weakening behavior) are MEDIUM from multiple independent practitioner sources (2025-2026). |

**Overall confidence:** HIGH

### Gaps to Address

- **Slot pool design specifics:** Research describes the two-tier slot model conceptually. The exact implementation — eager vs lazy child slot reservation, and how child slots interact with the global `maxConcurrent` config — must be decided in Phase 4 planning. Both approaches have correctness implications for the crash recovery case where the daemon restarts mid-delegation.

- **Git worktree vs subdirectory for child workspaces:** Both are valid isolation strategies. Git worktrees provide stronger isolation and match how parallel agent tools (Cursor, others) implement it in 2025. Subdirectories are simpler but require stricter child agent prompting. The choice affects `WorkspaceManager` API design and should be resolved before Phase 4 implementation begins.

- **No-progress detection implementation:** The self-correction no-progress detector (abort when two consecutive iterations produce identical test output) is the right concept. The implementation detail — raw stdout hash comparison vs structured failure set comparison — needs a concrete decision in Phase 5 planning. Structured comparison is more robust to whitespace/timestamp noise in test output.

- **Governance inheritance for `parentApprovalId`:** Research specifies children should inherit `full` autonomy by default with a `parentApprovalId` field on `GovernanceOpts`. The mechanism for the post-approval gate (fires once on aggregate output vs per-child) needs explicit design in Phase 4 to avoid the "N approval comments for N children" pitfall.

## Sources

### Primary (HIGH confidence — official docs and direct code analysis)

- Direct codebase analysis of v2.0 `src/` — `executor.ts`, `dispatcher.ts`, `worker.ts`, `state.ts`, `schema.ts`, `runner.ts`, `governance/types.ts` (2026-03-12)
- [filtrex on npm](https://www.npmjs.com/package/filtrex) — v3.1.0, published 2024-10-14, zero deps, ESM + TypeScript
- [filtrex GitHub](https://github.com/joewalnes/filtrex) — boolean expression DSL, safety guarantees, custom function injection
- [Drizzle ORM relations v2](https://orm.drizzle.team/docs/relations-v2) — self-referential FK patterns, current docs
- [Google ADK loop agents documentation](https://google.github.io/adk-docs/agents/workflow-agents/loop-agents/) — loop-until termination, max_iterations, sub-agent signaling
- [Haystack pipeline loops documentation](https://docs.haystack.deepset.ai/docs/pipeline-loops) — ConditionalRouter, max_runs_per_component, self-correction pattern with feedback injection
- [AWS Prescriptive Guidance: Evaluator-reflect-refine loop patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html) — standard self-correction loop structure
- [Anthropic multi-agent engineering blog](https://www.anthropic.com/engineering/multi-agent-research-system) — orchestrator-worker pattern, delegation specs, effort budgeting

### Secondary (MEDIUM confidence — community consensus, multiple sources agree)

- [Arize AI: Orchestrator-worker agent comparison](https://arize.com/blog/orchestrator-worker-agents-a-practical-comparison-of-common-agent-frameworks/) — LangGraph vs CrewAI vs OpenAI Agents SDK tradeoffs
- [Azure AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — supervisor/hierarchical pattern rationale
- [Git Worktrees for Parallel Agents (DEV Community)](https://dev.to/arifszn/git-worktrees-the-power-behind-cursors-parallel-agents-19j1) — workspace isolation pattern, per-agent branches
- [SQLite concurrent writes (Ten Thousand Meters)](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) — SQLITE_BUSY under concurrent writers, BEGIN IMMEDIATE pattern
- [The "Loop of Death" — Sattyam Jain, Jan 2026](https://medium.com/@sattyamjain96/the-loop-of-death-why-90-of-autonomous-agents-fail-in-production-and-how-we-solved-it-at-e98451becf5f) — step budgets, convergence failure patterns
- [Self-Correcting Multi-Agent AI Systems — Soham Ghosh, Feb 2026](https://medium.com/@sohamghosh_23912/self-correcting-multi-agent-ai-systems-building-pipelines-that-fix-themselves-010786bae2db) — best-score tracking, iteration history
- [Galileo AI: Multi-agent coordination strategies](https://galileo.ai/blog/multi-agent-coordination-strategies) — parent-child topology, slot exhaustion patterns
- [Multi-Agent System Reliability (Maxim AI)](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/) — coordination failures, retry ambiguity, duplicate actions

### Tertiary (MEDIUM-LOW confidence — single source, validate during implementation)

- [DEV Community: "I Let an AI Agent Write 275 Tests"](https://dev.to/htekdev/i-let-an-ai-agent-write-275-tests-heres-what-it-was-actually-optimizing-for-32n7) — agents weaken tests anti-pattern (aligned with common sense; validate with fix node `exclude` list in practice)
- [I Tried Agent Self-Correction (Nexumo, Feb 2026)](https://medium.com/@Nexumo_/i-tried-agent-self-correction-tool-errors-made-it-worse-d6ea76a17c1c) — self-correction backfire, tool error amplification

---
*Research completed: 2026-03-12*
*Ready for roadmap: yes*
