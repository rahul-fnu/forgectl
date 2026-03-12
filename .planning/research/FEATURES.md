# Feature Research

**Domain:** Multi-agent delegation, conditional/loop pipeline nodes, pipeline self-correction
**Milestone:** v2.1 Autonomous Factory
**Researched:** 2026-03-12
**Confidence:** HIGH (core behaviors); MEDIUM (YAML syntax conventions); HIGH (self-correction loop structure)

---

## Context: What Is Already Built

Before mapping new features, note what v2.0 already delivers so nothing is re-invented:

- **Static DAG pipeline executor** (`src/pipeline/executor.ts`): topological sort, parallel execution, fan-in merging, checkpoint/resume per node.
- **PipelineNode type** (`src/pipeline/types.ts`): `id`, `task`, `depends_on`, `workflow`, `agent`, `input`, `pipe`. No `if`, `loop`, or `delegate` fields yet.
- **Validation self-correction loop** (`src/validation/runner.ts`): run steps → collect failures → invoke agent fix → restart steps from top. Already bounds loops via `maxRetries` from step config.
- **Orchestrator dispatcher** (`src/orchestrator/dispatcher.ts`): claim → execute worker → retry with backoff. Per-issue, not per-subtask.
- **Governance/autonomy** (`src/governance/`): pre/post-gate approval state machine. Wired into the worker.
- **SQLite storage** (`src/storage/schema.ts`): `runs`, `pipeline_runs`, `run_events` tables. No parent/child run relationship yet.

The new milestone adds three feature clusters on top of this foundation.

---

## Feature Cluster 1: Multi-Agent Delegation (Lead → Worker)

### What "delegation" means in this context

A **lead agent** receives a complex issue, decomposes it into N subtasks at runtime, and dispatches each subtask to a **child worker agent** using the existing `executeWorker` machinery. The lead does not execute the subtasks itself — it writes a decomposition plan, then the orchestrator dispatches child workers per subtask. Results flow back to the lead for synthesis or direct write-back.

This is the **orchestrator-worker pattern**, the dominant production multi-agent architecture in 2025-2026 (confirmed: Anthropic engineering blog, Arize AI comparison, AWS guidance).

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| Lead agent produces a subtask list | Delegation only works if the lead outputs structured subtask specs (id, task description, workflow, agent type). Without structure, the orchestrator cannot dispatch. | MEDIUM | Prompt engineering: lead prompt must elicit structured JSON output; zod schema to validate it. |
| Orchestrator dispatches child workers per subtask | The existing `dispatchIssue` / `executeWorker` machinery must be callable with a synthetic issue representing a subtask, not just a real tracker issue. | MEDIUM | `executeWorker` accepts a `TrackerIssue`; needs a `SyntheticIssue` that satisfies the interface. |
| Child workers run concurrently (up to slot limit) | Parallelization is the primary ROI of multi-agent. If children are sequential, delegation adds overhead with no benefit. Anthropic data shows 90% time reduction with 3-5 parallel subagents. | MEDIUM | Existing `maxParallel` concurrency pattern in pipeline executor can be adapted. |
| `maxChildren` budget per parent issue | Without a budget cap, one complex issue can spawn hundreds of children, exhausting Docker slots and API rate limits. The limit must be set in WORKFLOW.md. | LOW | Config schema extension. |
| Depth limit (max depth=2 for v2.1) | Unlimited recursion (lead spawns leads that spawn leads) is the fastest way to infinite loops and cost blowouts. Depth 2 = lead + one level of workers. Enforce via context passed into each worker invocation. | LOW | Pass `parentDepth` into worker; worker refuses to delegate if depth >= 2. |
| Per-parent `maxChildren` budget tracked in SQLite | If the daemon crashes mid-delegation, we must not re-spawn already-running children. The parent run record needs a `childIds` field. | MEDIUM | Schema migration: add `parentRunId` and `childRunIds` to `runs` table. |
| Child results collected and summarized for parent | After all children complete, results (branch names, file diffs, validation outcomes) must be aggregated and returned to the parent (or written to the tracker directly). | MEDIUM | New result-aggregation step after child dispatch loop. |
| Failure retry with updated instructions | If a child fails, the lead can re-issue it with amended task instructions (incorporating the failure reason). Standard in orchestrator-worker literature. | MEDIUM | Child retry loop: on child failure, re-prompt lead for revised subtask spec, re-dispatch. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Lead agent writes subtask specs to tracker (creates sub-issues) | Full traceability: each subtask is a real GitHub issue with its own comment thread, labels, and lifecycle. Users can follow along from their phone. | HIGH | Requires `TrackerAdapter.createIssue()` — not yet in the interface. Adds complexity to the adapter. |
| Lead synthesizes child results before write-back | Rather than posting N separate comments, lead reads child outputs and writes one coherent summary comment. Requires another agent invocation post-children. | MEDIUM | Adds one more `executeWorker` call in "synthesis" mode after children complete. |
| Autonomy gates per child | Each child worker can have its own autonomy level (e.g., child implementing a DB migration goes to `supervised`). Inherited from lead's WORKFLOW.md but overridable per subtask spec. | MEDIUM | Pass governance opts per child; already wired in dispatcher. |

