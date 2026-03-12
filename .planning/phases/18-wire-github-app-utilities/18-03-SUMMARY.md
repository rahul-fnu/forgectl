---
phase: 18-wire-github-app-utilities
plan: 03
subsystem: orchestrator
tags: [github-app, octokit, plumbing, webhook, dispatcher]

requires:
  - phase: 18-wire-github-app-utilities
    provides: "GitHubDeps interface, progress comments, check runs, PR descriptions in worker.ts"
provides:
  - "GitHub context plumbing from webhook handler through orchestrator to worker"
  - "Progress comments created at dispatch time for webhook-triggered runs"
  - "GitHubDeps constructed with octokit, issueContext, commentId, repoContext"
affects: [orchestrator, daemon, github-app]

tech-stack:
  added: []
  patterns: ["GitHubContext interface for cross-layer plumbing", "best-effort GitHub API calls with try/catch"]

key-files:
  created:
    - test/unit/wiring-github-plumbing.test.ts
  modified:
    - src/daemon/server.ts
    - src/orchestrator/index.ts
    - src/orchestrator/dispatcher.ts

key-decisions:
  - "GitHubContext defined locally in both index.ts and dispatcher.ts to avoid circular imports"
  - "commentId defaults to 0 when createProgressComment fails (graceful degradation)"
  - "issue.identifier used as runId for progress comment (matches worker's reference)"
  - "headSha left undefined for issue events; check runs correctly skipped via existing guard"
  - "Number(issue.id) for issueNumber since GitHub tracker stores issue number as string id"

patterns-established:
  - "GitHubContext as optional parameter preserves backward compat for all dispatch paths"
  - "Best-effort GitHub API calls with try/catch at every boundary"

requirements-completed: [GHAP-03, GHAP-07, GHAP-08, GHAP-09]

duration: 4min
completed: 2026-03-12
---

# Phase 18 Plan 03: Wire GitHub Context Plumbing Summary

**GitHub context (octokit + repo) flows from webhook handler through orchestrator to worker, enabling progress comments, check runs, and PR descriptions for webhook-triggered runs**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T02:14:38Z
- **Completed:** 2026-03-12T02:18:43Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Fixed the plumbing gap that made all GitHub utility code in worker.ts dead code
- server.ts onDispatch callback now passes octokit + repo through to orchestrator instead of discarding them
- dispatcher.ts constructs GitHubDeps with issueContext, commentId, repoContext and passes to executeWorker
- createProgressComment called at dispatch time before worker execution for webhook-triggered runs
- 8 unit tests verifying the full plumbing chain
- Full backward compatibility preserved for CLI and scheduler paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire GitHub context through server -> orchestrator -> dispatcher -> worker** - `3b993c7` (feat)
2. **Task 2: Verify full integration and existing tests still pass** - no changes needed (verification only)

## Files Created/Modified
- `test/unit/wiring-github-plumbing.test.ts` - 8 tests verifying plumbing chain: GitHubDeps construction, progress comments, backward compat, error handling
- `src/daemon/server.ts` - onDispatch callback passes octokit + repo to orchestrator.dispatchIssue
- `src/orchestrator/index.ts` - GitHubContext interface, dispatchIssue accepts and forwards githubContext
- `src/orchestrator/dispatcher.ts` - Constructs GitHubDeps, calls createProgressComment, passes githubDeps to executeWorker

## Decisions Made
- GitHubContext defined locally in both index.ts and dispatcher.ts to avoid circular import issues
- commentId defaults to 0 when createProgressComment fails, allowing worker to still attempt comment updates
- issue.identifier used as runId for progress comment since that is the most human-readable reference
- headSha intentionally left undefined for issue-triggered events (not available from issues.labeled/opened webhooks)
- Number(issue.id) used for issueContext.issueNumber since GitHub tracker adapter stores issue number as string

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All GitHub utility code in worker.ts (progress comments, check runs, PR descriptions) is now reachable for webhook-triggered runs
- The full plumbing chain is verified: webhook -> server.ts -> orchestrator -> dispatcher -> worker
- Check runs require headSha from PR events (future enhancement when PR webhook events are added)

---
*Phase: 18-wire-github-app-utilities*
*Completed: 2026-03-12*
