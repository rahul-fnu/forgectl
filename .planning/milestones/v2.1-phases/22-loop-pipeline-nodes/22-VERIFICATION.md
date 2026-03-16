---
phase: 22-loop-pipeline-nodes
verified: 2026-03-13T07:07:07Z
status: passed
score: 5/5 must-haves verified
re_verification: false
human_verification:
  - test: "Run a pipeline YAML with a loop node via the daemon, then call GET /pipelines/:id while the loop is executing"
    expected: "Response JSON shows the loop node entry with status=loop-iterating, loopState.currentIteration incrementing, loopState.maxIterations set correctly"
    why_human: "Live in-flight API response for an active loop requires a running daemon and real-time observation — cannot verify with grep"
---

# Phase 22: Loop Pipeline Nodes Verification Report

**Phase Goal:** Pipeline YAML supports loop-until iteration — loops execute up to a hard safety cap, each iteration is checkpointed for crash recovery, and loop progress is visible in the API
**Verified:** 2026-03-13T07:07:07Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A pipeline with a `loop` node iterates until its `until` expression evaluates true or `max_iterations` is reached | VERIFIED | `executeLoopNode()` in executor.ts lines 665-747; 4 passing integration tests in pipeline-executor.test.ts |
| 2 | The global `max_iterations` safety cap (50) is enforced before the loop runs | VERIFIED | `GLOBAL_MAX_ITERATIONS=50` in checkpoint.ts line 8; `Math.min(configuredMax, GLOBAL_MAX_ITERATIONS)` in executor.ts line 623; 6 tests in pipeline-loop.test.ts section 4 |
| 3 | After a crash mid-loop, execution resumes from the last completed iteration (not iteration 0) | VERIFIED | `loadLoopCheckpoint` called when `checkpointSourceRunId` set (executor.ts lines 649-662); crash recovery test passes with `executeRun` called exactly once after 2 recovered iterations |
| 4 | REST API reports current iteration count and `loop-iterating` status for active loop nodes | VERIFIED | `GET /pipelines/:id` returns `NodeExecution` with `loopState` via `serializeNodeStates` (pipeline-service.ts lines 288-297); `NodeExecution.loopState` carries `currentIteration` and `maxIterations`; route differs from success criterion path (`/api/v1/pipeline/:id/status`) but LOOP-04 requirement is satisfied |
| 5 | When a loop exhausts `max_iterations`, the run fails with a message naming the loop node and count | VERIFIED | executor.ts line 751: `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`; confirmed by 3 passing tests |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/pipeline/types.ts` | LoopIterationRecord, LoopState interfaces; extended NodeExecution | VERIFIED | Lines 45-58: both interfaces present and exported; NodeExecution.status includes "loop-iterating" (line 73); NodeExecution.loopState?: LoopState (line 80) |
| `src/pipeline/checkpoint.ts` | saveLoopCheckpoint, loadLoopCheckpoint, GLOBAL_MAX_ITERATIONS | VERIFIED | Lines 8, 110-133: all three exported; uses distinct `loop-checkpoint.json` file path (line 106); sync writes via writeFileSync |
| `src/pipeline/executor.ts` | executeLoopNode private method, loop detection in processNode, dry-run annotation | VERIFIED | Lines 258-268: loop detection in processNode; lines 620-758: executeLoopNode method; lines 882-886: dry-run LOOP annotation |
| `test/unit/pipeline-loop.test.ts` | 34 unit tests covering all LOOP requirements | VERIFIED | 34 tests across 8 describe blocks — types, round-trip, absent checkpoint, safety cap, until expressions, DAG validation, exhaustion message, executeLoopNode integration |
| `test/unit/pipeline-executor.test.ts` | 4 loop integration tests added | VERIFIED | Lines 401-527: loop completes, body failure not termination, exhaustion, dry-run annotation |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/pipeline/checkpoint.ts` | `src/pipeline/types.ts` | `import LoopState` | WIRED | Line 4: `import type { CheckpointRef, LoopState } from "./types.js"` |
| `src/pipeline/executor.ts` | `src/pipeline/checkpoint.ts` | `import saveLoopCheckpoint, loadLoopCheckpoint` | WIRED | Confirmed by grep: `saveLoopCheckpoint` called line 711, `loadLoopCheckpoint` called line 650, `GLOBAL_MAX_ITERATIONS` used line 623 |
| `src/pipeline/executor.ts` | `src/pipeline/condition.ts` | `evaluateCondition` for until expression | WIRED | Line 730: `evaluateCondition(node.loop!.until, untilCtx)` |
| `src/pipeline/executor.ts` | `src/pipeline/types.ts` | `import LoopIterationRecord` | WIRED | LoopIterationRecord used in executeLoopNode line 688 |
| `src/daemon/pipeline-service.ts` | `src/pipeline/executor.ts` | `getNodeStates()` returns NodeExecution with loopState | WIRED | Line 255: `serializeNodeStates(entry.executor.getNodeStates(), true)` spreads all fields including loopState |
| `src/daemon/routes.ts` | `src/daemon/pipeline-service.ts` | `GET /pipelines/:id` calls `getRun()` | WIRED | Line 186-193: route calls `pipelineService.getRun()` and returns full result |
| `test/unit/pipeline-loop.test.ts` | `src/pipeline/checkpoint.ts` | `import saveLoopCheckpoint` | WIRED | Line 47-49: dynamic import after mock setup |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| LOOP-01 | 22-01, 22-02 | PipelineNode supports `loop` field with `until` and `max_iterations` | SATISFIED | `PipelineNode.loop` field in types.ts lines 38-42; loop detection in executor processNode |
| LOOP-02 | 22-01, 22-02 | Loops modeled as opaque meta-nodes (no DAG back-edges) | SATISFIED | Loop node has no back-edge in DAG; `validateDAG` tests pass for loop pipelines; loop detection bypasses normal `executeNode` path |
| LOOP-03 | 22-01, 22-02 | Global max_iterations safety cap enforced regardless of YAML value | SATISFIED | `GLOBAL_MAX_ITERATIONS=50` enforced via `Math.min(configuredMax, GLOBAL_MAX_ITERATIONS)` before first iteration; warning logged when clamped |
| LOOP-04 | 22-01, 22-02 | Loop iteration counter tracked in NodeExecution and exposed via REST API | SATISFIED | `NodeExecution.loopState.currentIteration` tracked; `GET /pipelines/:id` exposes full NodeExecution including loopState; note: route path is `/pipelines/:id` not `/api/v1/pipeline/:id/status` as in success criterion |
| LOOP-05 | 22-01, 22-02 | Per-iteration checkpoint for crash recovery mid-loop | SATISFIED | `saveLoopCheckpoint` writes `loop-checkpoint.json` after each iteration; `loadLoopCheckpoint` restores state on next run; crash recovery test verifies resume from lastCompletedIteration+1 |

