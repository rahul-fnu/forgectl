---
phase: 01-tracker-adapter-github-notion
plan: 01
subsystem: tracker
tags: [zod, typescript-interfaces, factory-pattern, token-resolution]

# Dependency graph
requires: []
provides:
  - TrackerAdapter interface with 6 methods (3 fetch + 3 write)
  - TrackerIssue normalized model with 13 fields
  - resolveToken utility for $ENV_VAR resolution
  - TrackerConfigSchema with kind-specific validation
  - TrackerAdapterFactory registry pattern
affects: [01-02, 01-03, 01-04]

# Tech tracking
tech-stack:
  added: []
  patterns: [factory-registry for stateful adapters, superRefine for kind-specific validation]

key-files:
  created:
    - src/tracker/types.ts
    - src/tracker/token.ts
    - src/tracker/registry.ts
    - test/unit/tracker-types.test.ts
  modified:
    - src/config/schema.ts

key-decisions:
  - "Factory registry instead of static instances (adapters are stateful with tokens/config)"
  - "superRefine for kind-specific validation (github requires repo, notion requires database_id)"
  - "Token resolution supports both $ENV_VAR and literal values"

patterns-established:
  - "TrackerAdapter interface: readonly kind + 6 async methods"
  - "TrackerConfig type mirrors zod schema shape for type safety"
  - "registerTrackerFactory/createTrackerAdapter pair for adapter registration"

requirements-completed: [R1.1, R1.4]

# Metrics
duration: 2min
completed: 2026-03-07
---

# Phase 01 Plan 01: Tracker Foundation Types Summary

**TrackerAdapter interface, TrackerIssue model, token resolver, config schema with kind-specific validation, and factory registry for adapter instantiation**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-07T21:10:16Z
- **Completed:** 2026-03-07T21:12:32Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- TrackerAdapter interface with 6 methods (fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates, postComment, updateState, updateLabels) + readonly kind
- TrackerIssue model with 13 fields including metadata catch-all
- resolveToken utility handles $ENV_VAR, literal tokens, and throws on missing vars
- TrackerConfigSchema with defaults (60s poll, auto_close false) and superRefine for kind-specific requirements
- Factory registry ready for GitHub and Notion adapter registration

## Task Commits

Each task was committed atomically:

1. **Task 1: Define TrackerAdapter interface, TrackerIssue model, token resolver, and config schema** - `b5e4598` (feat, TDD)
2. **Task 2: Create tracker adapter registry with factory pattern** - `567c459` (feat)

## Files Created/Modified
- `src/tracker/types.ts` - TrackerAdapter interface, TrackerIssue model, TrackerConfig type
- `src/tracker/token.ts` - resolveToken utility for $ENV_VAR resolution
- `src/tracker/registry.ts` - Factory registry with registerTrackerFactory and createTrackerAdapter
- `src/config/schema.ts` - TrackerConfigSchema added, ConfigSchema.tracker optional section
- `test/unit/tracker-types.test.ts` - 12 unit tests for token resolution and config validation

## Decisions Made
- Used factory registry pattern (vs static instances) because tracker adapters hold stateful config (tokens, repo refs)
- Used zod superRefine for kind-specific validation instead of discriminated unions (cleaner error messages)
- Token resolution supports both $ENV_VAR references and literal values for flexibility

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- TrackerAdapter interface ready for GitHub adapter (Plan 02) and Notion adapter (Plan 03) to implement
- Registry ready for adapters to call registerTrackerFactory
- Config schema ready for YAML configs with tracker section
- All 255 existing tests continue to pass (no regressions)

---
*Phase: 01-tracker-adapter-github-notion*
*Completed: 2026-03-07*
