---
phase: 25-sub-issue-dag-dependencies
verified: 2026-03-13T07:12:07Z
status: passed
score: 14/14 must-haves verified
---

# Phase 25: Sub-Issue DAG Dependencies Verification Report

**Phase Goal:** The orchestrator reads GitHub sub-issue hierarchy and dispatches work in dependency order automatically
**Verified:** 2026-03-13T07:12:07Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | SubIssueCache stores and retrieves sub-issue entries with TTL expiry | VERIFIED | `sub-issue-cache.ts` implements lazy TTL check on `get()` and `getAllEntries()`; 15 tests pass including fake-timer TTL tests |
| 2  | SubIssueCache invalidates entries by parent ID and globally | VERIFIED | `invalidate()` and `invalidateAll()` implemented and tested |
| 3  | SubIssueCache reports all entries for terminal ID population | VERIFIED | `getAllEntries()` filters expired entries, used by scheduler at each tick |
| 4  | Cycle detection identifies A->B->A cycles in issue dependency graphs | VERIFIED | Standalone DFS in `sub-issue-dag.ts`; tests cover simple, long, and self-referencing cycles |
| 5  | Cycle detection passes valid acyclic graphs without error | VERIFIED | Returns `null` for empty graph, linear chains, diamond dependencies |
| 6  | Cycle detection handles cross-source dependencies (ignores external refs) | VERIFIED | `blocked_by` IDs not in input set are silently filtered before DFS |
| 7  | normalizeIssue stores ghInternalId in metadata for every GitHub issue | VERIFIED | Line 65 `github.ts`: `ghInternalId: ghIssue.id` always set; test "stores ghInternalId in metadata" passes |
| 8  | fetchCandidateIssues enriches issues with blocked_by from sub-issue cache | VERIFIED | Two-pass enrichment: cache hit path and fetch path both populate `blocked_by` |
| 9  | Sub-issues discovered during fetch are added as candidates automatically | VERIFIED | Auto-discovery loop at lines 357-401 `github.ts`; dedicated test passes |
| 10 | Parent with no sub-issues dispatches immediately (empty blocked_by) | VERIFIED | When `subIssues` param is absent or empty, `blocked_by: []` |
| 11 | Parent with non-terminal children is blocked (populated blocked_by) | VERIFIED | `filterCandidates` receives populated `blocked_by`; `terminalIds` set controls unblocking |
| 12 | Scheduler tick populates terminalIssueIds from SubIssueCache before calling filterCandidates | VERIFIED | Lines 67-79 `scheduler.ts`; 4 scheduler tests for cache integration all pass |
| 13 | Webhook cache invalidation clears sub-issue cache entry on issues.edited | VERIFIED | Lines 113-117 `webhooks.ts`; `subIssueCache.invalidate(String(payload.issue.number))` |
| 14 | Cycle detection runs on enriched candidates and logs warning on cycle | VERIFIED | Lines 412-415 `github.ts`: `detectIssueCycles()` called on full enriched set; cycle logged via `console.warn` |

**Score:** 14/14 truths verified

---

## Required Artifacts

### Plan 01 Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/tracker/sub-issue-cache.ts` | TTL cache for sub-issue relationships | VERIFIED | 87 lines; exports `SubIssueCache` class and `SubIssueEntry` interface; full implementation with lazy expiry |
| `src/tracker/sub-issue-dag.ts` | Issue-specific cycle detection adapter | VERIFIED | 93 lines; exports `detectIssueCycles` and `IssueDAGNode`; standalone DFS (not validateDAG) |
| `test/unit/tracker-sub-issue-cache.test.ts` | Unit tests for SubIssueCache | VERIFIED | 179 lines, 15 tests; covers all methods with fake timer TTL tests |
| `test/unit/tracker-sub-issue-dag.test.ts` | Unit tests for issue cycle detection | VERIFIED | 106 lines, 11 tests; covers empty, acyclic, cycles, diamond, external refs |

### Plan 02 Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/tracker/github.ts` | Sub-issue enrichment; ghInternalId in normalizeIssue | VERIFIED | 529 lines; imports both Plan 01 modules; `ghInternalId` at line 65; enrichment loop at lines 303-428 |
| `src/orchestrator/scheduler.ts` | terminalIssueIds populated from SubIssueCache | VERIFIED | `subIssueCache?: SubIssueCache` in `TickDeps` at line 30; terminal ID build loop at lines 67-77 |
| `src/github/webhooks.ts` | Cache invalidation on issue events | VERIFIED | `subIssueCache?: SubIssueCache` in `WebhookDeps` at line 32; `issues.edited` handler at lines 113-117 |

---

## Key Link Verification

