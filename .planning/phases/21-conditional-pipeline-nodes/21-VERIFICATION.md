---
phase: 21-conditional-pipeline-nodes
verified: 2026-03-13T04:35:00Z
status: passed
score: 13/13 must-haves verified
re_verification: false
---

# Phase 21: Conditional Pipeline Nodes Verification Report

**Phase Goal:** Pipeline YAML supports if/else branch routing — the executor evaluates conditions at runtime, skips false-branch nodes, surfaces skip status in the API, and treats condition errors as fatal
**Verified:** 2026-03-13T04:35:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth                                                                                              | Status     | Evidence                                                                                              |
|----|----------------------------------------------------------------------------------------------------|------------|-------------------------------------------------------------------------------------------------------|
| 1  | A condition expression evaluates to true/false against upstream node statuses                      | VERIFIED   | `evaluateCondition()` in condition.ts wraps filtrex with customProp; returns Boolean; tests pass      |
| 2  | A syntax error in a condition expression throws ConditionSyntaxError immediately                  | VERIFIED   | compileExpression() errors wrapped as ConditionSyntaxError; test "throws ConditionSyntaxError" passes |
| 3  | Referencing a node not in depends_on ancestry throws ConditionVariableError                        | VERIFIED   | customProp hook throws ConditionVariableError; filtrex error-as-value pattern handled correctly       |
| 4  | if_failed/if_passed expands to condition string and auto-adds depends_on at parse time            | VERIFIED   | expandShorthands() called in parsePipelineYaml; 6 expansion tests all pass                           |
| 5  | Using both condition and if_failed on the same node throws a parse-time error                     | VERIFIED   | expandShorthands() throws "mutually exclusive"; 2 tests verify this                                  |
| 6  | else_node references validated: must exist, no self-reference, no cycles                          | VERIFIED   | validateDAG extended with 3 checks; 3 dag tests pass                                                 |
| 7  | Nodes with false conditions are skipped with status 'skipped' and skipReason containing expression | VERIFIED   | processNode() sets status:skipped, skipReason: 'condition false: ${expr}'; test passes               |
| 8  | When a node is skipped by condition, downstream dependents are cascade-skipped                     | VERIFIED   | propagateCascadeSkip() traverses dependentsMap; "cascade skip" test verifies B and C both skipped    |
| 9  | When condition is false and else_node set, conditional node skipped but else_node activated        | VERIFIED   | else_node enqueued in readyQueue when condition false; test "condition false + else_node" passes      |
| 10 | Checkpoint-hydrated skips are NOT treated as cascade skip triggers                                 | VERIFIED   | getDependencyBlockReason checks result?.success && result.output; "checkpoint-hydrated" test passes  |
| 11 | A malformed condition expression causes the pipeline run to fail immediately                       | VERIFIED   | pipeline_state.status = "failed" on catch; drain loop breaks; "unknown variable" test passes         |
| 12 | dry-run validates condition expressions and shows SKIP/RUN annotations on conditional nodes only  | VERIFIED   | buildDryRunResult() simulates happy-path; annotations only on nodes with condition field             |
| 13 | Skip status is visible in the API response                                                         | VERIFIED   | executor.getNodeStates() included in pipeline-service.ts API response at line 68                     |

**Score:** 13/13 truths verified

### Required Artifacts

| Artifact                                  | Min Lines | Actual | Status     | Details                                                                         |
|-------------------------------------------|-----------|--------|------------|---------------------------------------------------------------------------------|
| `src/pipeline/condition.ts`               | —         | 117    | VERIFIED   | Exports evaluateCondition, expandShorthands, ConditionSyntaxError, ConditionVariableError, NodeStatusContext |
| `src/pipeline/dag.ts`                     | —         | 275    | VERIFIED   | buildDependentsMap exported (line 218); validateDAG extended with else_node checks (lines 30-43, 82-84) |
| `src/pipeline/parser.ts`                  | —         | 61     | VERIFIED   | expandShorthands imported from condition.ts; called in parsePipelineYaml after Zod parse (line 60) |
| `src/pipeline/executor.ts`                | 200       | 885    | VERIFIED   | Ready-queue drain loop; evaluateCondition called; cascade skip; dry-run annotations |
| `test/unit/pipeline-condition.test.ts`    | 80        | 267    | VERIFIED   | 24 tests: evaluateCondition (8), expandShorthands (8), validateDAG-else_node (4), parsePipelineYaml (3) |
| `test/unit/pipeline-executor.test.ts`     | 100       | 421    | VERIFIED   | 19 total tests; 9 new conditional tests: condition true/false, else_node, cascade, fatal error, dry-run, checkpoint |