### Anti-Features

| Feature | Why Avoid | Alternative |
|---------|-----------|------------|
| Unlimited delegation depth | Each level multiplies agents, API calls, and cost. A three-level hierarchy is never necessary for single-machine use. | Hard-code depth=2 for v2.1. Revisit when distributed execution is in scope. |
| Lead agent manages child workspaces directly | Lead reaching into child workspaces violates isolation. Child output is always collected via the existing git/files output modes. | Children write to their own branches/dirs; parent reads via resolver, not direct file access. |
| Spawning children on a remote queue (BullMQ/Redis) | External queue adds infrastructure. Single-machine SQLite is sufficient. | Track children in SQLite `runs` table with `parentRunId` column. |
| Lead agent re-implements the orchestrator | The lead should produce a subtask list and stop. The forgectl orchestrator dispatches workers. The lead is not a second orchestrator. | Lead outputs JSON plan; forgectl runtime dispatches, not another agent. |

### Feature Dependencies

```
Multi-Agent Delegation
    requires: executeWorker (already built)
    requires: SQLite runs table migration (add parentRunId, childRunIds)
    requires: SyntheticIssue adapter (new — wraps subtask spec as TrackerIssue)
    requires: child concurrency limiter (adapt PipelineExecutor.maxParallel pattern)
    requires: depth tracking (new context field in worker invocation)
    enhances: governance (children inherit autonomy, can override per-subtask)
    conflicts-with: unlimited depth (must enforce depth <= 2)
```

---

## Feature Cluster 2: Conditional Pipeline Nodes (if/else, loop-until)

### What "conditional nodes" mean here

The existing pipeline executor treats `PipelineNode.depends_on` as purely structural (edges in the DAG). Conditional nodes extend this so:

- **If nodes**: a node only executes if a boolean expression over upstream node results evaluates to true. Otherwise it is skipped (or the else-branch executes instead).
- **Loop nodes**: a node (or subgraph) re-executes until a condition on its own output evaluates to true, or a max iteration count is reached.

These are runtime control flow additions to the static DAG — a dynamic overlay on the existing static executor.

### Industry reference

