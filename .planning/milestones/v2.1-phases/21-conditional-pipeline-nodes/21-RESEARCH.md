# Phase 21: Conditional Pipeline Nodes - Research

**Researched:** 2026-03-13
**Domain:** Pipeline executor refactor, expression evaluation (filtrex), runtime branching
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Condition expressions reference **upstream node statuses only** — values are `"completed"`, `"failed"`, or `"skipped"`
- Only nodes in the transitive `depends_on` chain are available as variables — referencing a non-dependency is a fatal validation error
- Unknown/unresolvable variable names cause the pipeline to fail immediately with a clear error (no silent falsy evaluation)
- Full boolean combinators supported — `and`, `or`, `not` via filtrex's native support
- `if_failed` / `if_passed` take a **specific node ID** as their value (e.g., `if_failed: test` → `condition: 'test == "failed"'`)
- The referenced node is **auto-added to depends_on** if not already present
- `if_failed`/`if_passed` and `condition` are **mutually exclusive** — using both is a validation error
- Shorthand expansion happens at **parse time** — rest of system only ever sees `condition` strings
- **Cascade skip**: if a node is skipped (condition false), all downstream dependents are also skipped
- If a node has multiple dependencies and **any** dependency was skipped, the node is skipped (conservative model)
- `else_node` is an alternative execution path — when condition is false, the conditional node is skipped but `else_node` is activated
- Distinct skip reasons: condition-based skips include the expression, cascade skips name the skipped dependency
- `--dry-run` assumes happy path (all nodes complete successfully) and shows which conditional nodes would be skipped
- Dry-run validates condition expressions and else_node references
- Condition annotations shown **only on conditional nodes** in dry-run output

### Claude's Discretion
- Exact filtrex configuration and custom function setup
- Ready-queue data structure choice (priority queue, linked list, etc.)
- How to build the upstream status context object for filtrex evaluation
- Internal error message formatting
- Whether to add a `resolvedCondition` field to NodeExecution for debugging

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| COND-01 | PipelineNode supports `condition` field with safe expression evaluation (filtrex) | `PipelineNode.condition` field exists in types.ts; filtrex ^3.1.0 installed; `compileExpression` API verified |
| COND-02 | Executor refactored from static topological sort to ready-queue model for runtime branching | Current executor loop at lines 113-151 uses static topo-sort; ready-queue pattern documented below |
| COND-03 | `else_node` field routes execution to alternate branch when condition is false | `PipelineNode.else_node` field exists; else activation logic belongs in condition evaluator / ready-queue |
| COND-04 | `if_failed` / `if_passed` YAML shorthand resolves to condition expressions | Fields exist in schema; expansion must be added as post-parse transform in parser.ts |
| COND-05 | Skipped nodes marked as `skipped` status (visible in pipeline status and API) | `NodeExecution.status: "skipped"` and `skipReason` already exist; routes.ts surfaces them automatically |
| COND-06 | Condition evaluation errors are fatal (no silent skipping) | filtrex throws on compile failure; runtime unknown-variable must be caught and re-thrown as pipeline fatal |
| COND-07 | `--dry-run` shows which nodes would be skipped given hypothetical conditions | `buildDryRunResult()` exists; must be extended to simulate happy-path conditions and annotate conditional nodes |
</phase_requirements>

---

## Summary

Phase 21 adds conditional branching to the pipeline executor. The schema work (COND-01, COND-03, COND-04 field definitions) is already complete in `src/pipeline/types.ts` and `src/pipeline/parser.ts` from Phase 20 — those fields accept the YAML values, but no evaluation logic exists yet.

The two main deliverables are `src/pipeline/condition.ts` (a new module for expression evaluation wrapping filtrex) and a refactor of the main execution loop in `src/pipeline/executor.ts` from a static topological-sort iteration to a ready-queue model. The ready-queue model is the architectural prerequisite that allows the executor to decide which nodes are runnable at runtime, after each node completes, rather than pre-computing a fixed order.

