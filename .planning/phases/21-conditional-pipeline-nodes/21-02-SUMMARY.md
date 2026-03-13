---
phase: 21-conditional-pipeline-nodes
plan: "02"
subsystem: pipeline
tags: [ready-queue, condition-evaluation, cascade-skip, else-node, dry-run, executor-refactor]
dependency_graph:
  requires:
    - phase: 21-01
      provides: [evaluateCondition, buildDependentsMap, NodeStatusContext]
  provides: [ready-queue-executor, condition-gated-execution, cascade-skip, else-node-activation, dry-run-annotations]
  affects: [pipeline/executor, pipeline/dag, pipeline/condition]
tech_stack:
  added: []
  patterns:
    - "Ready-queue drain loop with inFlight Map and Promise.race for bounded parallelism"
    - "processNode wrapped in .then(inFlight.delete) to avoid synchronous-async delete race"
    - "pipeline_state object (not let variable) for pipelineStatus to avoid TypeScript narrowing in async closures"
    - "Happy-path dry-run simulation: all ancestors = 'completed' for condition annotation"
key_files:
  created: []
  modified:
    - src/pipeline/executor.ts
    - test/unit/pipeline-executor.test.ts
key_decisions:
  - "inFlight.delete must happen in .then() wrapper AFTER inFlight.set — not inside processNode. If processNode has no awaits, it completes synchronously before inFlight.set runs, causing a permanent inFlight entry that never resolves"
  - "Dependency block check (failed/non-hydrated-skipped) runs first in processNode, before condition evaluation — consistent with plan's ordering requirement"
  - "Cascade skip propagates through dependentsMap but skips else_node targets — else_node is an alternative execution path, not a downstream"
  - "pipelineStatus stored in object wrapper to prevent TypeScript from narrowing 'running' to literal type in drain loop comparison"
  - "Dry-run happy-path: simulate all upstream nodes as 'completed' regardless of else_node routing — else_nodes noted as 'would not activate on happy path' per user decision"
requirements-completed: [COND-02, COND-05, COND-07]
duration: 18min
completed: "2026-03-13"
tasks_completed: 2
files_changed: 2
---

# Phase 21 Plan 02: Ready-Queue Executor and Conditional Execution Summary

**Ready-queue drain loop replaces static topo-sort iteration; condition evaluation gates node execution with cascade-skip, else_node routing, and dry-run SKIP/RUN annotations**

## Performance

- **Duration:** 18 min
- **Started:** 2026-03-13T04:10:36Z
- **Completed:** 2026-03-13T04:29:01Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Static `for (nodeId of order)` loop replaced with ready-queue drain loop supporting runtime branching
- Condition evaluation gates node execution: true=run, false=skip with cascade propagation or else_node activation
- Fatal condition errors (unknown variable, syntax error) fail the pipeline immediately (COND-06)
- Checkpoint-hydrated skips correctly NOT treated as cascade skip triggers
- Dry-run simulates happy-path conditions and annotates conditional nodes with RUN/SKIP
- All 1073 tests pass (9 new tests added); typecheck clean

## Task Commits

1. **Task 1: Replace static topo-sort loop with ready-queue executor** - `04a1652` (feat)
2. **Task 2: Extend dry-run with condition annotations** - `df7369d` (feat)

**Plan metadata:** (pending)

## Files Created/Modified

- `src/pipeline/executor.ts` — Ready-queue executor, processNode with condition evaluation, cascade skip, else_node activation, dry-run annotations (885 lines)
- `test/unit/pipeline-executor.test.ts` — 9 new tests: 6 conditional execution + 3 dry-run annotation tests (421 lines)

## Decisions Made

- **inFlight.delete in .then() wrapper:** processNode without awaits (skip/block paths) completes synchronously before `inFlight.set` runs. Moving delete into `.then()` ensures the entry exists when delete is called.
- **pipeline_state object wrapper:** TypeScript narrows `let pipelineStatus = "running"` to literal type, causing a type error when comparing to `"failed"` in drain loop. Object property avoids narrowing.
- **Dry-run happy-path:** All ancestors simulated as "completed" for condition annotation; else_node activation not simulated since it requires a false condition path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Infinite drain loop when processNode has no await statements**
- **Found during:** Task 1 (testing static propagation paths)
- **Issue:** `inFlight.delete(nodeId)` inside processNode runs synchronously BEFORE `inFlight.set(nodeId, promise)` in the drain loop. This left a resolved-but-never-deleted promise in inFlight, causing `inFlight.size > 0` to stay true forever.
- **Fix:** Removed all `inFlight.delete` calls from inside processNode. Moved deletion to `.then()` callback: `const promise = processNode(nodeId).then(() => { inFlight.delete(nodeId); });`
- **Files modified:** src/pipeline/executor.ts
- **Verification:** All 10 existing tests pass including previously-hanging "propagates skip" test
- **Committed in:** 04a1652 (Task 1 commit)

**2. [Rule 1 - Bug] TypeScript narrowing error on pipeline status comparison**
- **Found during:** Task 2 (typecheck run)
- **Issue:** `let pipelineStatus: "running" | "completed" | "failed" = "running"` — TypeScript narrows the type at the drain loop `if (pipelineStatus === "failed") break;` comparison, treating it as always `"running"` since no assignment is visible in the synchronous path.
- **Fix:** Changed to `const pipeline_state = { status: "running" as "running" | "completed" | "failed" }` — object property access is not narrowed.
- **Files modified:** src/pipeline/executor.ts
- **Verification:** `npm run typecheck` passes clean
- **Committed in:** df7369d (Task 2 commit)

**3. [Rule 1 - Bug] Existing test expected old skip reason format**
- **Found during:** Task 1 (test run after ready-queue refactor)
- **Issue:** "propagates skip" test expected `c.skipReason` to contain `"skipped without hydrated output"` — the old `getDependencyIssues` message. Ready-queue uses different reason strings.
- **Fix:** Updated test assertion: `b.skipReason` contains "dependency a was skipped"; `c.skipReason` contains "dependency b was skipped".
- **Files modified:** test/unit/pipeline-executor.test.ts
- **Verification:** Test passes with correct semantics preserved
- **Committed in:** 04a1652 (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (3 Rule 1 bugs)
**Impact on plan:** All essential for correct execution. No scope creep.

## Issues Encountered

- The synchronous-async race in the drain loop was a non-obvious concurrency bug. Symptoms were: test hangs indefinitely (infinite loop), not test failures. Discovered via single-test isolation runs showing each test passes in isolation but hangs when `propagates skip` runs.

## Next Phase Readiness

- Ready-queue executor is the architectural prerequisite for Phase 21 Plan 03 (loop nodes), which requires re-evaluating node readiness after each iteration
- COND-02, COND-05, COND-07 complete; COND-03 and COND-04 (loop nodes) remain
- No blockers

## Self-Check: PASSED

- src/pipeline/executor.ts — FOUND
- test/unit/pipeline-executor.test.ts — FOUND
- .planning/phases/21-conditional-pipeline-nodes/21-02-SUMMARY.md — FOUND
- Commit 04a1652 — FOUND
- Commit df7369d — FOUND

---
*Phase: 21-conditional-pipeline-nodes*
*Completed: 2026-03-13*