This pattern is confirmed in every major pipeline/workflow framework (Azure Pipelines, GitHub Actions, LangGraph, Haystack, Google ADK, Prefect). The key implementation insight from Haystack: conditions should be expressions evaluated against node output, not boolean constants — otherwise you could have achieved the same result with static DAG structure.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| `condition` field on PipelineNode | Nodes with `condition: "expr"` are skipped if the expression evaluates falsy. This is the YAML primitive users write. | MEDIUM | Expression evaluator (see below); parser extension. |
| Expression evaluator over upstream node results | The expression references `nodes.<nodeId>.status`, `nodes.<nodeId>.result.validation.passed`, `nodes.<nodeId>.result.output.branch`. Must be safe (no `eval`). | MEDIUM | Use a sandboxed evaluator (e.g., `expr-eval` npm package or a small hand-rolled subset). |
| `if_failed` / `if_passed` branch shorthand | `condition: "nodes.test.result.validation.passed == false"` is verbose. Shorthand `if_failed: test` is more readable in YAML. Both resolve to the same runtime check. | LOW | Syntactic sugar in the parser, reduces to a condition expression. |
| `else_node` field to name the branch to skip to | When a condition is false, skip to `else_node` (or skip the entire subtree if no else). | MEDIUM | Parser must validate that `else_node` exists in the pipeline; executor must route accordingly. |
| `loop: { until: "expr", max_iterations: N }` on a node | The node re-executes until `until` is true or `max_iterations` is reached. Loop iteration state (count) is tracked in `NodeExecution`. | HIGH | Executor must support re-queuing a node; loop state must be checkpointed. |
| Hard max_iterations safety cap | If YAML specifies `max_iterations: 100`, forgectl caps it at a global maximum (e.g., 20) to prevent runaway loops. | LOW | Config-level cap constant; warn if YAML exceeds it. |
| Skip-on-false behavior is visible in dry-run | `forgectl pipeline run --dry-run` shows which nodes would be skipped given hypothetical condition values. | LOW | Dry-run formatter extended to show conditional logic. |
| Condition evaluation errors are fatal | If an expression references a node that doesn't exist or returns a type error, the pipeline fails immediately rather than silently skipping. | LOW | Defensive expression evaluation with typed error. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| YAML-native condition syntax (no scripting) | Keeps pipeline files readable without requiring users to write JavaScript/Python conditions. Competing tools (Azure Pipelines `${{ if }}`) embed scripting languages, which is powerful but brittle. | MEDIUM | Design a small, safe expression subset: `==`, `!=`, `&&`, `\|\|`, `!`, dot-path access. |
| Condition based on validation result | `if_failed: test` → "run the fix node only if tests failed." This is the primary use case for self-correction pipelines (Cluster 3). | LOW | Validation result is already in `NodeExecution.result.validation.passed`. |
| Loop counter available as expression variable | `nodes.fix_node.loop_iteration` is available in condition expressions, enabling patterns like "if this is the 3rd iteration and still failing, use a different strategy." | MEDIUM | Add `loopIteration` to `NodeExecution`; expose in evaluator context. |

### Anti-Features

| Feature | Why Avoid | Alternative |
|---------|-----------|------------|
| Turing-complete condition expressions | Arbitrary code in conditions (Python lambdas, JS `eval`) is a security and debuggability problem. | A safe expression subset: comparison operators, boolean logic, dot-path access to node results. |
| Conditions that branch based on external API calls | External calls in conditions make pipeline execution non-deterministic and hard to checkpoint. | Conditions reference only node results already in memory. External decisions should be a node. |
| Nested conditional subgraphs (if inside if inside loop) | Infinite recursion in the graph resolver; hard to reason about and visualize. | Depth limit on conditional nesting: max 2 levels. Deeper logic belongs in the agent's task. |
| Runtime pipeline modification (adding nodes conditionally) | Dynamic graph mutation makes checkpoint/resume fragile. | All nodes are declared statically in YAML; conditions control execution, not graph structure. |

### Feature Dependencies

```
Conditional Pipeline Nodes
    requires: PipelineNode type extension (add condition, else_node, loop fields)
    requires: PipelineExecutor refactor (condition evaluation before executeNode)
    requires: Expression evaluator (safe, sandboxed, references NodeExecution results)
    requires: Loop state tracking in NodeExecution (loopIteration counter)
    requires: Checkpoint extension (checkpoint loop state between iterations)
    enhances: self-correction (Cluster 3 is built on top of loop nodes)
    conflicts-with: static topological sort (loops break DAG property — need cycle detection bypass for loop nodes)
```

