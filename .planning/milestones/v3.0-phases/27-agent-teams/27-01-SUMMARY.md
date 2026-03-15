---
phase: 27-agent-teams
plan: "01"
subsystem: workflow
tags: [schemas, types, resolver, team-config, cli]
dependency_graph:
  requires: []
  provides: [team-schema-types, parseMemory-export, resolver-team-logic]
  affects: [src/config/schema.ts, src/workflow/types.ts, src/workflow/workflow-file.ts, src/workflow/resolver.ts, src/container/runner.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [zod-optional-team, memory-scaling, cli-boolean-flags]
key_files:
  created: []
  modified:
    - src/config/schema.ts
    - src/workflow/types.ts
    - src/workflow/workflow-file.ts
    - src/workflow/resolver.ts
    - src/container/runner.ts
    - src/index.ts
    - test/unit/workflow-file.test.ts
    - test/unit/workflow-resolver.test.ts
decisions:
  - "team sub-object in WorkflowFrontMatterSchema is NOT .strict() — only top-level schema uses .strict(), matching existing tracker/workspace pattern"
  - "noTeam uses || undefined pattern (same as noSkills) so absent fields are omitted from RunPlan rather than set to false"
  - "skipCheckpoints uses || undefined pattern so it is omitted when no team, not set to false"
  - "slotWeight equals teamSize initially — Plan 02 may override with config-driven values"
  - "parseMemory exported via simple keyword addition — no duplicate function created"
metrics:
  duration_seconds: 184
  completed: "2026-03-13"
  tasks_completed: 2
  files_modified: 8
---

# Phase 27 Plan 01: Agent Team Schemas, Types, Resolver — Summary

Agent team configuration plumbing: Zod schemas with size validation (min 2, max 5), RunPlan team/noTeam/skipCheckpoints fields, memory scaling (1GB per teammate), --no-team/--team-size CLI flags, and parseMemory export.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Extend schemas, types, and export parseMemory | 2ad60e7 | WorkflowFrontMatterSchema team field, ConfigSchema team, WorkflowFileConfig team, RunPlan 3 new fields, parseMemory export, 6 new test cases |
| 2 | Resolver logic, CLI flags, and resolver tests | 0006656 | CLIOptions team/teamSize, scaleMemoryForTeam helper, resolveRunPlan team logic, --no-team/--team-size flags, 8 new test cases |

## Success Criteria Verification

- [x] WorkflowFrontMatterSchema accepts valid team configs (size 2-5) and rejects invalid sizes (1, 6)
- [x] RunPlan carries team, noTeam, skipCheckpoints fields
- [x] Resolver scales memory by 1GB per teammate (4g + 2 teammates = 6g)
- [x] Resolver sets skipCheckpoints=true for team runs
- [x] --no-team disables team mode entirely (no scaling, no skipCheckpoints, noTeam=true)
- [x] --team-size CLI override works (teamSize=4 overrides workflow config)
- [x] parseMemory exported from runner.ts
- [x] ConfigSchema has optional team field for orchestrator path access
- [x] All 62 tests pass (27 workflow-file + 35 workflow-resolver)
- [x] Typecheck clean (npx tsc --noEmit)

## Decisions Made

1. **team sub-object NOT .strict()** — Only the top-level `WorkflowFrontMatterSchema` uses `.strict()`. The `team` sub-object uses plain `.object()` consistent with existing `tracker`, `workspace`, `concurrency` patterns.

2. **noTeam/skipCheckpoints use `|| undefined`** — Fields are absent (not `false`) when not applicable, matching the `noSkills` convention. This keeps RunPlan lean for non-team runs.

3. **slotWeight = teamSize initially** — Plan 02 will wire runtime behavior (env vars, slot weights via config). The initial `slotWeight` value equals `size` as a straightforward default.

4. **No duplicate parseMemory** — The existing private function in runner.ts was made `export` with a single keyword addition. No new function or file created.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified present:
- src/config/schema.ts: FOUND
- src/workflow/types.ts: FOUND
- src/workflow/workflow-file.ts: FOUND
- src/workflow/resolver.ts: FOUND
- src/container/runner.ts: FOUND
- src/index.ts: FOUND

Commits verified:
- 2ad60e7: FOUND (feat(27-01): extend schemas, types, and export parseMemory)
- 0006656: FOUND (feat(27-01): resolver logic, CLI flags, and team configuration tests)
