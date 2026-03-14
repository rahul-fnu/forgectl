---
phase: 30-fix-subissuecache-singleton-polling-context
verified: 2026-03-14T04:22:00Z
status: passed
score: 4/4 must-haves verified
re_verification: false
---

# Phase 30: Fix SubIssueCache Singleton and Polling githubContext Wiring — Verification Report

**Phase Goal:** Fix two wiring bugs that prevent sub-issue rollup and auto-close from firing for polling-originated issues
**Verified:** 2026-03-14T04:22:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SubIssueCache writes during fetchCandidateIssues are readable by scheduler ticks (single shared instance) | VERIFIED | `server.ts:96` creates one `SubIssueCache`, passes it to both `createGitHubAdapter(config.tracker, subIssueCache)` at line 99 and `new Orchestrator({..., subIssueCache})` at line 126 |
| 2 | Polling-dispatched issues have a truthy githubContext so triggerParentRollup executes | VERIFIED | `TickDeps` has `githubContext?: GitHubContext` field (scheduler.ts:33); scheduler passes `deps.githubContext` to `dispatchIssue` at line 97; `setGitHubContext()` mutates `this.deps.githubContext` in-place (index.ts:278-281); `server.ts:212-221` calls `orchestrator.setGitHubContext()` after GitHub App init |
| 3 | Progress rollup comments and auto-close fire for polling-originated issues, not just webhook-triggered ones | VERIFIED | Guard at `dispatcher.ts:437` — `if (subIssueCache && githubContext)` — can now pass for polling path because both deps are wired through TickDeps; confirmed by 8/8 wiring tests all passing |
| 4 | Non-GitHub adapters (Notion) continue to work without subIssueCache or githubContext | VERIFIED | `server.ts:98-100` only calls `createGitHubAdapter` when `config.tracker.kind === "github"`; Notion path uses `createTrackerAdapter` without cache; `TickDeps.subIssueCache` and `TickDeps.githubContext` are both optional fields |

**Score:** 4/4 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/tracker/github.ts` | createGitHubAdapter accepts optional external SubIssueCache | VERIFIED | Line 117: `export function createGitHubAdapter(config: TrackerConfig, externalCache?: SubIssueCache)`. Line 139: `const subIssueCache = externalCache ?? new SubIssueCache()` — fallback preserved |
| `src/daemon/server.ts` | Single cache injected into adapter, setGitHubContext called after GitHub App init | VERIFIED | Lines 96-99: cache created before tracker, passed to `createGitHubAdapter`. Lines 211-221: `orchestrator.setGitHubContext()` called inside GitHub App block with `installation_id` guard |
| `src/orchestrator/scheduler.ts` | TickDeps.githubContext field, passed to dispatchIssue | VERIFIED | Lines 32-33: `githubContext?: GitHubContext` in TickDeps interface. Line 97: `dispatchIssue(..., deps.githubContext, deps.subIssueCache)` — undefined no longer hardcoded |
| `src/orchestrator/index.ts` | setGitHubContext method, githubContext in TickDeps | VERIFIED | Line 51: `private githubContext?: GitHubContext`. Line 100: `githubContext: this.githubContext` in deps object. Lines 278-281: `setGitHubContext()` method mutates both `this.githubContext` and `this.deps.githubContext` |
| `test/unit/wiring-orchestrator-subissuecache.test.ts` | Tests verifying githubContext wiring and cache singleton | VERIFIED | 8 tests total (4 original + 4 new). New describe block "GitHubContext wiring for polling rollup (SUBISSUE-05, SUBISSUE-06)" contains Tests 5-8. All 8/8 pass |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/daemon/server.ts` | `src/tracker/github.ts` | `createGitHubAdapter(config.tracker, subIssueCache)` | WIRED | server.ts:99 calls `createGitHubAdapter(config.tracker, subIssueCache)` — pattern confirmed |
| `src/daemon/server.ts` | `src/orchestrator/index.ts` | `orchestrator.setGitHubContext()` | WIRED | server.ts:216 calls `orchestrator.setGitHubContext(...)` inside GitHub App block |
| `src/orchestrator/index.ts` | `src/orchestrator/scheduler.ts` | `githubContext in this.deps (TickDeps)` | WIRED | index.ts:100 includes `githubContext: this.githubContext` in deps; `setGitHubContext` mutates `this.deps.githubContext` in-place at line 280 |
| `src/orchestrator/scheduler.ts` | `src/orchestrator/dispatcher.ts` | `deps.githubContext passed to dispatchIssue position 10` | WIRED | scheduler.ts:97 — `deps.githubContext` is argument 10 (0-indexed 9), verified by Test 6: `args[9]` equals ctx |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SUBISSUE-03 | 30-01-PLAN.md | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | SATISFIED | Single SubIssueCache instance shared between GitHub adapter (writes during `fetchCandidateIssues`) and orchestrator/scheduler (reads in TickDeps). Scheduler.ts:70-80 builds `terminalIds` from `deps.subIssueCache.getAllEntries()` |
| SUBISSUE-05 | 30-01-PLAN.md | Post progress rollup comments on parent issues as sub-issues complete | SATISFIED | `triggerParentRollup` guard at dispatcher.ts:437 now receives non-undefined `githubContext` for polling-dispatched issues via the scheduler TickDeps wiring chain |
| SUBISSUE-06 | 30-01-PLAN.md | Auto-close parent issue when all sub-issues reach terminal state | SATISFIED | Same guard at dispatcher.ts:437 covers both rollup and auto-close — both fire for polling-originated issues with the fixed wiring |

