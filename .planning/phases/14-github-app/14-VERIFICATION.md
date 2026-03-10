---
phase: 14-github-app
verified: 2026-03-10T06:50:00Z
status: gaps_found
score: 3/5 must-haves verified
gaps:
  - truth: "Users can issue slash commands (/forgectl run, rerun, stop, status, approve, reject, help) in issue or PR comments"
    status: partial
    reason: "Commands are parsed and permission-checked correctly, but the daemon onCommand callback only logs -- it does not actually dispatch, stop, approve, reject, or respond with status/help. Commands are recognized but have no effect."
    artifacts:
      - path: "src/daemon/server.ts"
        issue: "onCommand callback (line 166-168) only calls daemonLogger.info, does not route to orchestrator, approval service, or reply with help/status"
    missing:
      - "onCommand must call orchestrator.dispatch for 'run', orchestrator.rerun for 'rerun', orchestrator.stop for 'stop', post status reply for 'status', approveRun/rejectRun for 'approve'/'reject', post help message for 'help'"
  - truth: "A GitHub App receives webhooks with HMAC-SHA256 verification and dispatches runs based on labels or issue events"
    status: partial
    reason: "Webhook verification is fully implemented and correct. However, the daemon onDispatch callback only logs -- it does not actually call orchestrator.dispatch() to start a run."
    artifacts:
      - path: "src/daemon/server.ts"
        issue: "onDispatch callback (line 159-164) logs but never calls orchestrator.dispatch or equivalent. The 'if (orchestrator)' branch does nothing actionable."
    missing:
      - "onDispatch must call orchestrator.dispatch(issue) when orchestrator is available to actually start a run"
---

# Phase 14: GitHub App Verification Report

**Phase Goal:** Users interact with forgectl entirely through GitHub -- triggering runs, approving work, asking questions, and reviewing results without leaving their browser or phone
**Verified:** 2026-03-10T06:50:00Z
**Status:** gaps_found
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A GitHub App receives webhooks with HMAC-SHA256 verification and dispatches runs based on labels or issue events | PARTIAL | Webhook verification works (routes.ts verifyAndReceive). Label/event handlers exist in webhooks.ts. But daemon onDispatch only logs -- no actual run dispatch occurs. |
| 2 | Users can issue slash commands (/forgectl run, rerun, stop, status, approve, reject, help) in issue or PR comments | PARTIAL | Parser recognizes all 7 commands (commands.ts). Permission check works. But daemon onCommand only logs -- commands have no effect. |
| 3 | Only repository collaborators can issue commands (permission checks on every interaction) | VERIFIED | permissions.ts hasWriteAccess checks getCollaboratorPermissionLevel for admin/write. webhooks.ts calls it before dispatching. reactions.ts checks independently. 5 tests confirm behavior. |
| 4 | An agent mid-run can post a clarification question on the issue, pause, and resume when the user replies | VERIFIED | buildClarificationComment in comments.ts. webhooks.ts issue_comment.created handler checks findWaitingRunForIssue, calls resumeRun from durability/pause.ts. Daemon wires findWaitingRunForIssue with pauseContext lookup. 4 tests confirm flow. |
| 5 | PRs created by forgectl include check runs (pending/in_progress/success/failure) and auto-generated descriptions with changes, validation, cost, and linked issue | VERIFIED | checks.ts: createCheckRun (in_progress), updateCheckRun, completeCheckRun (success/failure with output summary). pr-description.ts: buildPRDescription includes Closes #N, changes, validation, cost table, agent/workflow info, forgectl footer. updatePRDescription calls pulls.update. All tested. |

