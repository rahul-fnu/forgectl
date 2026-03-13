# Phase 28: Sub-Issue Advanced Features - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Parent issues receive live progress updates as their sub-issues complete, and close automatically when all children finish. This phase adds progress rollup comments and auto-close on top of the sub-issue DAG infrastructure built in Phase 25. Does NOT add new sub-issue discovery, caching, or cycle detection — those are complete.

</domain>

<decisions>
## Implementation Decisions

### Progress Comment Format
- Markdown checklist format — each child is a line with `[x]`/`[ ]`, status emoji, and issue link
- Show child issue titles (fetched from tracker) alongside issue numbers for readability
- Issue link only — no branch/PR info on parent comment (that lives on the child issue)
- Failed children show red X with error summary: `❌ #42 Auth adapter — Failed: validation timeout`
- Footer line shows aggregate: `**Progress: 2/4 complete**`

### Auto-Close Behavior
- Parent closes AFTER synthesizer completes successfully — not when last child closes
- Synthesizer always runs even with partial failures — it receives context about which children failed and why
- If synthesizer fails, parent stays open with an error comment explaining the failure
- Summary comment posted on parent when closing (but see comment update strategy — it's an edit to the progress comment, not a new comment)

### Comment Update Strategy
- Edit-in-place using hidden HTML marker: `<!-- forgectl:progress:parent-{issueNumber} -->`
- Search existing comments for marker on each update — no database storage of comment IDs needed
- If marker comment not found (deleted by user), create a fresh one — self-healing
- Progress comment first posted on first child completion (not on dispatch — avoids empty 0/N comment)
- Final summary (all children done, synthesizer result) is an UPDATE to the progress comment, not a separate comment — avoids comment spam per success criteria

### Trigger Mechanism
- Worker completion callback triggers progress rollup — immediate, no polling, natural completion point
- After rollup update, worker checks if all children are now terminal
- If all terminal: worker adds `forge:synthesize` label to parent — scheduler picks up on next tick
- `forge:synthesize` label is hardcoded (not configurable) — internal mechanism, consistent with `forge:` prefix convention
- Rollup errors (API rate limit, comment update failure) are warned and swallowed — never block the worker. Matches existing check run error pattern.

### Claude's Discretion
- Exact status emoji set for different states (completed, in-progress, blocked, failed)
- Progress comment markdown formatting details
- How synthesizer context (child summaries) is structured in the re-dispatch prompt
- Whether to include duration per child in the progress checklist

</decisions>

<specifics>
## Specific Ideas

- Progress comment should feel like a GitHub Actions summary — checklist with clear pass/fail per item
- One comment total on the parent issue for the entire lifecycle (created, updated in-place, finalized at close)
- Worker signals completion, scheduler dispatches synthesizer — clean separation of concerns

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildProgressComment()` / `updateProgressComment()` in `src/github/comments.ts`: Edit-in-place pattern with comment ID — adapt for marker-based lookup
- `SubIssueCache.getAllEntries()` in `src/tracker/sub-issue-cache.ts`: Already stores `childStates` (Map of childId → GitHub state) — data source for rollup
- `filterCandidates()` in `src/orchestrator/dispatcher.ts:86`: Already checks `blocked_by` against `terminalIssueIds` — dependency aware

### Established Patterns
- Check run / PR description errors caught as warnings, never crash worker — same pattern for rollup errors
- `forge:` label prefix convention for internal labels (e.g., `forge:synthesize`)
- `OctokitLike` interface in comments.ts for GitHub API abstraction — reuse for comment search + edit
- `buildResultComment()` in `src/github/comments.ts`: Template for structured markdown output

### Integration Points
- `src/orchestrator/worker.ts`: Worker completion handler — add rollup callback after run finishes
- `src/tracker/sub-issue-cache.ts`: SubIssueEntry already has `childStates` — check terminal state here
- `src/orchestrator/dispatcher.ts`: Auto-close logic at line 362 — extend for synthesizer-gated close
- `src/github/webhooks.ts`: Existing event registration — could add label event for `forge:synthesize` if needed

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 28-sub-issue-advanced-features*
*Context gathered: 2026-03-13*