---

## Feature Cluster 3: Pipeline Self-Correction (test fail → fix → retest)

### What "self-correction" means here

A pipeline-level feedback loop (distinct from the existing in-container validation loop in `src/validation/runner.ts`) where:

1. A test node runs (e.g., `npm test`, lint, coverage check).
2. If tests fail, a fix node runs with the failure output as context.
3. The test node re-runs.
4. This repeats until tests pass or max iterations is reached.

The **key distinction from existing validation**: the existing `runValidationLoop` runs validation commands inside the same container as the original agent invocation, feeds errors back as a prompt to the same agent, and retries — all within a single `executeWorker` call. Pipeline self-correction is at a higher level: separate nodes, each its own worker invocation, with explicit iteration tracking in the pipeline executor.

### Why both are needed

- The existing validation loop is for synchronous in-container correction (fast, single agent, single container).
- Pipeline self-correction is for cases where fix and test are separate agents or separate workflows (different containers, different agents, potentially different repos).

### Industry patterns (confirmed)

The standard self-correction pattern (Haystack docs, Google ADK LoopAgent, AWS Evaluator-Reflect-Refine, Medium blog by Soham Ghosh 2026):

1. Generator → Evaluator → ConditionalRouter → (loop back to Generator | exit to output)
2. Termination via: (a) condition met, or (b) max_iterations reached
3. Each iteration carries prior failure context into the next generator prompt

Critical warning from industry research: agents given failing tests will often weaken the tests rather than fix the code. Mitigation: the fix node must not have write access to test files, or the validation node must separately verify test file integrity.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Depends On |
|---------|--------------|------------|------------|
| `loop` node type that wraps a fix node | The YAML primitive: `loop: { until: "nodes.test.result.validation.passed", max_iterations: 5 }` on a fix node causes it to re-run until tests pass. | HIGH | Conditional pipeline nodes (Cluster 2); loop re-execution in executor. |
| Failure output passed as context to fix node | The fix node gets the test failure output (stdout/stderr from the failed validation) as `context`. Without this, the fix agent cannot know what to fix. | MEDIUM | `NodeExecution.result` already contains validation output; needs to be materialized as a context file for the next node. |
| Loop iteration count tracked and visible | `forgectl pipeline status` shows "fix-loop: 3/5 iterations, still failing." Without visibility, users cannot tell if the loop is working. | LOW | `loopIteration` in `NodeExecution`; REST API and dashboard exposure. |
| Max iteration cap with clean failure | When `max_iterations` is reached and tests still fail, the pipeline fails the loop node cleanly and reports "self-correction exhausted after N iterations." | LOW | Existing `getDependencyIssues` pattern extended for loop exhaustion. |
| Fix node cannot modify test files | Guard: the fix workflow's WORKFLOW.md `exclude` list includes `*.test.ts`, `*.spec.ts`, `test/`, so the agent cannot weaken tests. | LOW | WORKFLOW.md `exclude` config already supported; document this as a required practice. |
| Coverage drop self-correction | `until: "nodes.coverage.result.output.coveragePercent >= 80"` — but coverage value must be extractable from agent output. | HIGH | Requires structured output parsing from the test node; coverage percent must be in a known location in agent output. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Multi-trigger self-correction (lint + test + coverage in sequence) | A single pipeline loop covers lint fail → reformat, test fail → fix, coverage drop → add tests. Each trigger type has its own fix node. | HIGH | Composing multiple loop nodes in sequence within a pipeline; each loop is independent. |
| Fix agent different from original agent | The test agent runs with Claude Code; the fix agent runs with Codex. Different strengths for different correction tasks. | LOW | Already supported by `agent` field on PipelineNode. |
| Self-correction history injected into fix prompts | Each iteration's fix prompt includes the history of all previous attempts: "In iteration 1, you tried X. It failed because Y. In iteration 2, you tried Z. It also failed." Progressive context accumulation. | MEDIUM | Accumulate `NodeExecution` results across iterations; materialize as context file for each iteration. |
| Governance gate before applying fix | Before the fix node runs, apply pre-execution approval gate if autonomy requires it. "Tests failed — approve this fix attempt?" | MEDIUM | Governance already wired into executeWorker; needs to be honored per loop iteration, not just once at start. |

