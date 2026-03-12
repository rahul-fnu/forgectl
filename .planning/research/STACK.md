# Technology Stack: v2.1 Additions

**Project:** forgectl v2.1 Autonomous Factory
**Researched:** 2026-03-12
**Scope:** NEW dependencies only for three features: (1) multi-agent delegation, (2) conditional/loop pipeline nodes, (3) pipeline self-correction. Existing stack (TypeScript, Node 20+, Commander, Fastify, Dockerode, Zod, Vitest, tsup, Drizzle ORM, better-sqlite3, Octokit, chalk, picomatch, keytar) is validated and excluded.
**Confidence:** HIGH for expression evaluator recommendation; HIGH for no-new-deps conclusions on delegation/self-correction.

---

## Recommended Stack Additions

### One New Dependency: Expression Evaluator

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `filtrex` | ^3.1.0 | Evaluate boolean condition expressions in YAML-defined pipeline nodes | Needed for `if/else` branch conditions and `loop-until` termination conditions in pipeline YAML. The conditions reference node output variables (exit codes, file counts, coverage percentages) — values that are not known until runtime. A safe, sandboxed DSL is required because these expressions come from user-authored YAML files and may run in a long-lived daemon. |

**Why filtrex and not the alternatives:**

`filtrex` 3.1.0 (published October 2024) is the correct choice for forgectl's conditional node DSL because:

1. **Truly sandboxed.** Expressions cannot access the process environment, Node.js APIs, or the global object. The library explicitly guarantees no sandbox breakout, unlike `node:vm`-based approaches (`safe-eval`, `safer-eval`) where breakouts have been demonstrated.

2. **Never throws on execution.** `filtrex` will not throw during expression execution — it returns an error value instead. This is exactly the right behavior for a daemon where a user-authored condition expression must not crash the orchestrator process.

3. **Boolean-first design.** forgectl's conditions are boolean predicates: `exit_code == 0`, `coverage >= 80`, `failed_tests == 0`. `filtrex` treats boolean logic as first-class (supports `and`, `or`, `not`, `==`, `!=`, `<`, `<=`, `>`, `>=`). `expr-eval` is math-first and requires more gymnastics for pure boolean use.

4. **Zero dependencies.** No transitive risk. `jexl` depends on `@babel/runtime` and was last published in 2020. `expr-eval` was last published in a similar timeframe and has no maintained types.

5. **ESM support.** Ships `dist/esm/filtrex.mjs` with TypeScript declarations at `dist/esm/filtrex.d.ts`. Compatible with the project's `"type": "module"` configuration.

6. **Custom function injection.** The `filtrex` evaluator accepts a `functions` map at evaluation time, allowing forgectl to inject helpers like `contains(output, "PASS")` or `matches(branch, "feat/*")` that operate on node output strings — without any regex or VM risk.

**What NOT to use for expressions:**

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `node:vm` with raw user expressions | Not a security boundary. Sandbox breakouts are documented. The daemon is long-lived — a crash or breakout is unacceptable. | `filtrex` |
| `eval()` | Obviously not. | `filtrex` |
| `jexl` ^2.3.0 | Last published 2020. Depends on `@babel/runtime`. Async-first design adds unnecessary complexity for synchronous pipeline conditions. | `filtrex` |
| `expr-eval` ^2.0.2 | Math-only DSL, no native boolean expressions, last published 2021+, no maintained TypeScript types. | `filtrex` |
| `jsonata` ^2.1.0 | JSON transformation language — correct tool for JSON querying, wrong tool for boolean predicate conditions. Overkill, different mental model. | `filtrex` |

---

## No New Dependencies: Multi-Agent Delegation

Multi-agent delegation (lead agent decomposes issue → spawns worker agents → waits for results → synthesizes) requires zero new npm dependencies. Everything needed already exists:

**What already exists that covers delegation:**
- `executeWorker()` in `src/orchestrator/worker.ts` — the atomic unit of agent execution. A delegation service calls this for each child task.
- `SlotManager` — controls concurrency. Child workers compete for the same slot pool, preventing runaway spawning.
- `DrizzleORM` + `better-sqlite3` — storage for parent/child run relationships (schema addition, not a new library).
- `Zod` — validation for delegation config (max children budget, depth limit) parsed from WORKFLOW.md front matter.
- Existing governance/approval system — child runs inherit autonomy level from parent run context.

**Schema additions needed (no new library):**

The `runs` table in `src/storage/schema.ts` needs two new columns:
- `parentRunId text` — foreign key to `runs.id` (self-referential). `null` for top-level runs.
- `delegationDepth integer` — 0 for top-level, 1 for children, capped at 2 by application logic.

Drizzle ORM supports self-referential foreign keys via `foreignKey` from `drizzle-orm/sqlite-core`. A new `delegations` table tracks per-issue child budgets:
- `issueId text`, `parentRunId text`, `childCount integer`, `maxChildren integer`.