The third deliverable is shorthand expansion (`if_failed`/`if_passed` → `condition`) added as a post-parse transform in `src/pipeline/parser.ts`, so downstream code never needs to handle the shorthand fields.

**Primary recommendation:** Build condition.ts as a pure, testable module with a single `evaluateCondition(expression, upstreamStatuses)` function, then wire it into the ready-queue executor. Keep the ready-queue as a simple `Set<string>` of ready node IDs, seeded from topo-sort roots, and re-evaluated after each node terminal event.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| filtrex | ^3.1.0 | Safe expression evaluation | Already installed (Phase 20); zero-deps, ESM, boolean-first, sandboxed — cannot access JS internals |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | — | All other dependencies are pre-existing | — |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| filtrex | expr-eval | filtrex chosen in Phase 20; do not revisit |
| filtrex | mathjs | same — chosen is filtrex |

**No new installation needed.** filtrex is already in `node_modules` and `package.json`.

---

## Architecture Patterns

### Recommended Project Structure (new file)
```
src/pipeline/
├── condition.ts    ← NEW: filtrex wrapper, shorthand expansion helpers
├── executor.ts     ← MODIFY: replace static loop with ready-queue
├── parser.ts       ← MODIFY: add post-parse shorthand expansion + validation
├── dag.ts          ← MODIFY: extend validateDAG for else_node validation
├── types.ts        ← no change (fields already declared)
```

### Pattern 1: condition.ts — Pure Evaluator Module

**What:** Wraps filtrex `compileExpression` with strict unknown-variable detection. Receives the expression string and a `Record<string, "completed" | "failed" | "skipped">` context object of upstream statuses.

**When to use:** Called from executor whenever a node with a `condition` field is about to be dispatched.

**Key implementation notes:**
- filtrex's `customProp` hook is the correct extension point for intercepting unknown variable access. When `customProp` is called with a name that is not a key in the context object, throw a typed `ConditionVariableError`. This makes unknown variable access fatal rather than silently undefined.
- `compileExpression` itself throws on syntax errors — catch this and wrap as `ConditionSyntaxError`.
- Return type: `boolean` (truthy filtrex result cast to bool).

```typescript
// Source: node_modules/filtrex/dist/esm/filtrex.d.ts
import { compileExpression, type Options } from "filtrex";

export type NodeStatusContext = Record<string, "completed" | "failed" | "skipped">;

export class ConditionSyntaxError extends Error {
  constructor(expression: string, cause: unknown) {
    super(`Condition syntax error in "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class ConditionVariableError extends Error {
  constructor(varName: string, expression: string) {
    super(`Condition references unknown or non-dependency node "${varName}" in expression: ${expression}`);
  }
}