### Anti-Features

| Feature | Why Avoid | Alternative |
|---------|-----------|------------|
| Infinite self-correction with escalating model | Trying increasingly powerful (expensive) models when cheaper ones fail. Sounds smart but hides budget blowout risk. | Fixed max_iterations + clean failure. User re-triages the issue manually if N iterations fail. |
| Self-correction that can modify the test suite | Agents will take the path of least resistance: weaken tests. This is the most commonly reported failure mode in industry (confirmed: DEV Community "275 Tests" article, 2026). | `exclude` list in fix workflow WORKFLOW.md; test file integrity check as a post-loop validation step. |
| Parallel self-correction (try multiple fixes simultaneously) | Merging parallel fix attempts that touched the same files creates merge conflicts that are hard to resolve automatically. | Sequential: one fix attempt at a time. Parallelism is for independent subtasks (Cluster 1), not for self-correction. |
| Self-correction across unrelated failing checks | One fix agent trying to simultaneously fix lint, tests, and coverage. Each concern has different context requirements. | Separate loop nodes per check type. Lint loop, test loop, coverage loop run in sequence. |

### Feature Dependencies

```
Pipeline Self-Correction
    requires: Conditional pipeline nodes (Cluster 2) — loop-until is the primitive
    requires: Context materialization between iterations (failure output as context file)
    requires: Loop state tracking (iteration counter in NodeExecution)
    requires: Existing validation runner (already provides structured failure output)
    enhances: Governance (approval gate per iteration is a differentiator)
    conflicts-with: fix node modifying test files (must use WORKFLOW.md exclude)
    depends-on (soft): Self-correction works best when the test node emits structured
                       failure output (exit code + stderr). Already done in runValidationStep.
```

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Lead agent produces subtask list | HIGH | MEDIUM | P1 |
| Child workers dispatched concurrently | HIGH | MEDIUM | P1 |
| `maxChildren` + depth=2 limit | HIGH | LOW | P1 |
| SQLite parent/child run relationship | HIGH | LOW | P1 |
| `condition` field + expression evaluator | HIGH | MEDIUM | P1 |
| `loop` field + max_iterations cap | HIGH | HIGH | P1 |
| Failure output as context to fix node | HIGH | MEDIUM | P1 |
| Fix node `exclude` list guard | HIGH | LOW | P1 |
| Child failure retry with updated instructions | MEDIUM | MEDIUM | P2 |
| `if_failed` / `if_passed` shorthand | MEDIUM | LOW | P2 |
| Loop iteration count in status/API | MEDIUM | LOW | P2 |
| Lead agent synthesis call (one final summary) | MEDIUM | MEDIUM | P2 |
| Self-correction history in fix prompts | MEDIUM | MEDIUM | P2 |
| Governance gate per loop iteration | MEDIUM | MEDIUM | P2 |
| Lead creates sub-issues in tracker | LOW | HIGH | P3 |
| Multi-trigger self-correction (lint + test + coverage) | LOW | HIGH | P3 |
| Parallel alternative fix attempts | LOW — anti-feature | — | DO NOT BUILD |

**Priority key:**
- P1: Must have for v2.1 to deliver on "Autonomous Factory" promise
- P2: Should have; add once P1 features are validated
- P3: Nice to have; future consideration or v2.2

---

## Full Dependency Graph (Cross-Feature)

