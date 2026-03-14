---
phase: 30-fix-subissuecache-singleton-polling-context
plan: "01"
subsystem: orchestrator
tags: [bugfix, wiring, sub-issues, polling, github-context]
dependency_graph:
  requires: []
  provides: [SubIssueCache singleton, githubContext polling wiring]
  affects: [src/tracker/github.ts, src/daemon/server.ts, src/orchestrator/scheduler.ts, src/orchestrator/index.ts]
tech_stack:
  added: []
  patterns: [optional-injection, live-mutation-deps, singleton-factory-param]
key_files:
  created:
    - test/unit/wiring-orchestrator-subissuecache.test.ts (extended with 4 new tests)
  modified:
    - src/tracker/github.ts
    - src/daemon/server.ts
    - src/orchestrator/scheduler.ts
    - src/orchestrator/index.ts
decisions:
  - "createGitHubAdapter accepts optional externalCache param — backward compat preserved, no-param callers auto-create"
  - "setGitHubContext mutates this.deps.githubContext in-place — same live-mutation pattern as applyConfig"
  - "server.ts instantiates SubIssueCache before tracker — guarantees single instance across adapter and orchestrator"
  - "githubContext gated by installation_id presence in server.ts — no crash if GitHub App configured without installation_id"
metrics:
  duration_seconds: 246
  completed_date: "2026-03-14"
  tasks_completed: 2
  files_modified: 5
---

# Phase 30 Plan 01: Fix SubIssueCache Singleton and polling githubContext wiring Summary

Fixed two wiring bugs: unified SubIssueCache to a single shared instance between GitHub adapter and orchestrator, and wired githubContext into the scheduler polling path so triggerParentRollup fires for polling-dispatched issues.

## What Was Built

### Bug 1: Dual SubIssueCache instances
**Before:** `createGitHubAdapter()` always created its own private `SubIssueCache`. `server.ts` created a separate instance and passed it to `Orchestrator`. Writes during `fetchCandidateIssues` (in adapter's Instance A) were invisible to the scheduler's `terminalIds` logic (reading from orchestrator's Instance B).

**After:** `createGitHubAdapter(config, externalCache?)` accepts an optional external cache. `server.ts` creates one `SubIssueCache` before tracker creation, passes it to both `createGitHubAdapter` and `new Orchestrator({..., subIssueCache})`. Single shared instance.

### Bug 2: undefined githubContext in scheduler ticks
**Before:** Scheduler line 94 hardcoded `undefined` at position 10 (githubContext), so `triggerParentRollup` guard (`subIssueCache && githubContext`) always failed for polling-dispatched issues.

**After:** `TickDeps` gains a `githubContext?: GitHubContext` field. Scheduler passes `deps.githubContext` to `dispatchIssue`. `Orchestrator.setGitHubContext(ctx)` stores context and mutates `this.deps.githubContext` for live scheduler updates. `server.ts` calls `orchestrator.setGitHubContext()` after GitHub App initialization.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Unify SubIssueCache singleton and wire githubContext into polling path | 13f079f | src/tracker/github.ts, src/daemon/server.ts, src/orchestrator/scheduler.ts, src/orchestrator/index.ts |
| 2 | Add wiring tests for githubContext in TickDeps and cache singleton | d193133 | test/unit/wiring-orchestrator-subissuecache.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test 6 called dispatchIssue without passing context**
- **Found during:** Task 2 TDD GREEN phase
- **Issue:** Test 6 called `orchestrator.dispatchIssue(issue)` (no explicit context), expecting `args[9]` to be the stored `this.githubContext`. But the Orchestrator.dispatchIssue signature takes an explicit `githubContext` parameter (webhook path) — stored context is only for scheduler ticks via `deps.githubContext`.
- **Fix:** Updated test to call `orchestrator.dispatchIssue(issue, ctx)` with explicit ctx — correctly testing the webhook dispatch path.
- **Files modified:** test/unit/wiring-orchestrator-subissuecache.test.ts

**2. [Rule 2 - Type Safety] installation_id can be undefined**
- **Found during:** Task 1 TypeScript compilation
- **Issue:** `ghAppService.getInstallationOctokit(config.github_app.installation_id)` — `installation_id` is `z.number().optional()`, TypeScript error TS2345.
- **Fix:** Added `config.github_app.installation_id` guard to the condition so `setGitHubContext` call is skipped when no installation_id is configured.
- **Files modified:** src/daemon/server.ts

## Verification

- TypeScript: `npx tsc --noEmit` — zero errors
- Targeted tests: 8/8 passed (4 existing + 4 new)
- Full suite: 1162 tests passed, 8 skipped, 0 failures
- Grep: `externalCache` in github.ts, `deps.githubContext` in scheduler.ts, `setGitHubContext` in index.ts and server.ts — all confirmed

## Self-Check: PASSED
