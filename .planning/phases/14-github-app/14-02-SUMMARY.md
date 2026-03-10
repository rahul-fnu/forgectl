---
phase: 14-github-app
plan: 02
subsystem: github
tags: [octokit, webhooks, slash-commands, permissions, github-app]

requires:
  - phase: 14-github-app/01
    provides: GitHubAppService, types, webhook skeleton, Fastify plugin
provides:
  - Slash command parser (parseSlashCommand) for 7 /forgectl commands
  - Permission checker (hasWriteAccess) for collaborator verification
  - Full webhook handlers for issues.labeled, issues.opened, issue_comment.created
  - webhookPayloadToTrackerIssue converter from GitHub payloads to TrackerIssue
  - WebhookDeps dependency injection interface for handler wiring
affects: [14-github-app/03, 14-github-app/04]

tech-stack:
  added: []
  patterns: [webhook-dependency-injection, payload-to-tracker-conversion]

key-files:
  created:
    - src/github/commands.ts
    - src/github/permissions.ts
    - test/unit/github-commands.test.ts
    - test/unit/github-permissions.test.ts
    - test/unit/github-webhooks.test.ts
  modified:
    - src/github/webhooks.ts

key-decisions:
  - "Regex uses [ \\t]+ instead of \\s+ to avoid matching newlines in command args"
  - "WebhookDeps interface for dependency injection keeps handlers testable without real GitHub App"
  - "Permission check returns false on any error (non-collaborators silently denied)"

patterns-established:
  - "Webhook handler DI: registerWebhookHandlers(app, deps) takes WebhookDeps for testability"
  - "Reaction protocol: eyes for acknowledged commands, -1 for unauthorized"

requirements-completed: [GHAP-02, GHAP-04, GHAP-05]

duration: 4min
completed: 2026-03-10
---

# Phase 14 Plan 02: Commands & Webhooks Summary

**Slash command parser with permission enforcement and webhook event handlers for label triggers and issue comment commands**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T06:32:29Z
- **Completed:** 2026-03-10T06:36:17Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Slash command parser recognizes all 7 /forgectl commands from issue comment bodies
- Permission checker verifies collaborator write/admin access via Octokit API
- Webhook handlers wire label triggers and slash commands with full permission enforcement
- 28 tests covering command parsing, permission checks, and webhook handler scenarios

## Task Commits

Each task was committed atomically:

1. **Task 1: Slash command parser and permission checker** - `a7aa577` (feat)
2. **Task 2: Webhook event handlers for triggers and commands** - `ae41eca` (feat)

_TDD approach: tests written first (RED), then implementation (GREEN) for both tasks_

## Files Created/Modified
- `src/github/commands.ts` - parseSlashCommand, buildHelpMessage, buildErrorMessage
- `src/github/permissions.ts` - hasWriteAccess collaborator permission check
- `src/github/webhooks.ts` - Full webhook handlers replacing skeleton, WebhookDeps, webhookPayloadToTrackerIssue
- `test/unit/github-commands.test.ts` - 13 tests for command parsing
- `test/unit/github-permissions.test.ts` - 5 tests for permission checks
- `test/unit/github-webhooks.test.ts` - 10 tests for webhook handlers

## Decisions Made
- Regex uses `[ \t]+` instead of `\s+` to avoid matching newlines in command arguments
- WebhookDeps interface for dependency injection keeps handlers testable without real GitHub App
- Permission check returns false on any error (non-collaborators silently denied)
- Reaction protocol: :eyes: for acknowledged commands, :-1: for unauthorized

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed regex newline matching in command parser**
- **Found during:** Task 1 (Slash command parser)
- **Issue:** `\s+` in regex matched newline characters, causing text on following lines to be captured as command args
- **Fix:** Changed `\s+` to `[ \t]+` (horizontal whitespace only)
- **Files modified:** src/github/commands.ts
- **Verification:** Test "extracts command from middle of body" passes
- **Committed in:** a7aa577 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for correct multiline comment parsing. No scope creep.

## Issues Encountered
- Pre-existing typecheck error in src/github/reactions.ts (unused variable) -- not caused by this plan, out of scope

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Command parser and webhook handlers ready for Plan 03 (reactions/status updates) and Plan 04 (end-to-end wiring)
- WebhookDeps interface provides clean injection point for real dispatcher and command handler implementations

---
*Phase: 14-github-app*
*Completed: 2026-03-10*