**Score:** 3/5 truths verified (2 partial)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/github/types.ts` | Config types, shared interfaces | VERIFIED | GitHubAppConfig, RepoContext, IssueContext, CommandType, ParsedCommand -- all present, 34 lines |
| `src/github/app.ts` | GitHubAppService initialization | VERIFIED | Reads PEM key, validates format, creates @octokit/app App instance, exports createGitHubAppService factory |
| `src/github/routes.ts` | Fastify webhook route with raw body | VERIFIED | Encapsulated plugin, raw body parser, HMAC via verifyAndReceive, proper 400/401/500 responses |
| `src/github/webhooks.ts` | Webhook event handler registration | VERIFIED | issues.labeled, issues.opened, issue_comment.created handlers with permission checks and clarification flow |
| `src/github/commands.ts` | Slash command parser and dispatcher | VERIFIED | parseSlashCommand with regex, all 7 commands in VALID_COMMANDS set, buildHelpMessage, buildErrorMessage |
| `src/github/permissions.ts` | Collaborator permission check | VERIFIED | hasWriteAccess checks admin/write via getCollaboratorPermissionLevel, returns false on error |
| `src/github/comments.ts` | Bot comment builder with templates | VERIFIED | buildProgressComment (checklist), buildResultComment (collapsible details), buildClarificationComment, createProgressComment, updateProgressComment |
| `src/github/reactions.ts` | Reaction event handler | VERIFIED | handleReactionEvent maps +1/approve, -1/reject, rocket/trigger. Checks bot comment, write access, findByGithubCommentId. Note: arrows_counterclockwise is not a valid GitHub reaction -- documented and handled via slash command instead. |
| `src/github/checks.ts` | Check run lifecycle | VERIFIED | createCheckRun, updateCheckRun, completeCheckRun, buildCheckSummary -- all substantive with proper API calls |
| `src/github/pr-description.ts` | PR description builder | VERIFIED | buildPRDescription with linked issue, changes, validation, cost table, footer. updatePRDescription calls pulls.update |
| `src/config/schema.ts` | GitHubAppConfigSchema in ConfigSchema | VERIFIED | GitHubAppConfigSchema zod object with app_id, private_key_path, webhook_secret, optional installation_id. Added as optional to ConfigSchema. |
| `src/storage/schema.ts` | githubCommentId column | VERIFIED | integer("github_comment_id") on runs table |
| `src/storage/repositories/runs.ts` | findByGithubCommentId, setGithubCommentId | VERIFIED | Both methods implemented with proper Drizzle queries |
| `drizzle/0004_github_app_comment_id.sql` | DB migration | VERIFIED | ALTER TABLE runs ADD github_comment_id integer |
| `src/daemon/server.ts` | GitHub App init and route registration | PARTIAL | createGitHubAppService and registerGitHubRoutes are called. registerWebhookHandlers wired. But onDispatch and onCommand callbacks are log-only stubs. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| routes.ts | app.ts | verifyAndReceive | WIRED | Line 44: `appService.app.webhooks.verifyAndReceive({...})` |
| config/schema.ts | types.ts | github_app zod schema | WIRED | GitHubAppConfigSchema defined in schema.ts, used as optional field |
| webhooks.ts | commands.ts | parseSlashCommand | WIRED | Line 117: `parseSlashCommand(comment.body)` |
| webhooks.ts | permissions.ts | hasWriteAccess | WIRED | Line 146: `hasWriteAccess(octokit, owner, repo, sender)` |
| webhooks.ts | durability/pause.ts | resumeRun | WIRED | Imported in webhooks deps, called at line 127 via `deps.resumeRun()` |
| reactions.ts | governance/approval.ts | approveRun/rejectRun | WIRED | Line 175: `approveRun(deps.runRepo, run.id)`, Line 177: `rejectRun(deps.runRepo, run.id)` |
| reactions.ts | runs.ts | findByGithubCommentId | WIRED | Line 162: `deps.runRepo.findByGithubCommentId(comment!.id)` |
| checks.ts | octokit checks API | checks.create/update | WIRED | Lines 38, 69, 84: proper API calls |
| pr-description.ts | octokit pulls API | pulls.update | WIRED | Line 88: `octokit.rest.pulls.update({...})` |
| daemon/server.ts | github/app.ts | createGitHubAppService | WIRED | Line 150: factory call with config |
| daemon/server.ts | github/routes.ts | registerGitHubRoutes | WIRED | Line 182: route registration |
| daemon/server.ts | orchestrator | onDispatch/onCommand | NOT_WIRED | Callbacks log only, do not call orchestrator dispatch or command handling |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| GHAP-01 | 14-01 | GitHub App with webhook receiver, HMAC-SHA256 verification, bot identity | PARTIAL | Webhook receiver and HMAC work. Bot identity via App. But dispatch callback is a stub -- webhooks are received but don't trigger runs. |
| GHAP-02 | 14-02 | Label-based and event-based triggers for dispatching runs | PARTIAL | issues.labeled and issues.opened handlers exist and fire. But onDispatch in daemon only logs. |
| GHAP-03 | 14-03 | Structured bot comments on issues/PRs with run status, results, cost summary | SATISFIED | buildProgressComment, buildResultComment with collapsible details, cost breakdown, validation. createProgressComment/updateProgressComment for edit-in-place. |
| GHAP-04 | 14-02 | Slash commands: /forgectl run, rerun, stop, status, approve, reject, help | PARTIAL | All 7 commands parsed. Permission checked. But onCommand in daemon only logs -- commands don't execute. |
| GHAP-05 | 14-02 | Permission checks: only repo collaborators can issue commands | SATISFIED | hasWriteAccess checks collaborator permission level. Used in webhooks.ts and reactions.ts. Non-collaborators get -1 reaction + error or silent ignore. |
| GHAP-06 | 14-04 | Conversational clarification: agent asks question mid-run, pauses, resumes on reply | SATISFIED | buildClarificationComment creates @-mention with question. webhooks.ts detects reply to waiting run, calls resumeRun. 4 clarification tests pass. |
| GHAP-07 | 14-03 | Reactions as approvals (thumbs-up=approve, thumbs-down=reject, rocket=trigger, arrows=rerun) | SATISFIED | +1/approve, -1/reject, rocket/trigger all mapped. arrows_counterclockwise is not a valid GitHub reaction -- documented, rerun handled via slash command instead. This is a correct design decision. |
| GHAP-08 | 14-04 | Check runs on PRs (pending -> in_progress -> success/failure) | SATISFIED | createCheckRun (in_progress), updateCheckRun, completeCheckRun (success/failure with output). buildCheckSummary for detailed markdown. |
| GHAP-09 | 14-04 | Auto-generated PR descriptions with changes, validation, cost, linked issue | SATISFIED | buildPRDescription includes Closes #N, changes list, validation results, cost table, agent/workflow info, forgectl footer. updatePRDescription wired to pulls.update API. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/daemon/server.ts | 159-164 | onDispatch logs but does not dispatch | Blocker | Webhook triggers have no effect -- runs are never started from GitHub events |
| src/daemon/server.ts | 166-168 | onCommand logs but does not execute | Blocker | Slash commands are recognized but have no effect -- no run/stop/status/approve/reject/help |
| src/github/reactions.ts | 68 | arrows_counterclockwise comment | Info | Not a bug -- documents valid design decision that GitHub doesn't support this emoji as a reaction |

### Human Verification Required

### 1. Webhook Signature Verification End-to-End

**Test:** Configure a real GitHub App, send a webhook, verify it is accepted
**Expected:** Valid webhook returns 200, tampered payload returns 401
**Why human:** Requires real GitHub App credentials and ngrok/tunnel setup

### 2. Bot Comment Rendering

**Test:** Trigger a run and inspect the GitHub comment formatting
**Expected:** Collapsible details sections render correctly, checklist items display properly
**Why human:** Markdown rendering depends on GitHub's parser, can't verify programmatically

### 3. Clarification Flow End-to-End

**Test:** Agent posts clarification, user replies, run resumes
**Expected:** Full pause/resume cycle completes without errors
**Why human:** Requires running agent, real GitHub webhooks, and timing verification

### Gaps Summary

Two related gaps stem from the same root cause: **the daemon's webhook handler callbacks are log-only stubs**. All the infrastructure is in place -- webhook verification, command parsing, permission checks, event routing, approval governance, check runs, PR descriptions -- but the final connection between "GitHub event received" and "forgectl takes action" is missing in `src/daemon/server.ts`.

Specifically:
1. **onDispatch** (line 159-164): Logs the event but never calls `orchestrator.dispatch()` or equivalent
2. **onCommand** (line 166-168): Logs the command but never routes to orchestrator operations, approval service, or help/status replies

This means a user can set up the GitHub App, webhooks will be received and verified, commands will be parsed and permission-checked, but nothing will actually happen. The bot won't start runs, won't stop them, won't reply with status or help, and won't process approve/reject commands (though reaction-based approve/reject via reactions.ts works independently because it calls approveRun/rejectRun directly).

The fix is localized to one file (server.ts) and involves routing the parsed commands and dispatch events to the existing orchestrator and governance services.

---

_Verified: 2026-03-10T06:50:00Z_
_Verifier: Claude (gsd-verifier)_
