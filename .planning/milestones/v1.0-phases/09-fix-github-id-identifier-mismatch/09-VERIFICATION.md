---
phase: 09-fix-github-id-identifier-mismatch
verified: 2026-03-09T02:10:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 9: Fix GitHub Adapter ID/Identifier Mismatch Verification Report

**Phase Goal:** Fix the cross-phase wiring bug where the orchestrator passes `issue.id` (GitHub internal numeric ID) to tracker methods, but the GitHub adapter expects the `identifier` ("#N" format), causing 404s on all mutation API calls.
**Verified:** 2026-03-09T02:10:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | normalizeIssue returns ghIssue.number (not ghIssue.id) as the TrackerIssue.id field | VERIFIED | `src/tracker/github.ts:65` — `id: String(ghIssue.number)`. No remaining `String(ghIssue.id)` in production code (grep confirms). Unit test at `tracker-github.test.ts:397-410` explicitly verifies `id: "7"` when `ghIssue.id=999999, ghIssue.number=7`. |
| 2 | parseIssueNumber accepts both '42' and '#42' formats and throws on invalid input | VERIFIED | `src/tracker/github.ts:94-101` — uses `replace(/^#/, "")`, `parseInt`, and `Number.isNaN` guard with `throw`. Tests at `tracker-github.test.ts:369-393` verify plain "42" works and "not-a-number" throws. |
| 3 | Dispatcher mutation calls (postComment, updateState, updateLabels) receive the issue number as id | VERIFIED | `test/integration/cross-phase-id.test.ts:124-194` — four tests verify `updateLabels("42",...)`, `postComment("42",...)`, `updateState("42","closed")`, and done-label `updateLabels("42",["done"],["in-progress"])` via mocked dispatcher flow. |
| 4 | Reconciler fetchIssueStatesByIds receives issue numbers as ids | VERIFIED | `test/integration/cross-phase-id.test.ts:196-213` — test creates running worker with id "42", calls `reconcile()`, asserts `fetchIssueStatesByIds` was called with `["42"]`. |
| 5 | TrackerIssue.id and .identifier fields have JSDoc documenting their semantics | VERIFIED | `src/tracker/types.ts:5-14` — JSDoc on `id` ("API-addressable identifier... For GitHub: issue number as string ('42')") and `identifier` ("Human-readable display identifier... For GitHub: '#42'"). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/tracker/types.ts` | JSDoc on TrackerIssue.id and .identifier containing "API-addressable" | VERIFIED | Lines 5-14 contain JSDoc with "API-addressable" on `id` and "Human-readable display" on `identifier` |
| `src/tracker/github.ts` | Fixed normalizeIssue containing `ghIssue.number` | VERIFIED | Line 65: `id: String(ghIssue.number)`. Lines 94-101: hardened `parseIssueNumber`. Lines 51-53: JSDoc on normalizeIssue. |
| `src/tracker/notion.ts` | JSDoc on normalizeIssue containing "API-addressable" | VERIFIED | Lines 98-101: JSDoc "id is set to pageId (the API-addressable Notion page UUID)." |
| `test/integration/cross-phase-id.test.ts` | Cross-phase integration test, min 60 lines | VERIFIED | 215 lines. 5 tests covering dispatcher mutations and reconciler ID correctness. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/tracker/github.ts` | `src/tracker/types.ts` | normalizeIssue returns TrackerIssue with number-based id | VERIFIED | Line 65: `id: String(ghIssue.number)` matches pattern `id: String\(ghIssue\.number\)` |
| `test/integration/cross-phase-id.test.ts` | `src/orchestrator/dispatcher.ts` | verifies tracker mutation methods receive correct issue.id | VERIFIED | Lines 129, 149, 170, 191 all assert calls with `"42"`. Imports `dispatchIssue` from dispatcher. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| R1.2 | 09-01-PLAN | GitHub Issues Adapter — write back: post comments, add/remove labels, close issues via REST API | SATISFIED | normalizeIssue now returns `ghIssue.number` as `id`, so all mutation methods construct correct GitHub API URLs (`/repos/{owner}/{repo}/issues/{number}/...`). Verified by unit tests (tracker-github.test.ts) and cross-phase integration test. |
| R7.3 | 09-01-PLAN | Completion — post comment on GitHub issue with results summary, add labels, close issues | SATISFIED | Dispatcher passes correct `issue.id` (number-based) to `postComment`, `updateLabels`, and `updateState`. Cross-phase integration test verifies all three mutation paths with id "42". |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No anti-patterns detected in any modified files |

### Human Verification Required

None. All changes are pure logic fixes (one-line production change + defensive parsing) with comprehensive automated test coverage. No UI, no external service integration, no visual behavior to verify.

### Gaps Summary

No gaps found. All five must-have truths are verified against the actual codebase. The one-line production fix (`id: String(ghIssue.number)`) is confirmed in place, `parseIssueNumber` is hardened with NaN guard, JSDoc documents the contract on both `TrackerIssue` and adapter normalize functions, and cross-phase integration tests prove the dispatcher and reconciler pass correct IDs. Full test suite passes (667 tests, 0 failures). TypeScript compiles with no errors. Both commit hashes (858e4f1, 575bd13) exist in git history.

---

_Verified: 2026-03-09T02:10:00Z_
_Verifier: Claude (gsd-verifier)_