All 5 LOOP requirements from REQUIREMENTS.md are satisfied. No orphaned requirements found — all 5 IDs (LOOP-01 through LOOP-05) appear in both plan frontmatter and REQUIREMENTS.md traceability table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | — | — | — |

Scanned: `src/pipeline/types.ts`, `src/pipeline/checkpoint.ts`, `src/pipeline/executor.ts` (executeLoopNode and processNode sections), `test/unit/pipeline-loop.test.ts`, `test/unit/pipeline-executor.test.ts`. No TODOs, FIXMEs, placeholders, empty implementations, or stub returns found in the loop-related code.

### Human Verification Required

#### 1. Live Loop Status in API

**Test:** Start the forgectl daemon (`forgectl daemon start`), submit a pipeline YAML with a loop node whose body takes 2+ seconds per iteration, and poll `GET /pipelines/:id` during execution
**Expected:** Response JSON shows the loop node entry with `status: "loop-iterating"`, `loopState.currentIteration` incrementing each iteration, `loopState.maxIterations` matching the configured (or clamped) value
**Why human:** Live in-flight API observation during active iteration requires a running daemon — cannot be verified statically

### Gaps Summary

No gaps. All phase goal components are implemented and verified:

- Loop iteration engine (`executeLoopNode`) is fully implemented and wired into `processNode`
- Safety cap enforcement (`GLOBAL_MAX_ITERATIONS=50`) is applied before the first iteration
- Per-iteration checkpointing (`saveLoopCheckpoint` to distinct `loop-checkpoint.json`) is in place
- Crash recovery (`loadLoopCheckpoint` when `checkpointSourceRunId` set) resumes from last completed iteration
- REST API exposes `loopState` including `currentIteration` and `maxIterations` via `GET /pipelines/:id`
- Dry-run annotates loop nodes with `LOOP(max:N, until: expr)`
- Full test suite passes: 1111 tests, 8 skipped (Docker), 0 failures

One minor observation: ROADMAP success criterion 4 specifies the route as `GET /api/v1/pipeline/:id/status` but the actual route is `GET /pipelines/:id`. The LOOP-04 requirement text says "exposed via REST API" without specifying a path. The functional requirement is satisfied — `loopState` with `currentIteration` is fully accessible via the REST API. This is a documentation discrepancy, not a functional gap.

---

_Verified: 2026-03-13T07:07:07Z_
_Verifier: Claude (gsd-verifier)_