```
SQLite schema migration (add parentRunId, childRunIds)
    |
    +---> Multi-Agent Delegation
    |         requires: SyntheticIssue adapter (subtask as TrackerIssue)
    |         requires: child concurrency limiter
    |         requires: depth tracking (parentDepth context field)
    |
PipelineNode type extension (condition, else_node, loop fields)
    |
    +---> Expression Evaluator (safe, references NodeExecution results)
    |         |
    |         +---> Conditional Pipeline Nodes (if/else branches)
    |                   |
    |                   +---> Pipeline Self-Correction (loop-until is the primitive)
    |                             requires: context materialization between iterations
    |                             requires: fix node exclude guard (WORKFLOW.md)
    |
PipelineExecutor refactor
    requires: condition evaluation before executeNode
    requires: loop re-queuing (cycle in execution for loop nodes only)
    requires: loop state in NodeExecution (loopIteration counter)
    requires: checkpoint extension (persist loop state)
```

**Build order enforced by dependencies:**
1. Schema migration (parallel with planning)
2. PipelineNode type extension + expression evaluator
3. PipelineExecutor refactor (conditional execution)
4. Loop node support (builds on conditional)
5. Multi-agent delegation (independent of pipeline changes, uses executor machinery)
6. Self-correction pipelines (composes loop nodes + context materialization)

---

## MVP Definition

### Launch With (v2.1 core)

- [x] Multi-agent delegation: lead → workers, depth=2, maxChildren budget, concurrent dispatch, SQLite child tracking
- [x] Conditional pipeline nodes: `condition` field, expression evaluator, `else_node`, skip-on-false
- [x] Loop nodes: `loop.until` + `loop.max_iterations`, hard safety cap
- [x] Self-correction: failure context to fix node, fix-exclude list, clean exhaustion failure

### Add After Validation (v2.1.x)

- [ ] Child failure retry with updated instructions — trigger: users report child failures not retried
- [ ] Self-correction history accumulation — trigger: users report fix agent repeating same failed approach
- [ ] `if_failed` / `if_passed` shorthand — trigger: YAML verbosity complaints

### Future Consideration (v2.2+)

- [ ] Lead creates sub-issues in tracker — requires `TrackerAdapter.createIssue()` addition
- [ ] Multi-trigger self-correction (lint + test + coverage as one loop) — high complexity, composable from existing P1 features
- [ ] Governance gate per loop iteration — requires governance/approval flow changes

---

## Sources

- [Anthropic multi-agent research system engineering blog](https://www.anthropic.com/engineering/multi-agent-research-system) — orchestrator-worker pattern, delegation specs, effort budgeting
- [Anthropic: When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) — context-centric decomposition, verification subagent pattern
- [Google ADK loop agents documentation](https://google.github.io/adk-docs/agents/workflow-agents/loop-agents/) — loop-until termination, max_iterations, sub-agent signaling via exit_loop
- [Haystack pipeline loops documentation](https://docs.haystack.deepset.ai/docs/pipeline-loops) — ConditionalRouter, max_runs_per_component, self-correction pattern with feedback injection
- [AWS Prescriptive Guidance: Evaluator-reflect-refine loop patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html) — standard self-correction loop structure
- [Arize AI: Orchestrator-worker agent comparison](https://arize.com/blog/orchestrator-worker-agents-a-practical-comparison-of-common-agent-frameworks/) — framework comparison (LangGraph, CrewAI, OpenAI Agents SDK)
- [DEV Community: "I Let an AI Agent Write 275 Tests"](https://dev.to/htekdev/i-let-an-ai-agent-write-275-tests-heres-what-it-was-actually-optimizing-for-32n7) — agents weaken tests rather than fix code (anti-feature validation)
- [LangGraph conditional edges and loops](https://latenode.com/blog/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025) — graph-based control flow, loop constructs
- [Kore.ai: Choosing orchestration patterns](https://www.kore.ai/blog/choosing-the-right-orchestration-pattern-for-multi-agent-systems) — supervisor vs orchestrator-worker tradeoffs

---

*Feature research for: forgectl v2.1 Autonomous Factory*
*Researched: 2026-03-12*
