# Phase 9: Fix GitHub Adapter ID/Identifier Mismatch - Research

**Researched:** 2026-03-08
**Domain:** Bug fix — cross-phase wiring between GitHub tracker adapter and orchestrator
**Confidence:** HIGH

## Summary

This is a well-scoped bug fix phase. The GitHub adapter's `normalizeIssue` function sets `id: String(ghIssue.id)` (GitHub's internal numeric ID, e.g., "123456") but all callers — dispatcher, reconciler, shutdown cleanup — pass `issue.id` to mutation methods (`postComment`, `updateState`, `updateLabels`) which internally call `parseIssueNumber(id)`. `parseIssueNumber` strips a `#` prefix, so it works when called directly with `"#42"` (as the existing tests do) but produces `NaN` when given `"123456"` (the actual runtime value), causing GitHub API 404s on `/repos/{owner}/{repo}/issues/NaN/...`.

The fix is straightforward: change `id: String(ghIssue.id)` to `id: String(ghIssue.number)` and make `parseIssueNumber` defensive to accept both `"42"` and `"#42"`. The Notion adapter already does this correctly (`id: pageId` which IS the API-addressable UUID).

**Primary recommendation:** Change one line in `normalizeIssue`, harden `parseIssueNumber`, add JSDoc to `TrackerIssue` interface, update all test fixtures to use number-based IDs.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Change `id: String(ghIssue.id)` to `id: String(ghIssue.number)` in `normalizeIssue`
- `parseIssueNumber` should accept both formats ("42" and "#42") — defensive
- Drop the original GitHub internal ID entirely — YAGNI
- `fetchIssueStatesByIds` gets fixed for free by the id-to-number change
- `id` across all adapters = API-addressable value; `identifier` = human-readable display format
- Add JSDoc to `TrackerIssue` interface codifying this contract
- Add JSDoc comments to both GitHub and Notion adapter normalizeIssue functions
- Verify `identifier` is used consistently in all display paths
- Update existing GitHub adapter tests to verify `id` is issue number
- Cross-phase integration test: mocked TrackerAdapter verifying dispatcher passes correct `issue.id` to mutation methods
- Automated E2E test in `test/e2e/` that mocks GitHub API but runs real dispatcher flow (skippable with FORGECTL_SKIP_DOCKER=true)
- Update all test files creating mock TrackerIssue objects to use number-based `id` matching new contract

### Claude's Discretion
- Whether to add a specific regression test for the reconciler -> fetchIssueStatesByIds path
- Internal refactoring of parseIssueNumber if needed
- E2E test infrastructure details (mock server setup, test fixtures)

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R1.2 | GitHub Issues Adapter — write back: post comments, add/remove labels, close issues via REST API | Fix ensures `issue.id` (number-based) is the value passed to all mutation methods, making API URLs correct |
| R7.3 | Completion — post comment on GitHub issue with results summary, add labels, close issues | Fix ensures dispatcher's fire-and-forget mutation calls use correct issue number in API URLs |
</phase_requirements>

## Architecture Patterns

### The Bug Chain

```
normalizeIssue() sets:     id = "123456"  (ghIssue.id — internal GitHub ID)
                           identifier = "#42"  (ghIssue.number — display format)

Dispatcher calls:          tracker.updateLabels(issue.id, ...)  → updateLabels("123456", ...)
                           tracker.postComment(issue.id, ...)   → postComment("123456", ...)
                           tracker.updateState(issue.id, ...)   → updateState("123456", ...)

Mutation methods call:     parseIssueNumber("123456")  → parseInt("123456".replace("#",""), 10)  → 123456
                           URL becomes: /repos/owner/repo/issues/123456  → 404 (wrong number!)

Reconciler calls:          tracker.fetchIssueStatesByIds(["123456"])  → parseIssueNumber("123456")  → same 404
```

### The Fix

```
normalizeIssue() sets:     id = "42"  (ghIssue.number — API-addressable)
                           identifier = "#42"  (display format — unchanged)

Dispatcher calls:          tracker.updateLabels("42", ...)  → parseIssueNumber("42")  → 42  → correct URL
Reconciler calls:          tracker.fetchIssueStatesByIds(["42"])  → correct URL
```

### Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `src/tracker/types.ts` | Add JSDoc to `TrackerIssue.id` and `.identifier` fields | ~4-6 lines |
| `src/tracker/github.ts:62` | `id: String(ghIssue.id)` → `id: String(ghIssue.number)` | 1 line |
| `src/tracker/github.ts:90-92` | Harden `parseIssueNumber` to handle both `"42"` and `"#42"` | ~3 lines |
| `src/tracker/github.ts:51` | Add JSDoc to `normalizeIssue` clarifying id=number | ~2 lines |
| `src/tracker/notion.ts` | Add JSDoc to normalizeIssue for consistency | ~2 lines |
| `test/unit/tracker-github.test.ts` | Change `id: "123456"` assertions to `id: "42"` | ~3-5 assertions |
| `test/unit/orchestrator-dispatcher.test.ts` | Update `makeIssue` default `id` to number-based format | trivial |
| `test/unit/orchestrator-reconciler.test.ts` | Update `makeWorkerInfo` default `issueId` | trivial |
| `test/integration/e2e-orchestration.test.ts` | Update `makeIssue` default `id` values | trivial |

