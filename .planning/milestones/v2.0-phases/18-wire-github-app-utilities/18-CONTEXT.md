# Phase 18: Wire GitHub App Utilities - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire 4 dead-code GitHub App utility modules (reactions, check runs, PR descriptions, comments) into the actual execution lifecycle. All modules are built and tested from Phase 14 — this phase is pure wiring. No new GitHub features or UI capabilities.

</domain>

<decisions>
## Implementation Decisions

### Comment consolidation
- Consolidate all comment building into `src/github/comments.ts` — single source of truth for all GitHub comment formatting
- Remove duplicate `buildResultComment()` from `src/orchestrator/comment.ts`; orchestrator calls the github comments module
- Dispatcher creates initial "Run started" progress comment with checklist; worker updates it at each stage (agent executing → validating → collecting output)
- Comment ID stored in run metadata (JSON column in run record) so it survives crashes/restarts
- Worker reads commentId from RunRepository to update progress
- Final result replaces progress checklist in-place (one comment per run total, as decided in Phase 14)

### Check run lifecycle
- Commit SHA obtained from webhook payload at dispatch time, stored in run metadata
- Check runs created only for PR-related runs (when SHA is available); issue-only runs skip check runs
- Worker creates check run at execution start, updates after validation loop iterations, completes at end
- Check run ID stored in run metadata (same pattern as comment ID)
- Check run output includes summary + validation details: title shows pass/fail, summary has duration + cost, details section lists validation results and files changed (uses `buildCheckSummary()`)

### PR description generation
- PR description generated once, after execution completes (validation passed, output collected)
- Generated for all PRs forgectl creates, regardless of trigger source (CLI or webhook)
- Overwrite behavior: include `<!-- forgectl-generated -->` HTML marker in description; if marker absent (human-written), skip update to avoid clobbering
- Data sourced from ExecutionResult (agentResult, validation, tokenUsage) + git diff for changes list

### Reaction event routing
- Register `issue_comment.reaction` and `issues.reaction` webhook event handlers in `registerWebhookHandlers()`
- Reaction-to-run mapping via commentId lookup in run metadata — reactions on non-bot comments ignored
- Rocket reaction (trigger/rerun) uses the same workflow as the original run that produced the comment
- Eyes acknowledgment: add :eyes: reaction to the comment where the user's reaction was placed (consistent with Phase 14 slash command behavior)
- Permission check applies to reactions same as slash commands (collaborator check)

### Claude's Discretion
- Exact webhook event names for reaction events in @octokit/webhooks
- How to pass Octokit instance to worker for check run and comment updates
- ExecutionResult → PRDescriptionData mapping details
- Run metadata schema for commentId, checkRunId, and headSha fields

</decisions>

<specifics>
## Specific Ideas

- Progress comment checklist should match Phase 14 decision: stages checked off as they complete (agent executing, validation attempt N, output collection)
- Clarification comments use `buildClarificationComment()` from the consolidated github/comments.ts module
- Bot comment style carries forward from Phase 14: collapsible `<details>` sections, conversational but structured tone

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/github/reactions.ts`: `handleReactionEvent()`, `REACTION_MAP` — complete, tested, never called
- `src/github/checks.ts`: `createCheckRun()`, `updateCheckRun()`, `completeCheckRun()`, `buildCheckSummary()` — complete, tested, never called
- `src/github/pr-description.ts`: `buildPRDescription()`, `updatePRDescription()`, `PRDescriptionData` — complete, tested, never called
- `src/github/comments.ts`: `buildProgressComment()`, `buildResultComment()`, `buildClarificationComment()`, `createProgressComment()`, `updateProgressComment()` — complete, tested, never called
- `src/orchestrator/comment.ts`: `buildResultComment()` — duplicate of github/comments.ts version, currently used by dispatcher

### Established Patterns
- Run metadata JSON column for storing transient IDs (commentId, checkRunId, headSha)
- `registerWebhookHandlers()` in server.ts already handles issues.labeled, issues.opened, issue_comment.created
- Fire-and-forget dispatch: `void executeWorkerAndHandle()` — reaction handler follows same pattern
- DurabilityDeps for passing dependencies to execution functions

### Integration Points
- `src/daemon/server.ts:152-206`: registerWebhookHandlers() — add reaction event handlers
- `src/orchestrator/dispatcher.ts:250`: postComment() — replace with github/comments.ts module
- `src/orchestration/single.ts`: executeSingleAgent() — hook in check run create/update/complete and PR description
- `src/orchestrator/dispatcher.ts`: dispatchIssue() — create initial progress comment, store commentId in run metadata

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 18-wire-github-app-utilities*
*Context gathered: 2026-03-11*
