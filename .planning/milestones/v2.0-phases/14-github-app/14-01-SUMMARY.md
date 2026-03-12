---
phase: 14-github-app
plan: 01
subsystem: api
tags: [github-app, octokit, webhooks, hmac, fastify]

requires:
  - phase: 10-persistent-storage
    provides: SQLite database, Drizzle ORM, migration system, RunRepository
  - phase: 13-governance
    provides: approval_context and approval_action columns on runs table
provides:
  - GitHubAppConfigSchema in config/schema.ts
  - GitHubAppService wrapping @octokit/app
  - Webhook route at POST /api/v1/github/webhook with HMAC verification
  - Webhook handler scaffold for issues and comments
  - githubCommentId column on runs table
  - GitHub App type definitions (RepoContext, IssueContext, CommandType, ParsedCommand)
affects: [14-02, 14-03, 14-04]

tech-stack:
  added: ["@octokit/app", "@octokit/rest"]
  patterns: ["Fastify encapsulated plugin for raw-body content type parsing", "Factory function for service initialization"]

key-files:
  created:
    - src/github/types.ts
    - src/github/app.ts
    - src/github/routes.ts
    - src/github/webhooks.ts
    - drizzle/0004_github_app_comment_id.sql
    - drizzle/meta/0004_snapshot.json
    - test/unit/github-app.test.ts
  modified:
    - src/config/schema.ts
    - src/storage/schema.ts
    - src/storage/repositories/runs.ts
    - drizzle/meta/_journal.json
    - package.json

key-decisions:
  - "Encapsulated Fastify plugin scopes raw-body parser to webhook prefix only, preventing JSON parse breakage on other routes"
  - "Private key validated at service construction time with descriptive error on invalid format"
  - "Webhook signature errors detected by message content matching from @octokit/webhooks error"

patterns-established:
  - "GitHub service pattern: class wrapping @octokit/app with factory function"
  - "Webhook route pattern: encapsulated plugin with raw body preservation for HMAC"

requirements-completed: [GHAP-01]

duration: 7min
completed: 2026-03-10
---

# Phase 14 Plan 01: GitHub App Foundation Summary

**GitHub App config schema, @octokit/app service, Fastify webhook route with HMAC-SHA256 verification, and runs table comment_id migration**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-10T06:22:56Z
- **Completed:** 2026-03-10T06:30:00Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- GitHubAppConfigSchema with zod validation integrated into main ConfigSchema as optional section
- GitHubAppService class wrapping @octokit/app with private key validation and installation auth
- Webhook POST route at /api/v1/github/webhook with HMAC-SHA256 signature verification (401 on invalid)
- Webhook handler scaffold for issues.labeled, issues.opened, issue_comment.created, issue_comment.deleted
- Database migration adding github_comment_id column to runs table with full repository support

## Task Commits

Each task was committed atomically:

1. **Task 1: Config schema, types, and database migration (RED)** - `431e277` (test)
2. **Task 1: Config schema, types, and database migration (GREEN)** - `1be5c76` (feat)
3. **Task 2: GitHub App service, webhook route, and handler scaffold** - `5bace9b` (feat)

_Note: Task 1 used TDD with RED/GREEN commits_

## Files Created/Modified
- `src/github/types.ts` - GitHubAppConfig, RepoContext, IssueContext, CommandType, ParsedCommand interfaces
- `src/github/app.ts` - GitHubAppService wrapping @octokit/app with private key validation
- `src/github/routes.ts` - Fastify webhook route with encapsulated raw-body parser and HMAC verification
- `src/github/webhooks.ts` - Webhook handler scaffold for 4 event types
- `src/config/schema.ts` - Added GitHubAppConfigSchema and github_app optional field to ConfigSchema
- `src/storage/schema.ts` - Added githubCommentId column to runs table
- `src/storage/repositories/runs.ts` - Added githubCommentId to RunRow, findByGithubCommentId, setGithubCommentId
- `drizzle/0004_github_app_comment_id.sql` - Migration adding github_comment_id column
- `drizzle/meta/0004_snapshot.json` - Drizzle migration snapshot
- `drizzle/meta/_journal.json` - Updated migration journal
- `test/unit/github-app.test.ts` - 5 tests for config schema validation and RunRow type
- `package.json` - Added @octokit/app and @octokit/rest dependencies

## Decisions Made
- Encapsulated Fastify plugin scopes raw-body parser to webhook prefix only, preventing JSON parse breakage on other routes
- Private key validated at service construction time with descriptive error on invalid format
- Webhook signature errors detected by message content matching from @octokit/webhooks error

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed nullable comment.user in webhook handler**
- **Found during:** Task 2 (webhook handler scaffold)
- **Issue:** TypeScript error TS18047: 'comment.user' is possibly 'null' in issue_comment.created handler
- **Fix:** Added optional chaining with nullish coalescing: `comment.user?.login ?? "unknown"`
- **Files modified:** src/github/webhooks.ts
- **Verification:** npm run typecheck passes
- **Committed in:** 5bace9b (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Type safety fix required by strict TypeScript. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GitHub App foundation complete with config, service, webhook endpoint, and event routing
- Plans 02-04 can build on webhook handlers, command parsing, and reaction posting
- RunRepository supports githubCommentId for tracking status comment association

---
*Phase: 14-github-app*
*Completed: 2026-03-10*
