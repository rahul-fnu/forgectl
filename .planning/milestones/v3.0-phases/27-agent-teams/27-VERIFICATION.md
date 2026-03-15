---
phase: 27-agent-teams
verified: 2026-03-13T15:45:00Z
status: passed
score: 20/20 must-haves verified
re_verification: false
---

# Phase 27: Agent Teams Verification Report

**Phase Goal:** Claude Code agent teams run inside containers on complex tasks, with container resources and slot weights automatically scaled to team size
**Verified:** 2026-03-13T15:45:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths — Plan 01 (TEAM-02, TEAM-05)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A WORKFLOW.md with `team: { size: 3 }` front matter parses without ZodError | VERIFIED | `WorkflowFrontMatterSchema` in `workflow-file.ts:98-100` accepts size 2-5; test at `workflow-file.test.ts:174-179` passes |
| 2 | A WORKFLOW.md with `team: { size: 6 }` is rejected by Zod (max 5) | VERIFIED | `.max(5)` constraint at `workflow-file.ts:99`; test `workflow-file.test.ts:201-205` passes |
| 3 | A WORKFLOW.md with `team: { size: 1 }` is rejected by Zod (min 2) | VERIFIED | `.min(2)` constraint at `workflow-file.ts:99`; test `workflow-file.test.ts:195-199` passes |
| 4 | The resolver produces a RunPlan with team.size=3 when workflow has team config | VERIFIED | `resolver.ts:217` sets `team: { size: effectiveTeamSize!, slotWeight: effectiveTeamSize! }`; resolver test passes |
| 5 | The resolver scales memory to base + 2GB for a 3-person team (4g becomes 6g) | VERIFIED | `scaleMemoryForTeam` at `resolver.ts:44-49`; memory test passes (4g + 2 teammates = 6g) |
| 6 | The resolver sets skipCheckpoints=true when team.size > 1 | VERIFIED | `resolver.ts:216`; resolver test "skipCheckpoints set to true for team runs" passes |
| 7 | The resolver sets noTeam=true when CLI passes --no-team | VERIFIED | `resolver.ts:215`; test "--no-team (options.team=false)" passes |
| 8 | When noTeam=true, memory is NOT scaled and skipCheckpoints is NOT set | VERIFIED | `resolver.ts:129-133` gates `hasTeam` behind `!resolvedNoTeam`; test verifies memory stays "4g" |
| 9 | CLI --team-size 4 overrides workflow team size in the RunPlan | VERIFIED | `resolver.ts:132` uses `options.teamSize ?? workflow.team?.size`; CLI flag registered at `index.ts:54`; test passes |
| 10 | ConfigSchema accepts optional team config so orchestrator path can access it | VERIFIED | `schema.ts:168-171` adds `team: z.object({ size: z.number().int().min(2).max(5) }).optional()` to `ConfigSchema` |

### Observable Truths — Plan 02 (TEAM-01, TEAM-03, TEAM-04)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 11 | A claude-code run with team.size=3 gets CLAUDE_NUM_TEAMMATES=2 env var | VERIFIED | `single.ts:112-115` injects `CLAUDE_NUM_TEAMMATES=${teammates}`; `agent-team-env.test.ts` test passes |
| 12 | A non-claude-code run with team config logs a warning, no CLAUDE_NUM_TEAMMATES | VERIFIED | `single.ts:91-95` warns before agent type switch; env test "warns for non-claude-code" passes |
| 13 | A claude-code run with noTeam=true does NOT get CLAUDE_NUM_TEAMMATES | VERIFIED | `single.ts:112` gates on `!plan.noTeam`; env test "does not add when noTeam is true" passes |
| 14 | SlotManager.availableSlots returns max - sum(slotWeights) | VERIFIED | `state.ts:92-96` uses `.reduce((sum, w) => sum + w.slotWeight, 0)`; orchestrator-state tests pass |
| 15 | A 3-person team occupies 3 slots (slotWeight=3) | VERIFIED | `state.ts` weight summation; test "team worker with weight 3 consumes 3 slots" passes |
| 16 | Solo runs occupy 1 slot (slotWeight=1) preserving backward compat | VERIFIED | `dispatcher.ts:203` defaults `config.team?.size ?? 1`; backward compat test passes |
| 17 | saveCheckpoint is NOT called when plan.skipCheckpoints is true | VERIFIED | All 4 call sites in `single.ts:227,249,258,266` gated with `!plan.skipCheckpoints`; checkpoint test verifies all 4 |
| 18 | saveCheckpoint IS still called when plan.skipCheckpoints is falsy | VERIFIED | Gate condition preserves prior behavior; checkpoint structural test confirms pattern |
| 19 | WorkerInfo in dispatcher constructed with slotWeight from config.team?.size or defaults 1 | VERIFIED | `dispatcher.ts:203` computes `const slotWeight = config.team?.size ?? 1` and assigns to WorkerInfo |
| 20 | buildOrchestratedRunPlan propagates team config from ForgectlConfig to RunPlan | VERIFIED | `worker.ts:205-211` spreads `team`, `skipCheckpoints` from `config.team` |

