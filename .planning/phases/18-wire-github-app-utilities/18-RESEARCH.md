# Phase 18: Wire GitHub App Utilities - Research

**Researched:** 2026-03-11
**Domain:** GitHub App webhook wiring, execution lifecycle integration
**Confidence:** HIGH

## Summary

Phase 18 wires four dead-code GitHub App utility modules (reactions, check runs, PR descriptions, comments) into the forgectl execution lifecycle. All four modules are fully built and tested (40 passing tests) from Phase 14 -- this phase is pure integration wiring with no new GitHub API functionality.

One critical finding: the CONTEXT.md decision to register `issue_comment.reaction` and `issues.reaction` webhook event handlers is **not implementable** because GitHub does not deliver webhook events for reactions. The `@octokit/webhooks` library confirms only `created`, `edited`, and `deleted` actions exist for `issue_comment`, and `issues` has no `reaction` action either. The reaction handler module (`handleReactionEvent`) must be wired via an alternative mechanism -- either polling or dropping webhook-based reaction triggering entirely. Since the reaction handler is designed to approve/reject/trigger runs and the same functionality is available via slash commands, the pragmatic approach is to note this limitation and wire reactions as a polling-based feature or defer it.

The remaining three modules (comments consolidation, check runs, PR descriptions) are straightforward wiring with well-defined integration points in `server.ts`, `dispatcher.ts`, `worker.ts`, and `single.ts`.

**Primary recommendation:** Wire comments, check runs, and PR descriptions into the execution lifecycle. For reactions, document the GitHub API limitation and either implement as periodic polling or mark GHAP-07 as partially complete (handler exists, no webhook trigger available).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Consolidate all comment building into `src/github/comments.ts` -- single source of truth for all GitHub comment formatting
- Remove duplicate `buildResultComment()` from `src/orchestrator/comment.ts`; orchestrator calls the github comments module
- Dispatcher creates initial "Run started" progress comment with checklist; worker updates it at each stage
- Comment ID stored in run metadata (JSON column in run record) so it survives crashes/restarts
- Worker reads commentId from RunRepository to update progress
- Final result replaces progress checklist in-place (one comment per run total)
- Commit SHA obtained from webhook payload at dispatch time, stored in run metadata
- Check runs created only for PR-related runs (when SHA is available); issue-only runs skip check runs
- Worker creates check run at execution start, updates after validation loop iterations, completes at end
- Check run ID stored in run metadata (same pattern as comment ID)
- Check run output includes summary + validation details using `buildCheckSummary()`
- PR description generated once, after execution completes (validation passed, output collected)
- Generated for all PRs forgectl creates, regardless of trigger source
- Include `<!-- forgectl-generated -->` HTML marker; if marker absent (human-written), skip update
- Data sourced from ExecutionResult (agentResult, validation, tokenUsage) + git diff for changes list
- Register `issue_comment.reaction` and `issues.reaction` webhook event handlers (**NOTE: NOT POSSIBLE -- see Architecture Patterns**)
- Reaction-to-run mapping via commentId lookup in run metadata
- Rocket reaction uses same workflow as original run
- Eyes acknowledgment on reaction source comment
- Permission check applies to reactions same as slash commands

### Claude's Discretion
- Exact webhook event names for reaction events in @octokit/webhooks
- How to pass Octokit instance to worker for check run and comment updates
- ExecutionResult to PRDescriptionData mapping details
- Run metadata schema for commentId, checkRunId, and headSha fields

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GHAP-03 | Structured bot comments on issues/PRs with run status, results, cost summary | Comment consolidation: replace orchestrator/comment.ts with github/comments.ts; progress comment created at dispatch, updated in-place during execution, final result replaces checklist |
| GHAP-07 | Reactions as approvals (thumbs-up=approve, thumbs-down=reject, rocket=trigger) | **BLOCKED**: GitHub does not deliver webhook events for reactions. Handler code exists but cannot be triggered via webhooks. Alternative: polling or slash-command-only |
| GHAP-08 | Check runs on PRs (pending -> in_progress -> success/failure) | Wire createCheckRun/updateCheckRun/completeCheckRun into worker lifecycle; SHA from webhook payload stored in run metadata |
| GHAP-09 | Auto-generated PR descriptions with changes, validation, cost, linked issue | Wire updatePRDescription after output collection; forgectl-generated marker prevents clobbering human descriptions |
</phase_requirements>

