---
phase: 08-wire-workflow-runtime-integration
plan: 01
subsystem: orchestrator
tags: [workflow, watcher, config-merge, hot-reload, daemon]

# Dependency graph
requires:
  - phase: 03-workflow-contract
    provides: WorkflowFileWatcher, mergeWorkflowConfig, mapFrontMatter types
  - phase: 05-orchestration-state-machine
    provides: Orchestrator class, SlotManager, scheduler
provides:
  - SlotManager.setMax() for runtime concurrency updates
  - Orchestrator.applyConfig() for hot config reload
  - mapFrontMatterToConfig utility mapping front matter to ForgectlConfig
  - Production wiring of WorkflowFileWatcher in daemon startup/shutdown
  - Four-layer config merge at daemon startup
affects: [orchestrator, daemon]

# Tech tracking
tech-stack:
  added: []
  patterns: [runtime-config-reload, four-layer-config-merge]

key-files:
  created:
    - src/workflow/map-front-matter.ts
    - test/unit/orchestrator-reload.test.ts
    - test/unit/daemon-watcher.test.ts
    - test/unit/daemon-config-merge.test.ts
  modified:
    - src/orchestrator/state.ts
    - src/orchestrator/index.ts
    - src/daemon/server.ts

key-decisions:
  - "mapFrontMatterToConfig combines polling and concurrency into single orchestrator key"
  - "Watcher only started when WORKFLOW.md exists (no crash on missing file)"
  - "watcher.stop() called before orchestrator.stop() in shutdown sequence"
  - "CLI flags layer is empty object placeholder for future CLI flag passthrough"

patterns-established:
  - "Runtime config reload via applyConfig pattern (mutate deps, update slot max)"
  - "Front matter field mapping as separate utility for testability"

requirements-completed: [R4.3, R4.4]

# Metrics
duration: 4min
completed: 2026-03-08
---

# Phase 08 Plan 01: Wire Workflow Runtime Integration Summary

**Hot-reload wiring for WORKFLOW.md via WorkflowFileWatcher, four-layer config merge at daemon startup, and runtime Orchestrator.applyConfig with SlotManager.setMax**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-08T20:36:40Z
- **Completed:** 2026-03-08T20:40:42Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- SlotManager.setMax() enables runtime concurrency updates without restart
- Orchestrator.applyConfig() mutates deps.config, deps.promptTemplate, and slot max for hot reload
- mapFrontMatterToConfig maps user-friendly front matter fields (polling.interval_ms, concurrency.max_agents) to ForgectlConfig structure
- server.ts now uses mergeWorkflowConfig at startup instead of raw loadConfig()
- WorkflowFileWatcher starts when orchestrator enabled and WORKFLOW.md exists, stops on shutdown
- 26 new tests added, full suite at 644 tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: SlotManager.setMax and Orchestrator.applyConfig** - `83c6af2` (test: RED), `7a1ce3b` (feat: GREEN)
2. **Task 2: Wire watcher and merge into server.ts** - `4b24d80` (test: RED), `318ee02` (feat: GREEN)

_TDD tasks each have test (RED) and implementation (GREEN) commits._

## Files Created/Modified
- `src/orchestrator/state.ts` - Added setMax() to SlotManager, removed readonly
- `src/orchestrator/index.ts` - Added applyConfig() method, removed readonly from config/promptTemplate
- `src/workflow/map-front-matter.ts` - New utility mapping WorkflowFileConfig to Partial<ForgectlConfig>
- `src/daemon/server.ts` - Wired mergeWorkflowConfig, WorkflowFileWatcher, mapFrontMatterToConfig
- `test/unit/orchestrator-reload.test.ts` - 14 tests for setMax, applyConfig, mapFrontMatterToConfig
- `test/unit/daemon-watcher.test.ts` - 5 tests for reload callback pattern
- `test/unit/daemon-config-merge.test.ts` - 7 tests for four-layer merge priority

## Decisions Made
- mapFrontMatterToConfig combines polling and concurrency into single orchestrator key rather than separate top-level keys
- Watcher only started when WORKFLOW.md exists to prevent crash on missing file
- watcher.stop() called before orchestrator.stop() in shutdown sequence to prevent reload during drain
- CLI flags layer passed as empty object (placeholder for future CLI flag passthrough)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- R4.3 (dynamic reload) and R4.4 (config merge) integration gaps are closed
- WorkflowFileWatcher and mergeWorkflowConfig now have production importers in server.ts
- Full test suite green at 644 tests

---
*Phase: 08-wire-workflow-runtime-integration*
*Completed: 2026-03-08*