### Key Link Verification

| From                          | To                          | Via                                        | Status   | Details                                                               |
|-------------------------------|-----------------------------|--------------------------------------------|----------|-----------------------------------------------------------------------|
| `src/pipeline/condition.ts`   | filtrex                     | compileExpression with customProp hook     | WIRED    | `compileExpression(expression, { customProp(name, _get, obj) {...} })` at line 44 |
| `src/pipeline/parser.ts`      | `src/pipeline/condition.ts` | expandShorthands called after Zod parse    | WIRED    | `import { expandShorthands } from "./condition.js"` at line 5; `return expandShorthands(parsed)` at line 60 |
| `src/pipeline/dag.ts`         | else_node validation        | validateDAG checks else_node refs & cycles | WIRED    | Lines 30-43: unknown/self checks; lines 82-84: else edges in DFS adjacency map |
| `src/pipeline/executor.ts`    | `src/pipeline/condition.ts` | evaluateCondition in processNode           | WIRED    | `import { evaluateCondition } from "./condition.js"` at line 17; called at line 210 |
| `src/pipeline/executor.ts`    | `src/pipeline/dag.ts`       | buildDependentsMap in ready-queue setup    | WIRED    | `import { ..., buildDependentsMap } from "./dag.js"` at line 16; called at line 110 |
| `src/pipeline/executor.ts`    | `NodeExecution.skipReason`  | condition-based and cascade skip reasons   | WIRED    | skipReason: `condition false: ${node.condition}` (line 225); `dependency ${currentId} was skipped` (line 162) |

### Requirements Coverage

| Requirement | Source Plan | Description                                                      | Status    | Evidence                                                                        |
|-------------|------------|------------------------------------------------------------------|-----------|---------------------------------------------------------------------------------|
| COND-01     | 21-01      | PipelineNode supports `condition` field with filtrex evaluation  | SATISFIED | condition.ts implements evaluateCondition(); filtrex compileExpression wired     |
| COND-02     | 21-02      | Executor refactored from static topo-sort to ready-queue model   | SATISFIED | executor.ts lines 110-290: readyQueue Set, inFlight Map, drain while-loop       |
| COND-03     | 21-02      | else_node routes execution to alternate branch when false        | SATISFIED | executor.ts lines 232-244: else_node enqueued to readyQueue on false condition  |
| COND-04     | 21-01      | if_failed/if_passed shorthand resolves to condition expressions  | SATISFIED | expandShorthands() in condition.ts; wired in parser.ts; 6 tests pass            |
| COND-05     | 21-02      | Skipped nodes marked as skipped status (visible in API)          | SATISFIED | pipeline-service.ts line 68: nodeStates included; skip propagation in executor  |
| COND-06     | 21-01, 21-02 | Condition evaluation errors are fatal                          | SATISFIED | executor.ts lines 214-220: catch → pipeline_state.status = "failed"; test passes|
| COND-07     | 21-02      | --dry-run shows which nodes would be skipped                     | SATISFIED | buildDryRunResult() lines 657-742: SKIP/RUN annotations, DRY RUN ERRORS output  |

No orphaned requirements — all 7 COND IDs declared in plan frontmatter and all present in REQUIREMENTS.md marked complete.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| executor.ts | 433, 563, 710+ | console.log | Info | Intentional terminal UI output (chalk-colored progress + dry-run display) — not stubs |

No blockers or warnings found.

### Human Verification Required

None — all behaviors are programmatically verifiable via unit tests.

### Gaps Summary

No gaps. All 13 observable truths are verified against the actual codebase:

- `src/pipeline/condition.ts` exists, is substantive (117 lines), and is imported by both `parser.ts` (expandShorthands) and `executor.ts` (evaluateCondition).
- `src/pipeline/dag.ts` exports `buildDependentsMap` and validates else_node references including cycle detection.
- `src/pipeline/parser.ts` wires `expandShorthands` at parse time so downstream code only sees `condition` strings.
- `src/pipeline/executor.ts` (885 lines) uses a ready-queue drain loop, evaluates conditions at runtime, propagates cascade skips, activates else_node, surfaces fatal errors, and annotates dry-run output.
- All 1073 tests pass (0 regressions). TypeScript typecheck clean.
- All 7 COND requirements satisfied.

---

_Verified: 2026-03-13T04:35:00Z_
_Verifier: Claude (gsd-verifier)_