## Standard Stack

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @octokit/app | installed | GitHub App authentication, webhook routing | Already used in Phase 14 |
| @octokit/webhooks | installed | Webhook event type definitions | Already used in Phase 14 |
| drizzle-orm | installed | Database queries for run metadata | Already used since Phase 10 |
| better-sqlite3 | installed | SQLite driver | Already used since Phase 10 |

No new dependencies needed. This phase only wires existing code.

## Architecture Patterns

### CRITICAL: Reaction Webhooks Do Not Exist

**Verified against:** `@octokit/webhooks` installed types (`webhook-identifiers.d.ts`), GitHub community discussion #20824, GitHub webhook documentation.

`issue_comment` events only support actions: `created`, `deleted`, `edited`.
`issues` events have no `reaction` action.

GitHub does NOT deliver webhook events when reactions are added to comments or issues. This is a known limitation requested by the community since 2022 with no implementation.

**Impact on GHAP-07:** The `handleReactionEvent()` function in `src/github/reactions.ts` is complete and tested, but cannot be triggered via webhooks. Options:
1. **Polling approach**: Periodically check reactions on bot comments (adds complexity, API rate limit concerns)
2. **Accept limitation**: Document that reactions are not webhook-triggerable; approve/reject/trigger remain slash-command-only
3. **Partial wire**: Register the handler but leave a TODO noting it requires polling infrastructure not yet built

**Recommendation:** Option 2 -- accept the limitation. The same functionality (approve, reject, trigger) is fully available via `/forgectl approve`, `/forgectl reject`, `/forgectl run` slash commands. Attempting to poll reactions adds significant complexity for marginal UX benefit.

### Run Metadata Storage Pattern

The `options` column in the `runs` table is a JSON text column that already stores `issueContext`. Extend this to also store:
- `headSha` (string) -- commit SHA from webhook payload for check run creation
- `checkRunId` (number) -- GitHub check run ID after creation
- `commentId` already has a dedicated `githubCommentId` integer column on the runs table

The `githubCommentId` column already exists with `setGithubCommentId()` and `findByGithubCommentId()` repository methods. For `checkRunId` and `headSha`, use the `options` JSON column or add dedicated columns. Using `options` JSON is simpler (no migration) and matches the existing pattern.

### Octokit Instance Passing

The webhook handler in `server.ts` has access to the Octokit instance via the webhook event callback. For the worker/dispatcher to make GitHub API calls (create comments, check runs, update PR descriptions), the Octokit instance needs to be passed through the execution chain.

**Pattern:** Add an optional `octokit` field to `DurabilityDeps` or create a new `GitHubDeps` interface. The dispatcher already receives `octokit` from webhook callbacks -- store it and pass it to the worker.

Alternative: Create the Octokit instance from the GitHub App config in the worker, using `ghAppService.getInstallationOctokit()`. This is simpler since the app service is available at daemon scope.

**Recommendation:** Pass the `ghAppService` (or a factory function) into the dispatcher/worker chain via the existing dependency injection pattern (`WebhookDeps` already does this). The worker calls `ghAppService.getInstallationOctokit()` when it needs to make API calls.

### Comment Consolidation Flow

Current state:
- `src/orchestrator/comment.ts` has `buildResultComment()` (used by `worker.ts` line 16, 167, 238)
- `src/github/comments.ts` has `buildResultComment()`, `buildProgressComment()`, `createProgressComment()`, `updateProgressComment()`
- These are completely different interfaces -- orchestrator version takes `CommentData`, github version takes `RunResult`

