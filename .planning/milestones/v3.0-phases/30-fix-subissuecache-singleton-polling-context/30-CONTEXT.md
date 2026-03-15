# Phase 30: Fix SubIssueCache Singleton + Polling githubContext - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Eliminate dual SubIssueCache instances and provide githubContext in the polling path so progress rollup and auto-close fire for all dispatched issues — not just webhook-triggered ones. This is a gap-closure phase fixing two wiring bugs identified in the post-Phase-29 milestone audit.

</domain>

<decisions>
## Implementation Decisions

### Dual SubIssueCache (SUBISSUE-03)
- server.ts:117 creates Instance B (passed to orchestrator/webhooks)
- github.ts:139 creates Instance A inside createGitHubAdapter() closure
- Writes go to Instance A during fetchCandidateIssues; reads come from Instance B (always empty)
- Fix: single instance shared between adapter and orchestrator — adapter must use the externally-provided cache, not create its own

### Missing githubContext in Polling Path (SUBISSUE-05, SUBISSUE-06)
- scheduler.ts:94 passes undefined as githubContext (position 10) to dispatchIssue
- triggerParentRollup guard at dispatcher.ts:437 requires both subIssueCache AND githubContext
- Fix: scheduler must receive and forward githubContext so rollup fires for polling-dispatched issues (the primary production path)

### Behavioral Decisions (Locked from Prior Phases)
- Phase 25: SubIssueCache with 5-minute TTL, webhook + TTL invalidation, lazy expiry on read
- Phase 25: Optional injection pattern — backward compat preserved for Notion/non-GitHub setups
- Phase 28: Edit-in-place rollup comments with hidden HTML marker
- Phase 28: Rollup errors swallowed as warnings, never crash worker
- Phase 28: Synthesizer-gated auto-close — parent closes after synthesizer, not when last child closes
- Phase 29: SubIssueCache instantiated in server.ts, shared with orchestrator and webhooks

### Claude's Discretion
- Whether adapter accepts cache via constructor param, factory function param, or setter injection
- How scheduler obtains githubContext (constructor injection vs tick deps)
- Integration test design and scope

</decisions>

<specifics>
## Specific Ideas

No specific requirements — this is a pure wiring fix. The behavioral surface is fully defined by Phases 25, 28, and 29.

</specifics>

<code_context>
## Existing Code Insights

### Root Causes
- `src/tracker/github.ts:139`: `const subIssueCache = new SubIssueCache()` — creates private instance inside adapter closure
- `src/tracker/github.ts:117`: `createGitHubAdapter()` return type already includes `subIssueCache` property, but server.ts ignores it and creates its own
- `src/orchestrator/scheduler.ts:94`: Passes `undefined` as githubContext to `dispatchIssue()`

### Integration Points
- `src/daemon/server.ts:91-123`: Cache creation and wiring to orchestrator + webhooks
- `src/tracker/github.ts:117-139`: Adapter factory creates private cache
- `src/orchestrator/scheduler.ts:94`: dispatchIssue call missing githubContext
- `src/orchestrator/dispatcher.ts:437`: Guard requiring both subIssueCache AND githubContext
- `src/orchestrator/index.ts:32,50,66,98,245`: Orchestrator receives and forwards subIssueCache

### Test Files
- `test/unit/wiring-orchestrator-subissuecache.test.ts`: Existing wiring tests
- `test/unit/wiring-sub-issue-rollup.test.ts`: Rollup wiring tests
- `test/unit/tracker-sub-issue-cache.test.ts`: Cache unit tests
- `test/unit/orchestrator-scheduler.test.ts`: Scheduler tests

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 30-fix-subissuecache-singleton-polling-context*
*Context gathered: 2026-03-14*