### Affected Call Sites (no code change needed — they already pass `issue.id`)

All these callers in dispatcher.ts and orchestrator/index.ts already pass `issue.id` to tracker methods. Once `normalizeIssue` returns the number as `id`, these all work correctly without modification:

- `dispatcher.ts:129` — `updateLabels(issue.id, [in_progress_label], [])`
- `dispatcher.ts:207` — `postComment(issue.id, result.comment)`
- `dispatcher.ts:227` — `updateState(issue.id, "closed")`
- `dispatcher.ts:235` — `updateLabels(issue.id, [done_label], [in_progress_label])`
- `dispatcher.ts:264-265` — `postComment(issue.id, "Max retries...")`
- `dispatcher.ts:272` — `updateLabels(issue.id, [], [in_progress_label])`
- `orchestrator/index.ts:142` — `updateLabels(id, [], [in_progress_label])`
- `reconciler.ts:38` — `fetchIssueStatesByIds(runningIds)` where keys are `issue.id`

### ID Semantics Contract (JSDoc)

```typescript
/**
 * Normalized issue model -- tracker-agnostic representation of a work item.
 */
export interface TrackerIssue {
  /**
   * API-addressable identifier passed to all mutation methods (postComment,
   * updateState, updateLabels). For GitHub: issue number as string ("42").
   * For Notion: page UUID.
   */
  id: string;

  /**
   * Human-readable display identifier used in logs, comments, and UI.
   * For GitHub: "#42". For Notion: short UUID prefix.
   */
  identifier: string;
  // ... rest unchanged
}
```

### parseIssueNumber Hardening

Current implementation:
```typescript
function parseIssueNumber(identifier: string): number {
  return parseInt(identifier.replace("#", ""), 10);
}
```

Fixed implementation (handles both `"42"` and `"#42"`):
```typescript
function parseIssueNumber(idOrIdentifier: string): number {
  const stripped = idOrIdentifier.replace(/^#/, "");
  const num = parseInt(stripped, 10);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid issue number: "${idOrIdentifier}"`);
  }
  return num;
}
```

Key changes:
- Rename parameter from `identifier` to `idOrIdentifier` for clarity
- Use regex `^#` to only strip leading `#` (not embedded ones)
- Add NaN guard with descriptive error (catches future bugs early)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Issue number parsing | Complex ID mapping/lookup | Simple `String(ghIssue.number)` | GitHub API consistently uses issue number in URLs |

## Common Pitfalls

### Pitfall 1: Tests Using "#42" Directly for Mutation Calls
**What goes wrong:** Existing GitHub adapter unit tests call `postComment("#42", ...)` and `updateState("#42", ...)` directly, which works with the current `parseIssueNumber` but doesn't test the actual runtime path where `issue.id` is passed.
**Why it happens:** Tests were written to the adapter API in isolation, not to the orchestrator integration.
**How to avoid:** New cross-phase integration test should verify that when the orchestrator dispatches, the `issue.id` value (from `normalizeIssue`) is what arrives at mutation methods.
**Warning signs:** Tests pass but E2E flow fails with 404s.

### Pitfall 2: Missing Test Fixture Updates
**What goes wrong:** Some test files create mock `TrackerIssue` objects with `id: "issue-1"` or similar non-numeric strings. After the fix, these should use number-like IDs (e.g., `"1"`, `"42"`) to match the new contract.
**Why it happens:** Mock IDs were arbitrary strings since no code path validated them end-to-end.
**How to avoid:** Grep all test files for `TrackerIssue` mock creation and update `id` fields.
**Warning signs:** Tests pass with arbitrary IDs but don't catch real integration issues.

### Pitfall 3: E2E Test Missing `metadata` Field
**What goes wrong:** The `makeIssue` helper in `test/integration/e2e-orchestration.test.ts` (line 36-51) does NOT include a `metadata` field, but `TrackerIssue` has `metadata: Record<string, unknown>`. Some code paths may access it.
**How to avoid:** Ensure all mock issue factories include `metadata: {}`.
**Warning signs:** TypeScript strict mode catches this if types are properly applied.