The `DelegationService` class lives in `src/orchestrator/delegation.ts` and orchestrates the lead/worker pattern entirely using existing primitives.

**Pattern rationale (supervisor/hierarchical):**
The lead agent gets the issue, produces a decomposition (a list of subtasks as text). The `DelegationService` parses this output, creates child `TrackerIssue`-like objects, calls `executeWorker()` for each (up to `maxChildren` budget, `depth <= 2`), waits for all child results, and synthesizes a final result comment. This is the standard hierarchical/supervisor pattern for multi-agent AI systems and maps cleanly onto the existing worker/dispatcher/slot-manager architecture.

---

## No New Dependencies: Conditional and Loop Pipeline Nodes

Conditional pipeline nodes (`type: "condition"` with `if/else` branches, `type: "loop"` with `until` condition) integrate into the existing `PipelineExecutor` in `src/pipeline/executor.ts`. The only new dependency is `filtrex` (documented above) for evaluating the condition expressions.

**What already exists:**
- `PipelineNode` type in `src/pipeline/types.ts` — extend with `type?: "task" | "condition" | "loop"`, `condition?: string`, `if_branch?: string[]`, `else_branch?: string[]`, `until?: string`, `max_iterations?: number`.
- `topologicalSort` / `validateDAG` in `src/pipeline/dag.ts` — condition and loop nodes participate in the DAG. Loop nodes self-reference (they re-queue themselves on the executor's run list when the condition is not yet met), but the static DAG is acyclic (the loop is a runtime construct, not a graph edge).
- `NodeExecution` status enum — add `"loop-iterating"` status to express that a loop node is mid-iteration.
- `CheckpointRef` — loop iteration checkpoints save iteration count alongside normal checkpoint data.

**Expression evaluation context for `filtrex`:**

The context object passed to each condition evaluation contains the upstream node's execution result:
```typescript
{
  exit_code: number,      // last validation step exit code
  output: string,         // agent stdout (trimmed)
  passed: boolean,        // validation passed/failed
  iteration: number,      // current loop iteration count
  files_changed: number,  // git output files changed
  coverage: number,       // parsed from stdout if available
}
```
Custom functions injected: `contains(str, substr)`, `startsWith(str, prefix)`, `matches(str, pattern)` using `picomatch` (already in project).

**Loop termination safety:** Every loop node requires `max_iterations` (required field, no default). The executor enforces this cap regardless of the `until` condition result. On cap hit, the node transitions to `failed` with a clear error message.

---

## No New Dependencies: Pipeline Self-Correction

Self-correction (test fail → fix agent → retest) is implemented as a specialised pipeline node type and/or a pre-built pipeline pattern using conditional/loop nodes. No new npm dependency is needed.

**What already exists:**
- `runValidationLoop()` in `src/validation/runner.ts` — already implements "run test, feed failures back to agent, retry". This is self-correction within a single node.
- The new `type: "loop"` node (above) implements self-correction at the pipeline level: a loop node runs an agent task, a condition checks the result, and the loop body is re-entered if self-correction is needed.
- `executeWorker()` accepts `validationConfig` with `on_failure: "abandon" | "output-wip" | "pause"` — self-correction loops use `on_failure: "output-wip"` (don't abandon on first failure, let the loop node decide).

**Self-correction pipeline pattern (no new code beyond conditional/loop nodes):**

```yaml
nodes:
  - id: implement
    type: task
    task: "Implement the feature"

  - id: self-correct
    type: loop
    depends_on: [implement]
    task: "Fix the failing tests. Previous test output: {{output}}"
    until: "passed == true"
    max_iterations: 3
    condition_source: implement   # read condition from this node's last result
```

The `DelegationService` and the loop executor share the same `executeWorker()` invocation path, so governance gates, flight recorder events, and SQLite checkpoints all apply without additional wiring.

---

## Installation

```bash
# One new production dependency
npm install filtrex

# No new dev dependencies
```

**Total new production dependencies for v2.1: 1**
**Total new dev dependencies for v2.1: 0**

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Expression evaluator | `filtrex` ^3.1.0 | `jexl` ^2.3.0 | Last published 2020. Async-first (unnecessary). Depends on `@babel/runtime`. Stale. |
| Expression evaluator | `filtrex` ^3.1.0 | `expr-eval` ^2.0.2 | Math DSL, no native booleans, no maintained types, last published 2021+. |
| Expression evaluator | `filtrex` ^3.1.0 | `node:vm` + raw JS | Not a security boundary. Breakouts documented. Daemon cannot afford crashes from user-authored YAML. |
| Expression evaluator | `filtrex` ^3.1.0 | Custom recursive descent parser | Correct approach if we need full control, but `filtrex` 3.1.0 covers the entire required operator set. Build vs. buy: `filtrex` has zero deps, ships types, and costs 0 maintenance burden. |
| Delegation storage | SQLite schema extension | New `delegations` table only | Prefer adding `parentRunId`/`delegationDepth` to `runs` table (co-located, simpler joins) plus a lightweight `delegation_budgets` table for the per-issue child count. |
| Self-correction | Loop pipeline node | Dedicated `SelfCorrectionRunner` class | The loop node pattern is more general, reusable, and composable. A dedicated class would duplicate the loop executor's core logic. |
| Multi-agent framework | Custom delegation service | `agent-squad` / OpenAI Agents SDK | These frameworks assume you control the LLM API call. forgectl's agents are external CLI processes (`claude -p`, `codex exec`). Frameworks that expect function-calling APIs don't compose with forgectl's agent adapter model. |

---

## What NOT to Add

| Dependency | Why Skip |
|------------|----------|
| `xstate` | Delegation state machine has 5 states (pending/dispatching/waiting/synthesizing/done). TypeScript discriminated union handles this cleanly. xstate is overkill. |
| `p-limit` | Delegation concurrency is controlled by the existing `SlotManager`. Don't add a second concurrency primitive. |
| `zod-to-json-schema` | Not needed for any v2.1 feature. Agent tool schemas are hand-authored. |
| `vm2` | Abandoned in 2023 after critical security vulnerabilities. Do not use. |
| `safer-eval` | Uses `node:vm` internally, which is not a true security boundary. `filtrex` is safer. |
| Any workflow engine (Temporal, Conductor, Airflow) | All require separate server infrastructure. forgectl's loop/condition nodes are implemented in-process using SQLite state. The scope is depth-2 delegation with simple boolean conditions — not enterprise workflow orchestration. |
| Any LLM SDK (LangChain, LlamaIndex, Vercel AI SDK) | forgectl's agents are subprocess-invoked CLI tools, not API clients. LLM SDKs assume you own the model call. This project does not. |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `filtrex` ^3.1.0 | Node.js 20+, ESM | Ships `.mjs` entry, TypeScript declarations. No known conflicts with existing stack. Zero deps. |

---

## Integration Points

| Existing Subsystem | How v2.1 Touches It |
|-------------------|---------------------|
| `src/pipeline/types.ts` | Add `type`, `condition`, `if_branch`, `else_branch`, `until`, `max_iterations`, `condition_source` fields to `PipelineNode`. Add `"loop-iterating"` to `NodeExecution.status`. |
| `src/pipeline/executor.ts` | Add `executeConditionNode()` and `executeLoopNode()` methods. Import `filtrex` for condition evaluation. |
| `src/pipeline/dag.ts` | `validateDAG` must accept loop nodes without treating them as cycles. Condition nodes with `if_branch`/`else_branch` reference other node IDs — validate those references exist. |
| `src/storage/schema.ts` | Add `parentRunId`, `delegationDepth` columns to `runs` table. Add `delegationBudgets` table. |
| `src/orchestrator/worker.ts` | `executeWorker` is called by delegation service unchanged. No modification to the function signature — delegation is a caller-level concern. |
| `src/orchestrator/dispatcher.ts` | Extend to handle delegated child runs: check depth, check budget, call `DelegationService`. |
| `src/validation/runner.ts` | No changes. `runValidationLoop` is the within-node correction primitive. The loop pipeline node calls `executeWorker` (which calls `runValidationLoop`) on each iteration. |
| `src/governance/autonomy.ts` | Child runs inherit autonomy from parent context. `GovernanceOpts` passed through to child `executeWorker` calls. |

---

## Sources

- [filtrex on npm](https://www.npmjs.com/package/filtrex) — v3.1.0, published 2024-10-14, zero deps, ESM + TypeScript
- [filtrex GitHub](https://github.com/joewalnes/filtrex) — boolean expression DSL, safety guarantees, custom function injection
- [jexl on npm](https://www.npmjs.com/package/jexl) — v2.3.0, last published 2020-09-15 (stale, not recommended)
- [expr-eval on npm](https://www.npmjs.com/package/expr-eval) — v2.0.2, math DSL (wrong fit for boolean conditions)
- [Drizzle ORM self-referential FK](https://gebna.gg/blog/self-referencing-foreign-key-typescript-drizzle-orm) — verified pattern for `runs.parentRunId`
- [Drizzle ORM relations v2](https://orm.drizzle.team/docs/relations-v2) — current docs for relational queries
- [Azure AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — supervisor/hierarchical pattern rationale
- [AWS prescriptive guidance: evaluator reflect-refine loop](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html) — self-correction loop patterns
- npm registry (`npm info`) — version and publish date verification for all packages listed above

---
*Stack research for: forgectl v2.1 — multi-agent delegation, conditional/loop pipeline nodes, pipeline self-correction*
*Researched: 2026-03-12*
