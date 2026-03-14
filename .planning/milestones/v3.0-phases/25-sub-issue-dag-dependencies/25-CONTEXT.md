# Phase 25: Sub-Issue DAG Dependencies - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

The orchestrator reads GitHub sub-issue hierarchy and dispatches work in dependency order automatically. Parent issues follow a three-phase lifecycle: planner → children execute → synthesizer. This phase covers fetching, caching, cycle detection, and the parent lifecycle state machine. Progress rollup and auto-close are Phase 28.

</domain>

<decisions>
## Implementation Decisions

### Parent Lifecycle (Three-Phase Pattern)
- Parent dispatches FIRST as planner — scopes work, creates/links sub-issues
- Children execute next in dependency order (bottom-up among siblings)
- Parent re-dispatches LAST as synthesizer — merges results, closes
- Parent goes through dispatch loop twice: once before children exist, once after all children reach terminal state
- Label-driven mode detection: parent gets `forge:synthesize` label when children complete, triggering different prompt template
- Synthesizer receives summary-only child context (final status comment + branch name per child, not full diffs)
- If any child fails, synthesizer still runs with partial results — it decides how to handle gaps

### Sub-Issue Auto-Discovery
- Sub-issues found during fetch are automatically added as candidates even without trigger label
- forgectl discovers work from hierarchy, not just labels
- Bidirectional: if a sub-issue is a candidate, also fetch its parent and wire the dependency
- Full depth supported (up to 8 levels of GitHub nesting)

### Cache & Rate Limits
- Long TTL (5 minutes) for sub-issue cache — rate-limit friendly
- Webhook + TTL invalidation: GitHub App webhook for issue events invalidates cache immediately, TTL as fallback
- Graceful degradation: if rate limit low, skip sub-issue fetch and serve stale cache with warning log
- Works without GitHub App configured (TTL-only fallback)

### Cycle Detection
- All cycle sources validated: sub-issue hierarchy, cross-source (sub-issues + labels), and cross-issue manual deps (blocked-by in body/labels)
- Claude's Discretion: cycle action (comment + skip vs comment + break) and check frequency (per-tick vs on-cache-refresh)

### Claude's Discretion
- Sub-issue fetch timing strategy (lazy vs per-tick vs on-dispatch) — pick based on rate limit math
- Cycle detection frequency and resolution strategy
- GitHub internal ID storage approach in TrackerIssue metadata
- `terminalIssueIds` population strategy in scheduler

</decisions>

<specifics>
## Specific Ideas

- Three-phase parent lifecycle: "Parent runs first to validate scope, decide decomposition, and create/link child issues. Children run next in dependency order. Parent runs again last as a reducer/synthesizer/closer once children are done."
- Label `forge:synthesize` marks the transition from planner to synthesizer mode
- SyntheticIssue (from v2.1) stays for non-coding tasks; GitHub sub-issues are for real code work dependencies

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `filterCandidates()` at `src/orchestrator/dispatcher.ts:83`: Already checks `blocked_by` against `terminalIssueIds` — just need to populate both
- `pipeline/dag.ts`: Has DFS cycle detection, topological sort, parallel groups — reusable for issue DAG validation
- `githubFetch()` at `src/tracker/github.ts:131`: Authenticated fetch with rate limit tracking, retry, ETag support
- `fetchAllPages()`: Pagination helper already handles Link headers

### Established Patterns
- `normalizeIssue()` at `src/tracker/github.ts:54`: Conversion point — currently hardcodes `blocked_by: []` and discards `ghIssue.id`
- Factory registry pattern for stateful adapters (private ETag, cache, rate limit state)
- GitHub App webhook handlers at `src/github/webhooks.ts` — existing event registration pattern

### Integration Points
- `normalizeIssue()` — add `ghIssue.id` to metadata, populate `blocked_by` from sub-issue fetch
- `fetchCandidateIssues()` — enrich with sub-issue data after initial fetch
- `tick()` in `src/orchestrator/scheduler.ts` — needs `terminalIssueIds` populated from tracker state
- `src/github/webhooks.ts` — register sub-issue-related events for cache invalidation
- Dispatcher state machine — needs "parent waiting for children" state for three-phase lifecycle

</code_context>

<deferred>
## Deferred Ideas

- GraphQL batch query for sub-issues (reduce API pressure) — future optimization
- GitHub blocked-by/blocking REST API (no documented endpoints) — defer to v3.1
- Sub-issue creation from pipeline definitions (two-way sync) — out of scope

</deferred>

---

*Phase: 25-sub-issue-dag-dependencies*
*Context gathered: 2026-03-13*
