---
phase: 26-skill-config-bind-mounting
plan: "02"
subsystem: skills
tags: [skill-mounting, orchestration, cli, commander, docker-binds, flags]

dependency_graph:
  requires:
    - phase: 26-01
      provides: prepareSkillMounts() in src/skills/mount.ts
  provides:
    - --no-skills CLI flag on run command
    - noSkills field in CLIOptions and RunPlan
    - prepareSkillMounts() wired into prepareExecution() for claude-code agent
    - skillAddDirFlags merged into agentOptions.flags
  affects:
    - src/orchestration/single.ts
    - src/workflow/types.ts
    - src/workflow/resolver.ts
    - src/index.ts

tech-stack:
  added: []
  patterns:
    - Commander --no-X pattern: sets opts.skills=false at runtime; CLIOptions uses skills?: boolean
    - Skill flags injected at agentOptions build time via array spread [...plan.agent.flags, ...skillAddDirFlags]

key-files:
  created: []
  modified:
    - src/index.ts
    - src/workflow/resolver.ts
    - src/workflow/types.ts
    - src/orchestration/single.ts
    - test/unit/agent.test.ts

key-decisions:
  - "Commander --no-skills sets opts.skills=false (not opts.noSkills); CLIOptions uses skills?: boolean and resolver maps skills===false to noSkills:true in RunPlan"
  - "skillAddDirFlags captured as local variable before agentOptions construction, then spread into flags array -- avoids mutating plan.agent.flags"
  - "Skill mount step numbered 4 in prepareExecution(), shifting old steps 4-6 to 5-7 -- maintains sequential documentation"

patterns-established:
  - "Agent-specific mounts (skills, credentials) are all prepared before network/container creation so binds array is complete"

requirements-completed: [SKILL-03]

duration: 8min
completed: 2026-03-13
---

# Phase 26 Plan 02: Orchestration Wiring for Skill Mounting Summary

**prepareSkillMounts() wired into prepareExecution() for claude-code agents with --no-skills CLI flag and --add-dir flags merged into agentOptions.flags**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-13T07:54:00Z
- **Completed:** 2026-03-13T08:02:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added `--no-skills` CLI flag to `forgectl run` command (Commander `--no-X` pattern)
- Extended `CLIOptions` and `RunPlan` with `skills?`/`noSkills?` fields, flowing correctly through resolver
- Wired `prepareSkillMounts()` call into `prepareExecution()` exclusively for `claude-code` agent type
- Merged `addDirFlags` into `agentOptions.flags` via array spread so all downstream adapters see them
- Added unit test verifying `--add-dir /path` appears as separate shell-escaped entries in built command

## Task Commits

Each task was committed atomically:

1. **Task 1: Add --no-skills CLI flag and flow through resolver** - `ecd0419` (feat)
2. **Task 2: Wire prepareSkillMounts into prepareExecution and inject --add-dir flags** - `56e1d4f` (feat)

**Plan metadata:** (docs commit, see below)

## Files Created/Modified
- `src/index.ts` - Added `--no-skills` option to run command
- `src/workflow/resolver.ts` - Added `skills?: boolean` to CLIOptions; maps to `noSkills` in RunPlan
- `src/workflow/types.ts` - Added `noSkills?: boolean` to RunPlan interface
- `src/orchestration/single.ts` - Import and call prepareSkillMounts(); skillAddDirFlags merged into agentOptions.flags
- `test/unit/agent.test.ts` - New test: `--add-dir` flags as separate shell-escaped entries

## Decisions Made
- Commander's `--no-skills` option sets `opts.skills = false` at runtime (not `opts.noSkills`). The `CLIOptions` interface uses `skills?: boolean` to match Commander's runtime behavior. The resolver then maps `options.skills === false` to `noSkills: true` in the RunPlan.
- `skillAddDirFlags` is captured as a local variable (not stored on `CleanupContext`) and spread into `agentOptions.flags` at the time the options object is constructed. This avoids mutating `plan.agent.flags`.
- Skill mount step is numbered step 4 in `prepareExecution()` to maintain sequential documentation; prior steps 4-6 became 5-7.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- Skill mounting is fully wired end-to-end: schema -> mount module -> orchestration -> agent shell command
- Phase 26 skill/config bind-mounting feature is complete
- Phase 27 (Agent Teams) can proceed; it builds on skill infrastructure

---
*Phase: 26-skill-config-bind-mounting*
*Completed: 2026-03-13*

## Self-Check: PASSED
