---
phase: 27-agent-teams
plan: "02"
subsystem: orchestrator
tags: [agent-teams, env-injection, slot-management, checkpoint-bypass, runtime]
dependency_graph:
  requires: [team-schema-types, resolver-team-logic]
  provides: [weighted-slot-management, team-env-injection, checkpoint-bypass-gates]
  affects:
    - src/orchestrator/state.ts
    - src/orchestrator/dispatcher.ts
    - src/orchestrator/worker.ts
    - src/orchestration/single.ts
tech_stack:
  added: []
  patterns: [weight-summation-slots, conditional-env-injection, boolean-gate-pattern]
key_files:
  created:
    - test/unit/agent-team-env.test.ts
    - test/unit/agent-team-checkpoint.test.ts
  modified:
    - src/orchestrator/state.ts
    - src/orchestrator/dispatcher.ts
    - src/orchestrator/worker.ts
    - src/orchestration/single.ts
    - test/unit/orchestrator-state.test.ts
    - test/unit/orchestrator-reload.test.ts
decisions:
  - "SlotManager sums slotWeight values instead of counting workers — enables proportional slot consumption"
  - "slotWeight defaults to 1 in dispatcher (config.team?.size ?? 1) — backward compatible with all existing solo runs"
  - "Checkpoint bypass gates use !plan.skipCheckpoints on same line as the existing snapshotRepo guard — minimal diff"
  - "Non-claude-code warning placed BEFORE the agent type switch — fires once regardless of which agent branch executes"
metrics:
  duration_seconds: 390
  completed: "2026-03-13"
  tasks_completed: 2
  files_modified: 6
---

# Phase 27 Plan 02: Agent Team Runtime Wiring — Summary

Agent team runtime behavior: weight-aware slot consumption via slotWeight summation in SlotManager, CLAUDE_NUM_TEAMMATES env var injection for claude-code team runs, checkpoint bypass gates for team runs (skipCheckpoints), and orchestrator-path team config propagation from ForgectlConfig to RunPlan.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | SlotManager weight-aware accounting, WorkerInfo slotWeight, and orchestrator team wiring | 236013b | WorkerInfo.slotWeight field, SlotManager weight summation, dispatcher slotWeight from config.team?.size, buildOrchestratedRunPlan propagates team/skipCheckpoints, 6 new weighted slot tests |
| 2 | Env var injection, checkpoint bypass, and non-claude-code warning | 3822bb9 | CLAUDE_NUM_TEAMMATES in prepareExecution, non-claude-code warn-and-skip, all 4 saveCheckpoint calls gated with !plan.skipCheckpoints, 2 new test files (7 tests) |

## Success Criteria Verification

- [x] CLAUDE_NUM_TEAMMATES=N env var set in container for claude-code team runs (N = size - 1)
- [x] Non-claude-code agent with team config: warning logged, no crash, no env var
- [x] --no-team (noTeam=true) prevents env var injection
- [x] SlotManager.availableSlots sums slotWeight across running workers
- [x] All 4 saveCheckpoint calls gated by !plan.skipCheckpoints
- [x] WorkerInfo constructed with slotWeight from config.team?.size in dispatcher (not hardcoded 1)
- [x] buildOrchestratedRunPlan propagates team/skipCheckpoints from ForgectlConfig to RunPlan
- [x] Full test suite passes (1112 tests), typecheck clean

## Decisions Made

1. **Weight summation instead of count** — `SlotManager.availableSlots` now sums `slotWeight` across all running workers. A team of 3 consumes 3 slots. A solo worker still consumes 1 slot — fully backward compatible.

2. **slotWeight defaults to 1** — `config.team?.size ?? 1` in dispatcher ensures all existing orchestrated runs keep their prior behavior without any config changes.

3. **Checkpoint bypass on same line** — The guard `if (snapshotRepo && !plan.skipCheckpoints)` keeps minimal diffs and reads naturally. No new variable or wrapper function needed.

4. **Warning before agent type switch** — The non-claude-code team warning fires unconditionally before the agent-type `if/else if/else` block, so it is not buried inside the codex branch where it might be missed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed orchestrator-reload.test.ts WorkerInfo fixtures**
- **Found during:** Task 2 full suite run
- **Issue:** `test/unit/orchestrator-reload.test.ts` used `{} as any` for WorkerInfo in SlotManager test. After making `slotWeight` a required field and switching `availableSlots` to weight summation, `undefined + undefined = NaN`, causing assertion failure.
- **Fix:** Updated 3 fixture objects from `{} as any` to `{ slotWeight: 1 } as any`
- **Files modified:** test/unit/orchestrator-reload.test.ts
- **Commit:** 3822bb9

## Self-Check: PASSED

Files verified:
- src/orchestrator/state.ts: FOUND
- src/orchestrator/dispatcher.ts: FOUND
- src/orchestrator/worker.ts: FOUND
- src/orchestration/single.ts: FOUND
- test/unit/agent-team-env.test.ts: FOUND
- test/unit/agent-team-checkpoint.test.ts: FOUND
- test/unit/orchestrator-state.test.ts: FOUND
- test/unit/orchestrator-reload.test.ts: FOUND

Commits verified:
- 236013b: FOUND (test(27-02): add failing tests for weighted slot management)
- 3822bb9: FOUND (feat(27-02): env var injection, checkpoint bypass, and non-claude-code warning)
