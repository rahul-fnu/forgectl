---
phase: 21-conditional-pipeline-nodes
plan: "01"
subsystem: pipeline
tags: [condition-evaluator, filtrex, dag-validation, shorthand-expansion, tdd]
dependency_graph:
  requires: [20-01]
  provides: [condition-evaluator, shorthand-expansion, else-node-validation, buildDependentsMap]
  affects: [pipeline/parser, pipeline/dag, pipeline/executor]
tech_stack:
  added: [filtrex (first import in src/)]
  patterns: [filtrex compileExpression with customProp hook, TDD red-green]
key_files:
  created:
    - src/pipeline/condition.ts
    - test/unit/pipeline-condition.test.ts
  modified:
    - src/pipeline/dag.ts
    - src/pipeline/parser.ts
decisions:
  - "filtrex returns errors-as-values (catches internally) — must inspect result instanceof Error after calling compiled fn"
  - "customProp hook checks name in obj at runtime, throws ConditionVariableError for unknown nodes"
  - "else_node cycle detection: add else_node edges to DFS adjacency map alongside depends_on edges"
  - "expandShorthands builds new node objects — does not mutate originals (Zod objects may be frozen)"
  - "Cycle test must have both a depends_on edge and an else_node edge in opposite directions to form a real cycle"
metrics:
  duration: "5m 11s"
  completed: "2026-03-13"
  tasks_completed: 2
  files_changed: 4
---

# Phase 21 Plan 01: Condition Evaluator and DAG Validation Summary

Condition evaluation module using filtrex, shorthand expansion at parse time, and DAG validation for else_node references.

## What Was Built

### src/pipeline/condition.ts (new)

Exports `evaluateCondition`, `expandShorthands`, `ConditionSyntaxError`, `ConditionVariableError`, and `NodeStatusContext` type.

**`evaluateCondition(expression, context)`** wraps filtrex `compileExpression` with a `customProp` hook that throws `ConditionVariableError` for unknown node references at expression-evaluation time. Key gotcha: filtrex catches errors thrown from `customProp` and returns them as the result value rather than rethrowing — the implementation must check `result instanceof Error` after calling the compiled function.

**`expandShorthands(pipeline)`** is a post-parse transform. `if_failed: "test"` becomes `condition: 'test == "failed"'` with `test` auto-added to `depends_on`. `if_passed: "build"` becomes `condition: 'build == "completed"'`. Throws when both `condition` and a shorthand field are set (mutually exclusive). Returns a new `PipelineDefinition` without mutating originals.

### src/pipeline/dag.ts (modified)

- `buildDependentsMap` exported (was private) — Plan 21-02 executor needs it for the ready-queue
- `validateDAG` extended with else_node checks:
  - `else_node` referencing unknown node ID → error
  - `else_node` referencing itself → error
  - else_node edges added to DFS adjacency map so cycles through else paths are detected

### src/pipeline/parser.ts (modified)

`parsePipelineYaml` now calls `expandShorthands(parsed)` after Zod schema parse. Downstream code (including Plan 21-02 executor) only ever sees `condition` strings — `if_failed` and `if_passed` are invisible at runtime.

### test/unit/pipeline-condition.test.ts (new, 194 lines)

24 tests across 4 describe blocks: `evaluateCondition`, `expandShorthands`, `validateDAG — else_node validation`, and `parsePipelineYaml — shorthand expansion`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] filtrex catches customProp errors internally**
- **Found during:** Task 1 GREEN phase
- **Issue:** filtrex wraps the entire compiled function call in `try/catch` and returns the error as the result value rather than rethrowing. The initial implementation assumed errors from `customProp` would propagate through — they don't.
- **Fix:** After calling `compiledFn(context)`, check `result instanceof ConditionVariableError` and `result instanceof Error` and rethrow appropriately.
- **Files modified:** src/pipeline/condition.ts
- **Commit:** ac6fe8b

**2. [Rule 1 - Bug] Cycle test constructed an invalid scenario**
- **Found during:** Task 2 verification
- **Issue:** The initial test for "cycle through else_node" used `b.depends_on: ["a"]` and `b.else_node: "a"` — this creates two `b -> a` edges in the DFS adjacency map but no edge from `a` to `b`, so no cycle exists. The test expected `valid: false` but got `valid: true`.
- **Fix:** Restructured test: `a.depends_on: ["b"]` (a -> b in DFS) and `b.else_node: "a"` (b -> a in DFS) — these two edges form the cycle.
- **Files modified:** test/unit/pipeline-condition.test.ts
- **Commit:** 8d69066

## Test Results

All 1064 tests pass (93 test files, 2 skipped). TypeScript typecheck clean. No regressions.

## Self-Check: PASSED

- src/pipeline/condition.ts — FOUND
- test/unit/pipeline-condition.test.ts — FOUND
- Commit ac6fe8b — FOUND
- Commit 8d69066 — FOUND