**Consolidation approach:**
1. Worker stops calling `orchestrator/comment.ts:buildResultComment()`
2. Worker calls `github/comments.ts:buildResultComment()` instead, mapping `AgentResult` + validation to `RunResult`
3. `orchestrator/comment.ts` is deleted or deprecated
4. Progress comments created at dispatch time, updated at each worker stage

### Check Run Lifecycle Integration Points

```
Dispatch (webhook payload has SHA)
  -> Store headSha in run options
  -> Worker start: createCheckRun(octokit, owner, repo, headSha, runId) -> store checkRunId
  -> After each validation attempt: updateCheckRun(...)
  -> Worker complete: completeCheckRun(octokit, owner, repo, checkRunId, success, summary)
```

Only for PR-triggered runs where `headSha` is available. Issue-only runs skip check runs.

### PR Description Generation Integration Points

```
Worker complete (validation passed, output collected)
  -> If output.mode === "git" and branch exists
  -> Check if PR exists for branch (octokit.rest.pulls.list)
  -> If PR exists, check for <!-- forgectl-generated --> marker
  -> If marker present or description empty, call updatePRDescription()
  -> Data: map ExecutionResult + git changes to PRDescriptionData
```

### Recommended Project Structure (no changes needed)

All modules already exist:
```
src/github/
  reactions.ts     # handleReactionEvent (exists, cannot wire to webhooks)
  checks.ts        # createCheckRun, updateCheckRun, completeCheckRun, buildCheckSummary
  pr-description.ts # buildPRDescription, updatePRDescription
  comments.ts      # buildProgressComment, buildResultComment, createProgressComment, updateProgressComment
  webhooks.ts      # registerWebhookHandlers (to be extended)
  command-handler.ts # handleSlashCommand
src/orchestrator/
  comment.ts       # buildResultComment (TO BE REMOVED/DEPRECATED)
  worker.ts        # executeWorker (TO BE MODIFIED)
  dispatcher.ts    # dispatchIssue (TO BE MODIFIED)
src/orchestration/
  single.ts        # executeSingleAgent (TO BE MODIFIED for CLI path)
```

### Anti-Patterns to Avoid
- **Creating a new Octokit instance per API call:** Use `ghAppService.getInstallationOctokit()` once per worker execution, reuse the instance
- **Storing check run state in memory only:** All IDs must go through RunRepository so they survive daemon crashes
- **Blocking on GitHub API errors:** All comment/check-run/PR-description calls must be best-effort with error catching (same pattern as existing `tracker.postComment().catch()`)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Comment formatting | New comment builders | `src/github/comments.ts` | Already built and tested (17 tests) |
| Check run API calls | Direct API calls in worker | `src/github/checks.ts` | Already built and tested (6 tests) |
| PR descriptions | Inline description building | `src/github/pr-description.ts` | Already built and tested (7 tests) |
| Reaction handling | New reaction logic | `src/github/reactions.ts` | Already built and tested (10 tests) |

**Key insight:** All four modules are complete and passing tests. This phase is purely about calling them from the right places in the execution lifecycle.

## Common Pitfalls

### Pitfall 1: Assuming Reaction Webhooks Exist
**What goes wrong:** Registering `issues.reaction` or `issue_comment.reaction` handlers that never fire
**Why it happens:** The CONTEXT.md was written assuming these events exist
**How to avoid:** Acknowledge the GitHub API limitation; do not register nonexistent event handlers
**Warning signs:** TypeScript compilation errors on `app.webhooks.on("issues.reaction", ...)` -- the type system will reject invalid event names

### Pitfall 2: Breaking Existing Worker Comment Flow
**What goes wrong:** Removing `orchestrator/comment.ts` without updating all callers, breaking non-GitHub runs
**Why it happens:** The worker uses `buildResultComment` for ALL runs, not just GitHub-triggered ones
**How to avoid:** The new consolidated flow must handle the case where no GitHub context is available (CLI runs, non-GitHub trackers)
**Warning signs:** Import errors after removing `orchestrator/comment.ts`

