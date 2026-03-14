---
phase: 29-wire-subissuecache-composition
plan: "01"
subsystem: orchestrator
tags: [sub-issues, composition, wiring, orchestrator, scheduler, daemon]
dependency_graph:
  requires: [phase-25-sub-issue-dag, phase-28-sub-issue-advanced]
  provides: [SUBISSUE-03, SUBISSUE-04, SUBISSUE-05, SUBISSUE-06]
  affects: [orchestrator, scheduler, daemon, webhooks]
tech_stack:
  added: []
  patterns: [optional-injection, composition-threading]
key_files:
  created:
    - test/unit/wiring-orchestrator-subissuecache.test.ts
  modified:
    - src/orchestrator/index.ts
    - src/orchestrator/scheduler.ts
    - src/daemon/server.ts
decisions:
  - "SubIssueCache instantiated once in server.ts and shared between Orchestrator and registerWebhookHandlers — single source of truth for cache invalidation"
  - "subIssueCache added as optional field throughout (backward compat) — Notion adapter users and non-GitHub setups unaffected"
  - "Scheduler tick passes undefined for githubContext and deps.subIssueCache for cache — position 10/11 matches dispatcher signature"
metrics:
  duration: 254s
  completed_date: "2026-03-14"
  tasks_completed: 2
  files_modified: 4
---

# Phase 29 Plan 01: Wire SubIssueCache Through Composition Layer Summary

**One-liner:** Threaded SubIssueCache from server.ts through OrchestratorOptions, TickDeps, and dispatcher args so sub-issue runtime features (rollup, auto-close, webhook invalidation) execute at runtime.

## What Was Built

All sub-issue logic from phases 25 and 28 was dead code at runtime because SubIssueCache was never wired into the production composition layer. This plan fixes that with four targeted changes:

1. **`src/orchestrator/index.ts`** — Added `subIssueCache?: SubIssueCache` to `OrchestratorOptions` and `Orchestrator` class; threaded it into `TickDeps` in `start()` and as the 11th arg to `dispatchIssueImpl` in `dispatchIssue()`

2. **`src/orchestrator/scheduler.ts`** — Fixed the `dispatchIssue` call in `tick()` to pass `undefined` as `githubContext` (position 10) and `deps.subIssueCache` as position 11 — activating `triggerParentRollup` and `handleSynthesizerOutcome` at runtime

3. **`src/daemon/server.ts`** — Added `SubIssueCache` import, instantiated one `SubIssueCache` instance inside the orchestrator block, passed it to both `new Orchestrator({...})` and `registerWebhookHandlers` deps — enabling webhook-driven cache invalidation

4. **`test/unit/wiring-orchestrator-subissuecache.test.ts`** — Four composition tests verifying the wiring: cache reaches `startScheduler`, cache reaches `dispatchIssueImpl`, backward compat (undefined when not provided), scheduler deps include cache

## Decisions Made

- SubIssueCache instantiated once in server.ts and shared between Orchestrator and registerWebhookHandlers — single source of truth for cache invalidation
- subIssueCache added as optional field throughout (backward compat) — Notion adapter users and non-GitHub setups unaffected
- Scheduler tick passes undefined for githubContext and deps.subIssueCache for cache — position 10/11 matches dispatcher signature

## Verification

- 4 composition tests: all pass
- Full suite: 1158 tests pass, 99 test files pass (2 skipped, pre-existing)
- TypeScript typecheck: zero errors
- ESLint: pre-existing missing eslint.config.js (noted in tech debt, not introduced here)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

Checking created/modified files exist and commits are present...

## Self-Check: PASSED

- test/unit/wiring-orchestrator-subissuecache.test.ts: FOUND
- src/orchestrator/index.ts: FOUND
- src/orchestrator/scheduler.ts: FOUND
- src/daemon/server.ts: FOUND
- Commit ba42890 (test RED phase): FOUND
- Commit e6eab9f (feat GREEN phase): FOUND