### Plan 01 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/tracker/sub-issue-dag.ts` | `src/pipeline/dag.ts` | imports validateDAG | NOT WIRED (intentional) | Plan task body explicitly says "Do NOT use validateDAG()". Standalone DFS implemented instead. Frontmatter key_link was superseded by the task design decision. All 11 cycle detection tests pass confirming the alternative is correct. |

**Note on Plan 01 key link:** The frontmatter `key_links` entry specifying `import.*validateDAG.*pipeline/dag` was overridden by the task body, which explicitly prohibits using `validateDAG()` due to incompatible semantics (unknown-node errors vs. cross-repo references). The `25-01-SUMMARY.md` documents this as a deliberate decision. The cycle detection goal is fully achieved by the standalone implementation. This is not a gap.

### Plan 02 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/tracker/github.ts` | `src/tracker/sub-issue-cache.ts` | `new SubIssueCache` in adapter closure | VERIFIED | Line 3 import, line 139 instantiation |
| `src/tracker/github.ts` | `src/tracker/sub-issue-dag.ts` | `detectIssueCycles` in fetchCandidateIssues | VERIFIED | Line 4 import, line 412 call on full enriched candidate set |
| `src/orchestrator/scheduler.ts` | `src/tracker/sub-issue-cache.ts` | `TickDeps.subIssueCache?.getAllEntries()` builds terminalIds | VERIFIED | Line 10 import, lines 70-76 iteration |
| `src/github/webhooks.ts` | `src/tracker/sub-issue-cache.ts` | `WebhookDeps.subIssueCache?.invalidate()` on issues.edited | VERIFIED | Line 7 import, line 115 invalidation call |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SUBISSUE-01 | 25-01, 25-02 | Fetch GitHub sub-issues via REST API and populate `blocked_by` on TrackerIssue | SATISFIED | `fetchCandidateIssues` calls `/sub_issues` endpoint; `normalizeIssue(ghIssue, subIssues)` populates `blocked_by`; 6 tests in `tracker-github.test.ts` |
| SUBISSUE-02 | 25-01, 25-02 | Store GitHub internal resource ID in TrackerIssue metadata | SATISFIED | `normalizeIssue` always sets `metadata.ghInternalId = ghIssue.id` (line 65); test at line 524 `tracker-github.test.ts` |
| SUBISSUE-03 | 25-02 | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | SATISFIED | `tick()` builds `terminalIds` from `SubIssueCache.getAllEntries()` before calling `filterCandidates`; 4 tests in `orchestrator-scheduler.test.ts` |
| SUBISSUE-04 | 25-01, 25-02 | Detect and report DAG cycles from sub-issue hierarchy and manual blocked_by | SATISFIED | Standalone DFS in `sub-issue-dag.ts`; called in `fetchCandidateIssues` after enrichment; 11 cycle detection tests |

**Orphaned requirements check:** REQUIREMENTS.md maps SUBISSUE-05 and SUBISSUE-06 to Phase 28 (not Phase 25). No orphaned requirements for this phase.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/github/webhooks.ts` | 199 | `TODO: Wire handleReactionEvent...` | Info | Pre-existing v2.0 tech debt (introduced in commit 5c95db9, docs(18-01)). Not introduced by phase 25. No impact on phase goal. |

No blockers or warnings found in phase 25 files.

---

## Human Verification Required

### 1. End-to-end sub-issue dispatch ordering

**Test:** Configure a real GitHub repo with a parent issue (e.g., #10) having two open sub-issues (#11, #12). Label the parent with the trigger label. Start the orchestrator with `subIssueCache` wired into `TickDeps`. Verify parent is not dispatched while sub-issues are open. Close sub-issue #11, wait one TTL cycle. Verify parent is still blocked (one child open). Close #12. Verify parent is dispatched on next tick.
**Expected:** Parent dispatches only after ALL sub-issues reach terminal state.
**Why human:** Requires live GitHub API, real webhook delivery, and live scheduler loop. Cannot be verified programmatically without Docker + GitHub App.

### 2. Cycle detection comment posting

**Test:** Create a circular dependency (#10 blocked_by #11, #11 blocked_by #10). Label both. Start orchestrator.
**Expected:** Warning logged; neither issue dispatched; no infinite loop.
**Why human:** Cycle comment posting to GitHub requires live API. The code currently only `console.warn`s (not `postComment`) — this may be acceptable per plan design, but a human should confirm the UX matches intent.

---

## Gaps Summary

No gaps. All 14 observable truths verified, all 4 requirements satisfied, TypeScript compiles cleanly, 1,060 tests pass (0 regressions).

The Plan 01 frontmatter key link specifying `validateDAG` import is superseded by the task body's explicit design decision to use a standalone DFS. The standalone implementation is correct and fully tested.

---

_Verified: 2026-03-13T07:12:07Z_
_Verifier: Claude (gsd-verifier)_