export function evaluateCondition(expression: string, context: NodeStatusContext): boolean {
  const opts: Options = {
    customProp: (name, get, obj) => {
      if (!(name in obj)) throw new ConditionVariableError(name, expression);
      return get(name);
    },
  };

  let compiled: (obj: any) => any;
  try {
    compiled = compileExpression(expression, opts);
  } catch (err) {
    throw new ConditionSyntaxError(expression, err);
  }

  let result: unknown;
  try {
    result = compiled(context);
  } catch (err) {
    // Re-throw ConditionVariableError directly; wrap others
    if (err instanceof ConditionVariableError) throw err;
    throw new Error(`Condition evaluation failed for "${expression}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return Boolean(result);
}
```

**Note on filtrex string comparison:** Filtrex uses `==` for equality with string values. The expression `build == "completed"` works correctly — the context value `"completed"` is a string and filtrex's `==` handles string-to-string comparison. Verified from type definitions.

### Pattern 2: Shorthand Expansion at Parse Time

**What:** After Zod parsing succeeds, a `expandShorthands(pipeline)` function transforms `if_failed`/`if_passed` fields into `condition` strings and auto-adds the referenced node to `depends_on`.

**When to use:** Called immediately after `PipelineSchema.parse(data)` in `parsePipelineYaml`.

**Key implementation notes:**
- Expansion is a pure data transform — mutate a deep clone or build new node objects.
- Mutual exclusivity check: if a node has both `condition` and (`if_failed` or `if_passed`), throw a parse-time error.
- After expansion, `if_failed` and `if_passed` fields are removed (or left undefined) so the rest of the system never sees them.

```typescript
function expandShorthands(pipeline: PipelineDefinition): PipelineDefinition {
  const expandedNodes = pipeline.nodes.map(node => {
    const hasBothShorthandAndCondition =
      (node.if_failed !== undefined || node.if_passed !== undefined) &&
      node.condition !== undefined;

    if (hasBothShorthandAndCondition) {
      throw new Error(
        `Node "${node.id}": cannot use both "condition" and "if_failed"/"if_passed" — they are mutually exclusive`
      );
    }

    if (node.if_failed !== undefined) {
      const targetId = node.if_failed;
      const deps = node.depends_on ?? [];
      return {
        ...node,
        condition: `${targetId} == "failed"`,
        depends_on: deps.includes(targetId) ? deps : [...deps, targetId],
        if_failed: undefined,
      };
    }

    if (node.if_passed !== undefined) {
      const targetId = node.if_passed;
      const deps = node.depends_on ?? [];
      return {
        ...node,
        condition: `${targetId} == "completed"`,
        depends_on: deps.includes(targetId) ? deps : [...deps, targetId],
        if_passed: undefined,
      };
    }

    return node;
  });

  return { ...pipeline, nodes: expandedNodes };
}
```

### Pattern 3: Ready-Queue Executor Refactor

**What:** Replace the static `for (const nodeId of order)` loop in `execute()` (lines 113-151) with an event-driven ready-queue that re-evaluates which nodes become runnable after each node terminates.

**When to use:** This is the COND-02 requirement. The current loop cannot skip nodes based on runtime condition results — it pre-computes a fixed iteration order.

**Conceptual structure:**

```typescript
// Replace lines 89-154 of executor.ts

const nodeMap = new Map(this.pipeline.nodes.map(n => [n.id, n]));
const dependentsMap = buildDependentsMap(this.pipeline); // already in dag.ts
const inFlight = new Map<string, Promise<void>>();
const maxParallel = this.options.maxParallel ?? 3;

// Seed the ready queue: nodes with no dependencies
const readyQueue = new Set<string>(
  this.pipeline.nodes
    .filter(n => (n.depends_on ?? []).length === 0)
    .filter(n => selection.executeNodes.has(n.id))
    .map(n => n.id)
);

const processNode = async (nodeId: string): Promise<void> => {
  const node = nodeMap.get(nodeId)!;
  const conditionResult = this.evaluateNodeCondition(node);

  if (conditionResult === "skip") {
    this.markSkippedWithCondition(node);
    this.propagateCascadeSkip(nodeId, dependentsMap, nodeMap, selection);
  } else if (conditionResult === "else") {
    this.markSkippedWithCondition(node);
    // Activate else_node: add it to readyQueue if all its deps are done
    if (node.else_node) {
      this.tryEnqueueNode(node.else_node, nodeMap, readyQueue, selection);
    }
  } else {
    await this.executeNode(node);
  }

  // After terminal state, enqueue newly-ready dependents
  inFlight.delete(nodeId);
  for (const dep of dependentsMap.get(nodeId) ?? []) {
    if (this.isNodeReady(dep, nodeMap, selection)) {
      readyQueue.add(dep);
    }
  }
};

// Drain loop
while (readyQueue.size > 0 || inFlight.size > 0) {
  // Drain up to maxParallel
  for (const nodeId of [...readyQueue]) {
    if (inFlight.size >= maxParallel) break;
    readyQueue.delete(nodeId);
    const promise = processNode(nodeId).then(() => { inFlight.delete(nodeId); });
    inFlight.set(nodeId, promise);
  }
  if (inFlight.size > 0) {
    await Promise.race(inFlight.values());
  }
}
```

**isNodeReady check:**
- All `depends_on` are in terminal state (`completed`, `failed`, `skipped`)
- Node is in `selection.executeNodes`
- Node has not already been processed (not in nodeStates with a terminal status)
- Not already in `inFlight`

### Pattern 4: Condition-Aware getDependencyIssues / Cascade Skip

**What:** The current `getDependencyIssues()` already treats skipped deps (without hydrated output) as issues, but cascade skip needs distinct logic to avoid conflating condition-based skips with checkpoint-based skips.

**Key distinction:**
- `skipReason` starting with `"condition false:"` or `"dependency X was skipped"` = condition cascade
- `skipReason` starting with `"Hydrated from checkpoint"` = checkpoint reuse (valid, not a cascade trigger)

The conservative cascade model (any skipped dep → cascade skip) should check whether the skip was condition-derived, not checkpoint-hydrated.

```typescript
private isCascadeSkip(depState: NodeExecution): boolean {
  // Checkpoint-hydrated skips are treated as "completed successfully"
  if (depState.hydratedFromCheckpoint) return false;
  return depState.status === "skipped";
}
```

### Pattern 5: DAG Validation for else_node

**What:** Extend `validateDAG()` in `dag.ts` to validate `else_node` references.

**Rules to enforce:**
1. `else_node` must refer to an existing node ID
2. `else_node` must not reference itself (`node.id !== node.else_node`)
3. `else_node` must not create a cycle (the else edge counts as a dependency edge for cycle detection)
4. `else_node` must be a non-dependency of the conditional node (else path is an alternative, not a re-execution of an ancestor)

### Pattern 6: Condition Variable Scope Validation

**What:** At parse/validate time, verify that each identifier in a `condition` expression refers only to nodes in the transitive `depends_on` ancestry. This is a pre-execution check — runtime unknown-variable detection in `customProp` is the safety net.

**Approach:** Extract identifiers from the expression by running a static analysis pass. The simplest approach that matches filtrex's identifier rules: parse identifiers as word sequences not adjacent to quotes. A lightweight regex scan (`/\b([a-z][a-z0-9-]*)\b/gi`) filtered against filtrex keywords (`and`, `or`, `not`, `in`, etc.) gives the variable names referenced. Check each against `collectAncestors(pipeline, nodeId)`.

**When to do this:** In `validateDAG()`, after else_node checks, or in a dedicated `validateConditions()` function called from `execute()` before the run starts.

### Pattern 7: Dry-Run with Condition Annotations

**What:** Extend `buildDryRunResult()` in executor.ts to simulate happy-path execution and show condition annotations.

**Happy path assumption:** Every executed node is treated as `"completed"` for condition evaluation purposes.

**Algorithm:**
1. Walk topo-sorted order
2. For each conditional node, build context from its ancestor statuses (all "completed" on happy path)
3. Evaluate the condition; if false, mark as would-skip and don't propagate to dependents in simulation
4. Print annotation: `SKIP (condition: build == "completed" → false on happy path)` vs `RUN`
5. Validate all `else_node` references and condition expressions even in dry-run (COND-07 validation requirement)

### Anti-Patterns to Avoid

- **Silent falsy for unknown vars:** filtrex returns `undefined` by default for unknown properties; this would silently evaluate to falsy and skip nodes without error. The `customProp` hook MUST be used to make this fatal.
- **Re-compiling expressions per node execution:** `compileExpression` parses the expression; cache the compiled function per expression string if performance matters (unlikely at pipeline scale, but clean).
- **Cascade skip overwriting hydrated-checkpoint skips:** When iterating dependents for cascade skip, check `hydratedFromCheckpoint` before overwriting state.
- **Else_node bypass of dependency checks:** The `else_node` target still has its own `depends_on` — activating an else_node just means it becomes eligible to be enqueued; it still waits for its own declared dependencies.
- **Modifying pipeline.nodes in place during shorthand expansion:** Zod-parsed objects may be frozen or shared; build new node objects, don't mutate.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Safe expression eval | Custom expression parser | filtrex `compileExpression` | Sandbox, no prototype access, handles `and`/`or`/`not`, string equality all built-in |
| Topo-sort | Re-implement | `topologicalSort()` from dag.ts | Already correct Kahn's algorithm |
| Ancestor collection | DFS from scratch | `collectAncestors()` from dag.ts | Already handles transitive closure |
| Descendant collection | DFS from scratch | `collectDescendants()` from dag.ts | Used for cascade skip propagation |
| Cycle detection | Custom | `detectCycle()` inside `validateDAG()` | Re-entrant; extend validateDAG, don't duplicate |

**Key insight:** filtrex is the reason we don't write our own expression evaluator. It handles operator precedence, string quoting, boolean combinators, and prototype-safe property access. The `customProp` hook is the extension point that makes it work for our strict variable-scoping requirement.

---

## Common Pitfalls

### Pitfall 1: filtrex Returns Numbers, Not Booleans
**What goes wrong:** `compileExpression('a == "completed"')({ a: "completed" })` returns `1` not `true`. Casting to `Boolean(result)` is required.
**Why it happens:** filtrex documentation notes "boolean logic is applied on truthy value of values (e.g. any non-zero number is true)". The internal result of boolean operations is numeric 1/0.
**How to avoid:** Always `return Boolean(result)` in `evaluateCondition`. Confirmed from type definitions: return type is `any`.
**Warning signs:** Test `expect(evaluateCondition(...)).toBe(true)` fails when using strict equality.

### Pitfall 2: Unknown Variables Return undefined Without customProp
**What goes wrong:** If `customProp` is not provided, filtrex returns `undefined` for unknown identifiers. `Boolean(undefined)` is `false` — the node would be silently skipped.
**Why it happens:** filtrex default behavior is permissive — designed for filtering objects where some properties may be absent.
**How to avoid:** Always provide `customProp` that throws on any name not present in the context object.
**Warning signs:** Condition with typo in node name evaluates to false with no error.

### Pitfall 3: else_node Activation Bypassing Dependency Checks
**What goes wrong:** When a condition is false and we activate `else_node`, the else_node might reference dependencies that haven't run yet (e.g., it has its own `depends_on`).
**Why it happens:** else_node activation means "this node is now eligible", not "all its deps are done".
**How to avoid:** The ready-queue `isNodeReady()` check naturally handles this — else_node only enters the ready queue when its own `depends_on` are all terminal.
**Warning signs:** else_node starts executing before its own dependencies are complete.

### Pitfall 4: Race Condition in Ready-Queue Drain Loop
**What goes wrong:** After `await Promise.race(inFlight.values())`, one promise resolved but others may have resolved concurrently. Newly-ready nodes from all resolved promises must be enqueued before re-draining.
**Why it happens:** `Promise.race` only tells us "at least one resolved"; multiple may have resolved simultaneously.
**How to avoid:** `inFlight.delete` happens inside the `.then()` callback of each promise, so the inFlight map is updated immediately. Re-check `readyQueue` after every race resolution, not just once.
**Warning signs:** Nodes that should be parallelizable instead execute sequentially.

### Pitfall 5: Condition Validation Scope Creep at Validate Time
**What goes wrong:** Implementing full AST-level variable extraction for scope validation is complex and fragile.
**Why it happens:** Temptation to be thorough at parse time.
**How to avoid:** Use a lightweight regex to extract likely identifiers from the condition string, then cross-check against `collectAncestors()`. The `customProp` runtime hook is the authoritative enforcement; parse-time check is a developer UX improvement only. A false negative from the regex (missing a variable) is caught at runtime.
**Warning signs:** Overly complex condition validation logic with many edge cases.

### Pitfall 6: noUnusedLocals Lint Error on filtrex Import
**What goes wrong:** If condition.ts imports filtrex but the import is not used (e.g., during partial implementation), `tsc --noEmit` fails with `noUnusedLocals: true`.
**Why it happens:** Phase 20 STATE.md explicitly documented this: "filtrex installed but not imported in any src/ file — noUnusedLocals:true would error; Phase 21 adds the import."
**How to avoid:** Phase 21 plan 21-01 creates condition.ts with a real import and use before plan completion. Do not import-and-leave-unused mid-plan.
**Warning signs:** `npm run typecheck` fails after partial implementation.

---

## Code Examples

Verified patterns from official sources:

### filtrex Basic Usage
```typescript
// Source: node_modules/filtrex/dist/esm/filtrex.d.ts
import { compileExpression } from "filtrex";

const fn = compileExpression('build == "completed" and test == "completed"');
fn({ build: "completed", test: "completed" }); // returns 1 (truthy)
fn({ build: "completed", test: "failed" });    // returns 0 (falsy)
```

### filtrex customProp for strict variable scoping
```typescript
// Source: node_modules/filtrex/dist/esm/filtrex.d.ts (customProp signature)
import { compileExpression, type Options } from "filtrex";

const opts: Options = {
  customProp: (name, get, obj) => {
    if (!(name in obj)) {
      throw new Error(`Unknown variable: "${name}"`);
    }
    return get(name);
  },
};

const fn = compileExpression('build == "completed"', opts);
fn({ build: "completed" }); // returns 1
fn({ typo: "completed" });  // throws Error: Unknown variable: "build"
```

### Ready-Queue Pattern (existing dag.ts building block)
```typescript
// Source: src/pipeline/dag.ts — topologicalSort (Kahn's algorithm)
// The ready-queue executor replicates the "process queue" pattern from topologicalSort
// but executes nodes as they become ready instead of collecting IDs.

// Existing dependentsMap builder in dag.ts (private — may need export):
// buildDependentsMap(pipeline): Map<string, string[]>
// returns: dep -> [nodes that depend on dep]
```

### Extending validateDAG for else_node
```typescript
// Source: src/pipeline/dag.ts — validateDAG pattern
// Add after existing check #2 (depends_on references):

for (const node of pipeline.nodes) {
  if (node.else_node !== undefined) {
    if (!nodeIds.has(node.else_node)) {
      errors.push(`Node "${node.id}" else_node references unknown node "${node.else_node}"`);
    }
    if (node.else_node === node.id) {
      errors.push(`Node "${node.id}" else_node cannot reference itself`);
    }
  }
}
// Cycle detection for else_node edges: include else_node in adjacency map
// (adj.get(node.id)?.push(node.else_node)) before running detectCycle
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static topo-sort loop (lines 113-151) | Ready-queue drain loop | Phase 21 (this phase) | Enables runtime branching, condition evaluation, else routing |
| No condition field | `condition`, `else_node`, `if_failed`, `if_passed` fields on PipelineNode | Phase 20 (types only) | Schema ready; evaluation logic is new in Phase 21 |
| filtrex installed but unused | First import in condition.ts | Phase 21 (this phase) | Resolves noUnusedLocals deferred from Phase 20 |

**Deprecated/outdated:**
- The `for (const nodeId of order)` loop in `execute()` (lines 113-151): replaced entirely by ready-queue. The `topologicalSort` call on line 89 remains in use for dry-run, rerun-selection, and seeding the initial ready set.

---

## Open Questions

1. **Does `buildDependentsMap` need to be exported from dag.ts?**
   - What we know: It's currently a private function in dag.ts. The ready-queue executor needs it.
   - What's unclear: Whether to export it or inline a similar structure in executor.ts.
   - Recommendation: Export it from dag.ts — it's logically the same layer, and it avoids duplication.

2. **Should `resolvedCondition` be added to NodeExecution for debugging?**
   - What we know: CONTEXT.md marks this as Claude's discretion.
   - What's unclear: Tradeoff between API surface growth and debuggability.
   - Recommendation: Add it — a `conditionResult?: { expression: string; evaluated: boolean }` field on NodeExecution is lightweight and saves significant debugging time.

3. **How should the dry-run condition simulation handle nodes whose ancestors are in the `else_node` alternate path?**
   - What we know: Happy-path assumes all nodes complete. Else_node activation only happens when a condition is false — which conflicts with "assume all nodes complete".
   - What's unclear: Whether dry-run should simulate the false-condition path for conditional nodes to show what else paths look like.
   - Recommendation: Per CONTEXT.md, dry-run shows "which nodes would be skipped given happy path" — meaning all conditions evaluate true (since all deps are "completed"). Else paths are shown as would-skip. The value is primarily catching typos and validating structure, not simulating all branches.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.0 |
| Config file | vitest.config.ts (or package.json scripts) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/pipeline-executor.test.ts test/unit/pipeline-condition.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| COND-01 | `evaluateCondition` returns true/false for valid expressions | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | Wave 0 |
| COND-01 | Syntax error in condition throws ConditionSyntaxError | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | Wave 0 |
| COND-02 | Ready-queue executes nodes in correct dependency order | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | exists |
| COND-02 | Ready-queue respects maxParallel limit | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | exists |
| COND-03 | else_node activated when condition is false | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |
| COND-04 | `if_failed: test` expands to `condition: 'test == "failed"'` at parse time | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | Wave 0 |
| COND-04 | `if_passed: build` auto-adds build to depends_on | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | Wave 0 |
| COND-04 | Using both condition and if_failed throws parse error | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | Wave 0 |
| COND-05 | Skipped-by-condition node has status "skipped" and skipReason with expression | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |
| COND-05 | Cascade-skipped nodes have status "skipped" with dependency name in skipReason | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |
| COND-06 | Unknown variable in condition causes pipeline to fail immediately | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |
| COND-07 | dry-run validates condition expressions; typo in node name is caught | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |
| COND-07 | dry-run shows SKIP annotation only on conditional nodes | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | extend |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/pipeline-executor.test.ts test/unit/pipeline-condition.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/pipeline-condition.test.ts` — covers COND-01, COND-04 (new evaluator module tests)
  - Tests: evaluateCondition truthy/falsy, ConditionSyntaxError, ConditionVariableError, if_failed expansion, if_passed expansion, mutual exclusivity error

*(Existing `test/unit/pipeline-executor.test.ts` covers COND-02 base cases; it needs extension for COND-03, COND-05, COND-06, COND-07 but the file already exists.)*

---

## Sources

### Primary (HIGH confidence)
- `/home/claude/forgectl-dev/node_modules/filtrex/dist/esm/filtrex.d.ts` — full filtrex API: compileExpression, Options, customProp signature, operator semantics
- `/home/claude/forgectl-dev/src/pipeline/types.ts` — confirmed: condition, else_node, if_failed, if_passed, NodeExecution.status skipped, skipReason all present
- `/home/claude/forgectl-dev/src/pipeline/executor.ts` — confirmed: static topo-sort loop location (lines 113-151), getDependencyIssues, buildDryRunResult, inFlight Map pattern
- `/home/claude/forgectl-dev/src/pipeline/dag.ts` — confirmed: topologicalSort, validateDAG, collectAncestors, collectDescendants, buildDependentsMap (private), detectCycle
- `/home/claude/forgectl-dev/src/pipeline/parser.ts` — confirmed: no shorthand expansion exists yet; PipelineSchema accepts all fields

### Secondary (MEDIUM confidence)
- `.planning/phases/21-conditional-pipeline-nodes/21-CONTEXT.md` — authoritative decisions from user discussion session

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — filtrex verified from installed type definitions, all other dependencies are project-existing
- Architecture: HIGH — patterns derived from reading actual source code of executor.ts, dag.ts, parser.ts, types.ts
- Pitfalls: HIGH — filtrex numeric return type verified from d.ts; customProp requirement verified from API; noUnusedLocals issue documented in STATE.md

**Research date:** 2026-03-13
**Valid until:** 2026-06-13 (filtrex ^3.1.0 is stable; pipeline code is project-internal)