**Score:** 20/20 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/config/schema.ts` | WorkflowSchema and ConfigSchema with team field | VERIFIED | Lines 74-76 (WorkflowSchema), 168-171 (ConfigSchema), both with `size: min(2).max(5)` |
| `src/workflow/types.ts` | RunPlan with team, noTeam, skipCheckpoints; WorkflowFileConfig with team | VERIFIED | Lines 143-149 (RunPlan), 57-59 (WorkflowFileConfig) |
| `src/workflow/workflow-file.ts` | WorkflowFrontMatterSchema with team field inside .strict() | VERIFIED | Lines 98-100, inside `.object({...}).strict()` at line 102 |
| `src/workflow/resolver.ts` | Memory scaling, skipCheckpoints, noTeam, team propagation | VERIFIED | `scaleMemoryForTeam` at line 44, team logic at 129-133, return at 215-217 |
| `src/container/runner.ts` | Exported parseMemory function | VERIFIED | Line 110: `export function parseMemory` |
| `src/index.ts` | --no-team and --team-size CLI flags | VERIFIED | Lines 53-54: `.option("--no-team", ...)` and `.option("--team-size <n>", ...)` |
| `src/orchestrator/state.ts` | WorkerInfo with slotWeight, weight-aware SlotManager | VERIFIED | Line 22 (slotWeight field), lines 92-96 (weight summation in availableSlots) |
| `src/orchestrator/dispatcher.ts` | WorkerInfo construction with slotWeight from config.team | VERIFIED | Lines 203-213: `const slotWeight = config.team?.size ?? 1` then assigned to running map |
| `src/orchestrator/worker.ts` | buildOrchestratedRunPlan with team fields from ForgectlConfig | VERIFIED | Lines 205-211: spread of team/skipCheckpoints conditional on config.team?.size |
| `src/orchestration/single.ts` | CLAUDE_NUM_TEAMMATES env var injection, checkpoint bypass gates | VERIFIED | Lines 91-95 (warning), 112-115 (env injection), 227/249/258/266 (gated checkpoints) |
| `test/unit/agent-team-env.test.ts` | Tests for env var injection (TEAM-01) | VERIFIED | 169 lines, 4 tests, all pass |
| `test/unit/agent-team-checkpoint.test.ts` | Tests for checkpoint bypass (TEAM-04) | VERIFIED | 46 lines, 3 structural tests verifying all 4 call sites gated |
| `test/unit/orchestrator-state.test.ts` | Extended tests for weighted slot management (TEAM-03) | VERIFIED | Includes `weighted slot management` describe block with 6 tests |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/workflow/resolver.ts` | `src/container/runner.ts` | `import parseMemory` | VERIFIED | Line 9: `import { parseMemory } from "../container/runner.js"` |
| `src/workflow/resolver.ts` | `src/workflow/types.ts` | RunPlan team fields | VERIFIED | `noTeam`, `skipCheckpoints`, `team` all set in return at lines 215-217 |
| `src/workflow/workflow-file.ts` | `src/config/schema.ts` | matching team schema | VERIFIED | Both use `z.object({ size: z.number().int().min(2).max(5) }).optional()` |
| `src/orchestration/single.ts` | `src/workflow/types.ts` | plan.team, plan.skipCheckpoints, plan.noTeam | VERIFIED | Lines 91, 112, 227, 249, 258, 266 all reference these RunPlan fields |
| `src/orchestrator/dispatcher.ts` | `src/orchestrator/state.ts` | WorkerInfo.slotWeight | VERIFIED | Dispatcher constructs WorkerInfo with `slotWeight` at line 213; state.ts sums it |
| `src/orchestrator/state.ts` | SlotManager.availableSlots | weight summation reduce | VERIFIED | `[...running.values()].reduce((sum, w) => sum + w.slotWeight, 0)` |
| `src/orchestrator/dispatcher.ts` | `src/config/schema.ts` | config.team?.size for slotWeight | VERIFIED | `config.team?.size ?? 1` at dispatcher.ts:203 |
| `src/orchestrator/worker.ts` | `src/config/schema.ts` | config.team for RunPlan team fields | VERIFIED | `config.team?.size` at worker.ts:206 |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TEAM-01 | 27-02 | Enable Claude Code agent teams via env vars and prompt wrapping inside containers | SATISFIED | `CLAUDE_NUM_TEAMMATES` injected in `single.ts:114`; gated on `plan.team`, `!plan.noTeam`, and `plan.agent.type === "claude-code"` |
| TEAM-02 | 27-01 | Auto-scale container memory by team size (base + 1GB per teammate) | SATISFIED | `scaleMemoryForTeam` in `resolver.ts:44-49` computes `baseBytes + teammateCount * 1024^3` |
| TEAM-03 | 27-02 | Update slot manager to weight concurrent slots by team size, not run count | SATISFIED | `SlotManager.availableSlots` in `state.ts:91-96` sums `slotWeight` via reduce |
| TEAM-04 | 27-02 | Disable checkpoint/resume for team runs | SATISFIED | All 4 `saveCheckpoint` call sites in `single.ts` gated with `&& !plan.skipCheckpoints` |
| TEAM-05 | 27-01 | Support `team:` section in WORKFLOW.md for team size | SATISFIED | `WorkflowFrontMatterSchema` in `workflow-file.ts:98-100` accepts `team.size` (int, min 2, max 5) |