### Pitfall 3: PR Description Clobbering Human Edits
**What goes wrong:** Overwriting a user-written PR description with generated content
**Why it happens:** Not checking for the `<!-- forgectl-generated -->` marker before updating
**How to avoid:** Always check existing PR body for the marker; skip update if marker is absent and body is non-empty
**Warning signs:** User complaints about lost PR descriptions

### Pitfall 4: Check Run Without SHA
**What goes wrong:** Calling `createCheckRun` with undefined SHA causes API error
**Why it happens:** Issue-only runs don't have a commit SHA
**How to avoid:** Guard all check run calls with `if (headSha)` check
**Warning signs:** 422 errors from GitHub API

### Pitfall 5: Missing Octokit in Non-Webhook Paths
**What goes wrong:** Worker tries to update comment/check-run but has no Octokit instance
**Why it happens:** CLI-triggered runs don't go through webhook handler, no Octokit available
**How to avoid:** Make all GitHub API calls optional -- only execute when Octokit is available
**Warning signs:** TypeError: cannot read properties of undefined

## Code Examples

### Mapping AgentResult to RunResult (for comment consolidation)

```typescript
// Map worker execution data to github/comments.ts RunResult
import type { RunResult } from "../github/comments.js";
import type { AgentResult } from "../agent/session.js";

function toRunResult(
  runId: string,
  agentResult: AgentResult,
  durationMs: number,
  validationResult?: ValidationResult,
  branch?: string,
  workflow?: string,
): RunResult {
  return {
    runId,
    status: agentResult.status === "completed" ? "success" : "failure",
    duration: formatDuration(durationMs),
    cost: agentResult.tokenUsage ? {
      input_tokens: agentResult.tokenUsage.input,
      output_tokens: agentResult.tokenUsage.output,
      estimated_usd: `$${((agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000).toFixed(4)}`,
    } : undefined,
    changes: [], // populated from git diff
    validationResults: validationResult?.stepResults.map(sr => ({
      step: sr.name,
      passed: sr.passed,
      output: sr.error,
    })),
    workflow,
    agent: agentResult.status, // or plan.agent.type
  };
}
```

### Check Run Lifecycle in Worker

```typescript
// In worker.ts executeWorker(), after prepareExecution:
let checkRunId: number | undefined;
const headSha = runMetadata?.headSha;

if (octokit && headSha && repoContext) {
  try {
    checkRunId = await createCheckRun(octokit, repoContext.owner, repoContext.repo, headSha, plan.runId);
    // Store checkRunId in run metadata
  } catch (err) {
    logger.warn("worker", `Failed to create check run: ${err}`);
  }
}

// ... after validation ...
if (octokit && checkRunId && repoContext) {
  try {
    const summary = buildCheckSummary(runResult);
    await completeCheckRun(octokit, repoContext.owner, repoContext.repo, checkRunId, validationResult.passed, summary);
  } catch (err) {
    logger.warn("worker", `Failed to complete check run: ${err}`);
  }
}
```

### Progress Comment Flow

```typescript
// In dispatcher, after dispatch:
if (octokit && issueContext) {
  try {
    const commentId = await createProgressComment(octokit, issueContext, {
      runId: plan.runId,
      status: "started",
      completedStages: [],
    });
    runRepo.setGithubCommentId(plan.runId, commentId);
  } catch (err) {
    logger.warn("dispatcher", `Failed to create progress comment: ${err}`);
  }
}

// In worker, at each stage:
if (octokit && issueContext && commentId) {
  try {
    await updateProgressComment(octokit, issueContext, commentId, {
      runId: plan.runId,
      status: "running",
      completedStages: ["agent_executing"],
    });
  } catch (err) {
    logger.warn("worker", `Failed to update progress comment: ${err}`);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| orchestrator/comment.ts for result comments | github/comments.ts consolidated | Phase 18 | Single source of truth for all comment formatting |
| tracker.postComment() with raw string | Progress comment + in-place updates | Phase 18 | One comment per run, live updates |
| No check runs | Check run lifecycle on PRs | Phase 18 | GitHub PR status checks integration |
| No PR descriptions | Auto-generated PR descriptions | Phase 18 | Self-documenting PRs |

## Open Questions

1. **How to handle GHAP-07 (reactions)?**
   - What we know: GitHub does not deliver reaction webhook events. The handler code exists and is tested.
   - What's unclear: Whether polling is acceptable or if this should be deferred
   - Recommendation: Mark GHAP-07 as "handler ready, webhook trigger unavailable" and document the limitation. Slash commands provide identical functionality.

2. **Where to get headSha for check runs?**
   - What we know: Webhook payloads for `issues.labeled` and `issue_comment.created` include repository and issue info but not necessarily a commit SHA
   - What's unclear: PR events include `pull_request.head.sha` but issue events don't
   - Recommendation: For PR-related events, extract SHA from the PR head. For issue events, skip check runs. The webhook payload type determines SHA availability.

3. **How to find the PR for a completed run?**
   - What we know: The worker creates a git branch and pushes it. The PR may already exist or need to be created.
   - What's unclear: Whether forgectl creates PRs (via `octokit.rest.pulls.create`) or if the user creates them
   - Recommendation: After output collection, list PRs with matching branch. If forgectl creates the PR, add the description at creation time. If PR already exists, update it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.9 |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GHAP-03 | Comment consolidation: worker uses github/comments.ts | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/github-comments.test.ts -x` | Existing (17 tests) |
| GHAP-03 | Progress comment created at dispatch | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-comments.test.ts -x` | New in Wave 0 |
| GHAP-03 | orchestrator/comment.ts removed, imports updated | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/worker.test.ts -x` | New in Wave 0 |
| GHAP-07 | Reaction handler documented as not webhook-triggerable | manual-only | N/A (documentation task) | N/A |
| GHAP-08 | Check run created/updated/completed during execution | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-checks.test.ts -x` | New in Wave 0 |
| GHAP-08 | Check run skipped when no headSha | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-checks.test.ts -x` | New in Wave 0 |
| GHAP-09 | PR description generated after successful execution | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-pr-description.test.ts -x` | New in Wave 0 |
| GHAP-09 | forgectl-generated marker prevents clobbering | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-pr-description.test.ts -x` | New in Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/wiring-comments.test.ts` -- tests comment consolidation and progress comment wiring
- [ ] `test/unit/wiring-checks.test.ts` -- tests check run lifecycle wiring into worker
- [ ] `test/unit/wiring-pr-description.test.ts` -- tests PR description generation wiring

## Sources

### Primary (HIGH confidence)
- `@octokit/webhooks` installed package `webhook-identifiers.d.ts` -- verified issue_comment and issues event action types
- Project source code: `src/github/reactions.ts`, `src/github/checks.ts`, `src/github/pr-description.ts`, `src/github/comments.ts`, `src/orchestrator/comment.ts`, `src/orchestrator/worker.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestration/single.ts`, `src/daemon/server.ts`
- `src/storage/repositories/runs.ts` -- RunRepository interface, githubCommentId column
- `src/storage/schema.ts` -- runs table schema with options JSON column

### Secondary (MEDIUM confidence)
- [GitHub community discussion #20824](https://github.com/orgs/community/discussions/20824) -- confirms no webhook events for reactions (requested since 2022, unimplemented)
- [GitHub webhook events documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads) -- authoritative list of webhook event types
- [octokit/webhooks.js](https://github.com/octokit/webhooks.js/) -- @octokit/webhooks library

### Tertiary (LOW confidence)
None -- all findings verified against installed packages and official documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all modules already built
- Architecture: HIGH -- integration points identified in source code, patterns verified
- Pitfalls: HIGH -- reaction webhook limitation verified against installed @octokit/webhooks types
- Reactions (GHAP-07): HIGH -- confirmed not possible via webhooks, documented limitation

**Research date:** 2026-03-11
**Valid until:** 2026-04-11 (stable -- no external dependency changes expected)
