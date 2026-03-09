---
phase: 03-workflow-contract
plan: 01
subsystem: workflow
tags: [yaml, zod, template, front-matter, parser]

requires:
  - phase: 01-tracker-adapter-github-notion
    provides: TrackerIssue type for template variable building
provides:
  - WORKFLOW.md parser (parseWorkflowFile, loadWorkflowFile)
  - Front matter zod schema with strict validation (WorkflowFrontMatterSchema)
  - Strict prompt template renderer (renderPromptTemplate)
  - Template variable builder from TrackerIssue (buildTemplateVars)
  - WorkflowFileConfig and ValidatedWorkflowFile types
affects: [03-workflow-contract, workflow, orchestration]

tech-stack:
  added: []
  patterns:
    - "YAML front matter extraction with regex for --- delimited blocks"
    - "Zod strict schema for front matter validation (rejects unknown keys)"
    - "Separate strict template renderer (throws on unknown vars, unlike expandTemplate)"
    - "Partial tracker schema without superRefine for override contexts"

key-files:
  created:
    - src/workflow/workflow-file.ts
    - src/workflow/template.ts
    - test/unit/workflow-file.test.ts
    - test/unit/workflow-template.test.ts
  modified:
    - src/workflow/types.ts

key-decisions:
  - "Separate strict renderPromptTemplate function instead of modifying existing expandTemplate"
  - "Tracker partial schema without superRefine since front matter provides overrides not complete configs"
  - "Regex-based front matter extraction matching --- only at file start position 0"
  - "Arrays serialize as JSON in templates, null values as empty string"

patterns-established:
  - "WORKFLOW.md format: YAML front matter (---delimited) + markdown body as prompt template"
  - "Strict template rendering: unknown variables throw, arrays as JSON, null as empty"
  - "Partial zod schemas for override contexts (no superRefine on partial tracker config)"

requirements-completed: [R4.1, R4.2]

duration: 3min
completed: 2026-03-08
---

# Phase 03 Plan 01: WORKFLOW.md Parser & Template Renderer Summary

**YAML front matter parser with zod strict validation and strict prompt template renderer for issue-aware variable substitution**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T06:59:51Z
- **Completed:** 2026-03-08T07:03:01Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- WORKFLOW.md parser that extracts YAML front matter and markdown body with proper --- delimiter handling
- Zod strict schema for front matter validation (extends, tracker partial, polling, concurrency, workspace, agent)
- Strict prompt template renderer with JSON array serialization, null-to-empty mapping, and unknown var rejection
- buildTemplateVars maps TrackerIssue + attempt number into template variable namespace

## Task Commits

Each task was committed atomically:

1. **Task 1: WORKFLOW.md parser and front matter schema** - `7346112` (feat, TDD)
2. **Task 2: Strict prompt template renderer** - `2eb7d48` (feat, TDD)

## Files Created/Modified
- `src/workflow/workflow-file.ts` - WORKFLOW.md parser, front matter zod schema, file loader
- `src/workflow/template.ts` - Strict prompt template renderer, template variable builder
- `src/workflow/types.ts` - Added WorkflowFileConfig and ValidatedWorkflowFile types
- `test/unit/workflow-file.test.ts` - 14 tests for parsing, schema validation, file loading
- `test/unit/workflow-template.test.ts` - 13 tests for strict rendering and variable building

## Decisions Made
- Created separate `renderPromptTemplate` instead of modifying `expandTemplate` (different semantics: strict vs. leave-as-is)
- Tracker partial schema omits superRefine since front matter provides overrides, not complete configs
- Regex matches `---` only at file start (position 0) to avoid false splits on markdown horizontal rules
- Arrays in template variables serialize as JSON arrays, null values as empty string

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Parser and template renderer ready for Plan 02 (config merge and watcher)
- Types exported and available for import by downstream modules

## Self-Check: PASSED

- All 5 files verified on disk
- Commit 7346112 (Task 1) verified in git log
- Commit 2eb7d48 (Task 2) verified in git log
- 363 tests passing (13 new), 0 regressions

---
*Phase: 03-workflow-contract*
*Completed: 2026-03-08*