All 5 requirements (TEAM-01 through TEAM-05) satisfied. No orphaned requirements.

### Anti-Patterns Found

No anti-patterns detected in any modified files. No TODOs, FIXMEs, stubs, or empty implementations found.

### Human Verification Required

None. All behaviors are programmatically verifiable.

### Test Results

| Test File | Tests | Status |
|-----------|-------|--------|
| `test/unit/workflow-file.test.ts` | 27 | All pass |
| `test/unit/workflow-resolver.test.ts` | 35 | All pass (includes 8 team tests) |
| `test/unit/orchestrator-state.test.ts` | Includes weighted slot tests | All pass |
| `test/unit/agent-team-env.test.ts` | 4 | All pass |
| `test/unit/agent-team-checkpoint.test.ts` | 3 | All pass |
| Full suite | 1112 | All pass (8 skipped unrelated) |
| TypeScript typecheck | — | Clean (no errors) |

### Summary

Phase 27 goal fully achieved. All five TEAM requirements are implemented, wired, and tested:

- **TEAM-05 (Schema):** `WorkflowFrontMatterSchema`, `WorkflowSchema`, `ConfigSchema` all accept `team: { size: 2-5 }`. Invalid sizes (1, 6) are rejected by Zod.
- **TEAM-02 (Memory scaling):** `scaleMemoryForTeam` in the resolver adds 1GB per teammate. CLI `--team-size` and `--no-team` flags are registered and functional.
- **TEAM-01 (Env injection):** `CLAUDE_NUM_TEAMMATES=N` is injected into claude-code containers when `plan.team` is present and not disabled. Non-claude-code agents receive a warning and no injection.
- **TEAM-03 (Slot weights):** `SlotManager.availableSlots` sums `slotWeight` across running workers. Dispatcher sets `slotWeight = config.team?.size ?? 1` (backward compatible). A team-3 run consumes 3 slots.
- **TEAM-04 (Checkpoint bypass):** All 4 `saveCheckpoint` call sites in `single.ts` are gated with `!plan.skipCheckpoints`. Team runs set `skipCheckpoints: true` via both the resolver (CLI path) and `buildOrchestratedRunPlan` (orchestrator path).

---

_Verified: 2026-03-13T15:45:00Z_
_Verifier: Claude (gsd-verifier)_