### Pitfall 4: Reconciler Uses issueId as Map Key
**What goes wrong:** The reconciler uses `state.running.keys()` (which are `issue.id` values) and passes them to `fetchIssueStatesByIds`. The returned map must use the same keys. After the fix, IDs are `"42"` format, and `fetchIssueStatesByIds` correctly preserves the input key in `stateMap.set(id, data.state)`.
**Why it happens:** The fix is transparent here — `fetchIssueStatesByIds` already uses the input `id` as the map key.
**How to avoid:** Verify the reconciler test creates workers with IDs matching the state map keys.

## Test Architecture

### Existing Test Files to Modify

| File | Tests | Changes Needed |
|------|-------|----------------|
| `test/unit/tracker-github.test.ts` | 15 tests | Change `id: "123456"` assertions to `id: "42"`, verify parseIssueNumber handles both formats |
| `test/unit/orchestrator-dispatcher.test.ts` | 16 tests | Optionally update `makeIssue` default `id` to `"42"` for realism |
| `test/unit/orchestrator-reconciler.test.ts` | 10 tests | Optionally update `makeWorkerInfo` default `issueId` to `"42"` |
| `test/integration/e2e-orchestration.test.ts` | ~15 tests | Optionally update `makeIssue` default IDs |

### New Test Files

| File | Purpose | Type |
|------|---------|------|
| `test/unit/tracker-github.test.ts` (additions) | Verify `id` is number-based, parseIssueNumber handles both formats | Unit |
| `test/integration/cross-phase-id.test.ts` (new) | Verify dispatcher passes correct `issue.id` to tracker mutations end-to-end | Integration |

### Cross-Phase Integration Test Pattern

```typescript
// test/integration/cross-phase-id.test.ts
// 1. Create GitHub adapter with mocked fetch
// 2. Mock fetch to return issues with known id/number
// 3. Call fetchCandidateIssues to get normalized issues
// 4. Verify issue.id is the number, not the internal ID
// 5. Call postComment(issue.id, ...) and verify the URL uses the number
// OR
// 1. Create mock TrackerAdapter recording all calls
// 2. Create real dispatcher state
// 3. Dispatch an issue with id="42", identifier="#42"
// 4. Verify tracker.updateLabels was called with "42" (not "#42" or "123456")
// 5. Let worker complete, verify postComment called with "42"
// 6. Verify updateState called with "42" (if auto_close)
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest) |
| Config file | `vitest.config.ts` |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest --run` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npx vitest --run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R1.2 | normalizeIssue sets id to issue number | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Exists, needs update |
| R1.2 | parseIssueNumber handles "42" and "#42" | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Wave 0 (new tests) |
| R1.2 | Mutation methods work with number-based id | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Exists, passes trivially |
| R7.3 | Dispatcher passes correct issue.id to tracker | integration | `npx vitest --run test/integration/cross-phase-id.test.ts` | Wave 0 (new file) |
| R7.3 | Reconciler fetchIssueStatesByIds uses correct ids | unit/integration | `npx vitest --run test/unit/orchestrator-reconciler.test.ts` | Exists, optionally update |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest --run`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npx vitest --run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/tracker-github.test.ts` — new tests for parseIssueNumber with "42" format and NaN guard
- [ ] `test/integration/cross-phase-id.test.ts` — new file covering dispatcher -> tracker mutation ID correctness

## Scope Summary

### Source Changes (3 files)
1. **`src/tracker/types.ts`** — JSDoc on `id` and `identifier` fields
2. **`src/tracker/github.ts`** — Fix `normalizeIssue` id, harden `parseIssueNumber`, add JSDoc
3. **`src/tracker/notion.ts`** — Add JSDoc to normalizeIssue for consistency

### Test Changes (4-5 files)
1. **`test/unit/tracker-github.test.ts`** — Update id assertions, add parseIssueNumber tests
2. **`test/unit/orchestrator-dispatcher.test.ts`** — Update mock IDs for realism
3. **`test/unit/orchestrator-reconciler.test.ts`** — Update mock IDs for realism
4. **`test/integration/e2e-orchestration.test.ts`** — Update mock IDs for realism
5. **`test/integration/cross-phase-id.test.ts`** — New cross-phase integration test

### Total Estimated Scope
- ~15 lines of production code changes
- ~50-80 lines of test updates
- ~80-120 lines of new integration test

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `src/tracker/github.ts` — confirmed bug at line 62
- Direct code inspection of `src/orchestrator/dispatcher.ts` — confirmed all call sites pass `issue.id`
- Direct code inspection of `src/orchestrator/reconciler.ts` — confirmed `fetchIssueStatesByIds` receives `issue.id` values
- Direct code inspection of `src/tracker/notion.ts` — confirmed correct pattern (`id: pageId`)
- Direct code inspection of all test files — confirmed exact assertions needing update

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, pure bug fix
- Architecture: HIGH — single-line production fix with clear causality chain
- Pitfalls: HIGH — all code paths inspected, test fixtures enumerated

**Research date:** 2026-03-08
**Valid until:** indefinite (bug fix, not ecosystem-dependent)