All three requirement IDs from PLAN frontmatter (`SUBISSUE-03`, `SUBISSUE-05`, `SUBISSUE-06`) are accounted for. REQUIREMENTS.md traceability table confirms all three are mapped to Phase 30 with status "Complete".

No orphaned requirements found — no additional IDs assigned to Phase 30 in REQUIREMENTS.md beyond those declared in the plan.

---

### Anti-Patterns Found

No anti-patterns detected in the modified files.

- No TODO/FIXME/placeholder comments in changed code
- No empty implementations (all function bodies are substantive)
- No stub return values (`return {}`, `return []`, `return null`)
- The `installation_id` guard in server.ts (`config.github_app.installation_id`) is intentional defensive code documented in the plan, not a stub

---

### Human Verification Required

None. All aspects of this phase are verifiable programmatically:

- TypeScript compilation: zero errors (`tsc --noEmit` passes)
- Unit test coverage: 8/8 tests pass in wiring-orchestrator-subissuecache.test.ts, including 4 new tests for the githubContext path
- Full suite: 1162 tests pass, 8 skipped, 0 failures — no regressions
- Key patterns verified via source inspection: `externalCache` in github.ts, `deps.githubContext` in scheduler.ts, `setGitHubContext` in both index.ts and server.ts

---

### Summary

Phase 30 fully achieves its goal. Both wiring bugs are fixed:

**Bug 1 (dual SubIssueCache):** `createGitHubAdapter` now accepts an optional external cache parameter (`externalCache?: SubIssueCache`). `server.ts` creates a single `SubIssueCache` before tracker construction and passes it to both the GitHub adapter and `Orchestrator`. Writes during `fetchCandidateIssues` and reads from scheduler ticks now operate on the same instance.

**Bug 2 (undefined githubContext in polling path):** `TickDeps` gains a `githubContext?: GitHubContext` field. The scheduler passes `deps.githubContext` (not `undefined`) to `dispatchIssue`. `Orchestrator.setGitHubContext()` stores the context and mutates `this.deps.githubContext` in-place (same live-mutation pattern as `applyConfig`). `server.ts` calls `setGitHubContext` after GitHub App initialization, gated on `installation_id` presence to avoid crashes on partial configs.

The `triggerParentRollup` guard at `dispatcher.ts:437` (`if (subIssueCache && githubContext)`) now evaluates to true for polling-dispatched issues, enabling progress rollup comments (SUBISSUE-05) and auto-close (SUBISSUE-06) on the primary production path.

Non-GitHub adapters (Notion) are unaffected — both new fields are optional throughout the dependency chain.

---

_Verified: 2026-03-14T04:22:00Z_
_Verifier: Claude (gsd-verifier)_
