# Phase 9: Fix GitHub Adapter ID/Identifier Mismatch - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix the cross-phase wiring bug where the orchestrator passes `issue.id` (GitHub internal numeric ID) to tracker mutation methods, but the GitHub adapter expects the `identifier` ("#N" format) for `parseIssueNumber`. This causes 404s on all mutation API calls (postComment, updateState, updateLabels). Also fix `fetchIssueStatesByIds` which has the same bug pattern via the reconciler.

</domain>

<decisions>
## Implementation Decisions

### Fix Strategy
- Change `id: String(ghIssue.id)` to `id: String(ghIssue.number)` in `normalizeIssue` — simplest fix, aligns with how all callers use `id`
- `parseIssueNumber` should accept both formats ("42" and "#42") — defensive, works regardless of whether callers pass id or identifier
- Drop the original GitHub internal ID entirely — no code references it, YAGNI
- `fetchIssueStatesByIds` gets fixed for free by the id-to-number change

### ID Field Semantics
- `id` across all adapters = **API-addressable value** passed to mutation methods (GitHub: issue number, Notion: page UUID)
- `identifier` = **human-readable display format** (GitHub: "#42", Notion: short UUID prefix)
- Add JSDoc to `TrackerIssue` interface codifying this contract
- Add JSDoc comments to both GitHub and Notion adapter normalizeIssue functions for consistency
- Verify `identifier` is used consistently in all display paths (logs, comments, dashboard) — not just fix mutations

### Test Coverage
- Update existing `test/unit/` GitHub adapter tests to verify `id` is issue number, not internal ID
- Cross-phase integration test: mocked TrackerAdapter verifying dispatcher passes correct `issue.id` to mutation methods
- Automated E2E test in `test/e2e/` that mocks GitHub API but runs real dispatcher flow (skippable with FORGECTL_SKIP_DOCKER=true)
- Update all test files creating mock TrackerIssue objects to use number-based `id` (e.g., "42") matching the new contract

### Claude's Discretion
- Whether to add a specific regression test for the reconciler -> fetchIssueStatesByIds path
- Internal refactoring of parseIssueNumber if needed
- E2E test infrastructure details (mock server setup, test fixtures)

</decisions>

<code_context>
## Existing Code Insights

### Bug Location
- `src/tracker/github.ts:62` — `id: String(ghIssue.id)` should be `id: String(ghIssue.number)`
- `src/tracker/github.ts:90-92` — `parseIssueNumber` strips `#` prefix, needs to handle plain numbers too

### Callers Passing `issue.id` to Mutations
- `src/orchestrator/dispatcher.ts:129` — `updateLabels(issue.id, ...)` (in_progress label)
- `src/orchestrator/dispatcher.ts:207` — `postComment(issue.id, ...)` (result comment)
- `src/orchestrator/dispatcher.ts:227` — `updateState(issue.id, "closed")` (auto-close)
- `src/orchestrator/dispatcher.ts:235` — `updateLabels(issue.id, ...)` (done label)
- `src/orchestrator/dispatcher.ts:264-265` — `postComment(issue.id, ...)` (max retries comment)
- `src/orchestrator/dispatcher.ts:272` — `updateLabels(issue.id, ...)` (remove in_progress on exhaustion)
- `src/orchestrator/index.ts:142` — `updateLabels(id, ...)` (shutdown label cleanup)

### Reconciler Path
- `src/orchestrator/reconciler.ts:38` — `fetchIssueStatesByIds(runningIds)` where runningIds are `issue.id` values

### Notion Adapter (Already Correct)
- `src/tracker/notion.ts` — uses `id: pageId` (full UUID) which IS the API-addressable value

### Established Patterns
- Closure-based adapter pattern with private state (ETag, cache, rate limits)
- Fire-and-forget `.catch()` pattern for best-effort mutations in dispatcher
- `vi.fn()` mocking pattern for TrackerAdapter in existing tests

### Integration Points
- TrackerIssue interface (`src/tracker/types.ts`) — needs JSDoc update
- All test fixtures creating TrackerIssue mocks — need id value updates

</code_context>

<specifics>
## Specific Ideas

No specific requirements — the fix approach is well-defined by the roadmap and discussion.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-fix-github-id-identifier-mismatch*
*Context gathered: 2026-03-08*
