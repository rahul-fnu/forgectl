# Phase 28: Sub-Issue Advanced Features - Research

**Researched:** 2026-03-13
**Domain:** GitHub Issues API — comment management, label operations, orchestrator worker completion callbacks
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Progress Comment Format**
- Markdown checklist format — each child is a line with `[x]`/`[ ]`, status emoji, and issue link
- Show child issue titles (fetched from tracker) alongside issue numbers for readability
- Issue link only — no branch/PR info on parent comment (that lives on the child issue)
- Failed children show red X with error summary: `❌ #42 Auth adapter — Failed: validation timeout`
- Footer line shows aggregate: `**Progress: 2/4 complete**`

**Auto-Close Behavior**
- Parent closes AFTER synthesizer completes successfully — not when last child closes
- Synthesizer always runs even with partial failures — receives context about which children failed and why
- If synthesizer fails, parent stays open with an error comment explaining the failure
- Summary comment posted on parent when closing (edit to progress comment, not a new comment)

**Comment Update Strategy**
- Edit-in-place using hidden HTML marker: `<!-- forgectl:progress:parent-{issueNumber} -->`
- Search existing comments for marker on each update — no database storage of comment IDs needed
- If marker comment not found (deleted by user), create a fresh one — self-healing
- Progress comment first posted on first child completion (not on dispatch)
- Final summary (all children done, synthesizer result) is an UPDATE to the progress comment

**Trigger Mechanism**
- Worker completion callback triggers progress rollup — immediate, no polling
- After rollup update, worker checks if all children are now terminal
- If all terminal: worker adds `forge:synthesize` label to parent — scheduler picks up on next tick
- `forge:synthesize` label is hardcoded (not configurable)
- Rollup errors (API rate limit, comment update failure) are warned and swallowed — never block the worker

### Claude's Discretion
- Exact status emoji set for different states (completed, in-progress, blocked, failed)
- Progress comment markdown formatting details
- How synthesizer context (child summaries) is structured in the re-dispatch prompt
- Whether to include duration per child in the progress checklist

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUBISSUE-05 | Post progress rollup comments on parent issues as sub-issues complete | Covered by: marker-based comment search API, `buildSubIssueProgressComment()` builder, worker completion callback hook, `OctokitLike` extension |
| SUBISSUE-06 | Auto-close parent issue when all sub-issues reach terminal state | Covered by: `forge:synthesize` label trigger, synthesizer dispatch via scheduler, `tracker.updateState()` close path, synthesizer-gated close logic |
</phase_requirements>

---

## Summary

Phase 28 adds two closely-related behaviors to the existing sub-issue DAG infrastructure from Phase 25: (1) progress rollup comments on parent issues as children complete, and (2) auto-close of the parent when all children reach terminal state via a synthesizer agent. Both behaviors hang off the worker completion callback in `src/orchestrator/dispatcher.ts::executeWorkerAndHandle()`.

The key design challenge is marker-based comment search: instead of persisting comment IDs in a database, we embed a hidden HTML comment `<!-- forgectl:progress:parent-{issueNumber} -->` in the progress comment body and use `octokit.rest.issues.listComments()` to find it on each update. This is self-healing (user can delete the comment and a fresh one will be created), eliminates a storage dependency, and matches the project's zero-new-npm-dependencies constraint.

The auto-close path requires extending `OctokitLike` to expose `issues.addLabels` and `issues.update` (for close), and extending `WebhookDeps.onDispatch` to handle the `forge:synthesize` label trigger for the synthesizer run. The synthesizer receives a structured prompt describing which children succeeded and which failed, then the parent is closed only after it completes successfully.

**Primary recommendation:** Implement as two new modules — `src/github/sub-issue-rollup.ts` (comment building + marker search) and a thin rollup callback integrated into `executeWorkerAndHandle()` — keeping all error-swallowing consistent with the existing check run / PR description pattern.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@octokit/app` | ^16.1.2 | GitHub App API calls (already in project) | Project standard — all GitHub API calls go through Octokit |
| `@octokit/rest` | ^22.0.1 | REST API types (already in project) | Project standard |

### GitHub REST API Endpoints Required
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` | list | Find marker comment by scanning body |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | create | Create initial progress comment |
| `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` | update | Edit progress comment in-place |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/labels` | addLabels | Add `forge:synthesize` to parent |
| `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | update | Close parent issue (state: "closed") |

No new npm packages required — zero-new-dependencies constraint is satisfied.

**Installation:**
```bash
# No new packages — all functionality is in existing @octokit/app and @octokit/rest
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── github/
│   ├── sub-issue-rollup.ts    # NEW: marker search, comment builder, rollup functions
│   └── comments.ts            # EXTEND: add listComments to OctokitLike interface
├── orchestrator/
│   └── dispatcher.ts          # EXTEND: rollup callback after executeWorker() returns
test/unit/
├── github-sub-issue-rollup.test.ts   # NEW
└── wiring-sub-issue-rollup.test.ts   # NEW (integration wiring test)
```

### Pattern 1: Marker-Based Comment Search
**What:** Scan issue comments for a hidden HTML marker to find the rollup comment ID without database storage.
**When to use:** Any time a rollup comment needs to be created or updated.

```typescript
// src/github/sub-issue-rollup.ts
const ROLLUP_MARKER_PREFIX = "<!-- forgectl:progress:parent-";

export function buildRollupMarker(parentIssueNumber: number): string {
  return `${ROLLUP_MARKER_PREFIX}${parentIssueNumber} -->`;
}

/**
 * Search comments on parentIssueNumber for the rollup marker.
 * Returns the comment ID if found, null if not found.
 * Paginates through all comments.
 */
export async function findRollupCommentId(
  octokit: RollupOctokitLike,
  owner: string,
  repo: string,
  parentIssueNumber: number,
): Promise<number | null> {
  const marker = buildRollupMarker(parentIssueNumber);
  let page = 1;
  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: parentIssueNumber,
      per_page: 100,
      page,
    });
    for (const comment of comments) {
      if (comment.body?.includes(marker)) {
        return comment.id;
      }
    }
    if (comments.length < 100) break;
    page++;
  }
  return null;
}
```

**Source:** GitHub REST API docs — `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`

### Pattern 2: Upsert Rollup Comment
**What:** Find-then-create-or-update (upsert) the rollup comment on parent.
**When to use:** Each time a child completes. First call creates, subsequent calls update.

```typescript
export async function upsertRollupComment(
  octokit: RollupOctokitLike,
  owner: string,
  repo: string,
  parentIssueNumber: number,
  body: string,
): Promise<void> {
  const existingId = await findRollupCommentId(octokit, owner, repo, parentIssueNumber);
  if (existingId !== null) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: parentIssueNumber,
      body,
    });
  }
}
```

### Pattern 3: Rollup Comment Body Builder
**What:** Build a markdown checklist with status emojis and aggregate footer.
**When to use:** On each rollup update.

Emoji set recommendation (Claude's discretion):
- `✅` — completed successfully
- `⏳` — in progress (running)
- `⬜` — not started (open, not yet dispatched)
- `❌` — failed
- `🚫` — blocked (has unresolved blockers)

```typescript
export interface ChildStatus {
  id: string;          // issue number string, e.g. "42"
  title: string;       // issue title
  url: string;         // issue URL for linking
  state: "completed" | "in_progress" | "pending" | "failed" | "blocked";
  errorSummary?: string; // for failed children
}

export function buildSubIssueProgressComment(
  parentIssueNumber: number,
  children: ChildStatus[],
): string {
  const marker = buildRollupMarker(parentIssueNumber);
  const lines: string[] = [marker, ""];
  lines.push("## Sub-Issue Progress");
  lines.push("");

  const emojiMap: Record<ChildStatus["state"], string> = {
    completed: "✅",
    in_progress: "⏳",
    pending: "⬜",
    failed: "❌",
    blocked: "🚫",
  };

  for (const child of children) {
    const emoji = emojiMap[child.state];
    const checked = child.state === "completed" ? "x" : " ";
    let line = `- [${checked}] ${emoji} [#${child.id} ${child.title}](${child.url})`;
    if (child.state === "failed" && child.errorSummary) {
      line += ` — Failed: ${child.errorSummary}`;
    }
    lines.push(line);
  }

  const completed = children.filter((c) => c.state === "completed").length;
  const total = children.length;
  lines.push("");
  lines.push(`**Progress: ${completed}/${total} complete**`);
  lines.push("");
  lines.push("_Updated by [forgectl](https://github.com/forgectl/forgectl)_");

  return lines.join("\n");
}
```

### Pattern 4: All-Terminal Check
**What:** Determine if all children of a parent are in terminal states.
**When to use:** After posting the rollup comment, to decide whether to add `forge:synthesize`.

```typescript
/**
 * Returns true if every childState value is a terminal state.
 */
export function allChildrenTerminal(
  childStates: Map<string, string>,
  terminalStates: Set<string>,
): boolean {
  if (childStates.size === 0) return false; // No children — don't auto-synthesize
  for (const state of childStates.values()) {
    if (!terminalStates.has(state)) return false;
  }
  return true;
}
```

### Pattern 5: Synthesizer Trigger via Label
**What:** Add `forge:synthesize` label to parent issue after all children are terminal.
**When to use:** Inside the worker rollup callback, after confirming all children terminal.

```typescript
// In dispatcher.ts, after rollup update succeeds:
if (allChildrenTerminal(entry.childStates, terminalStates)) {
  tracker.updateLabels(parentId, ["forge:synthesize"], []).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("dispatcher", `Failed to add forge:synthesize label to parent #${parentId}: ${msg}`);
  });
}
```

Scheduler picks up the parent on next tick since `forge:synthesize` is just a label — it routes to a synthesizer prompt template that receives child completion context.

### Pattern 6: Synthesizer Prompt Context
**What:** Structure the prompt for the synthesizer agent that runs on the parent issue.
**When to use:** When building the prompt for a parent issue dispatched with `forge:synthesize` label.

Claude's discretion on exact format, but should include:
- Which children succeeded (with branch/PR links if available)
- Which children failed and why
- High-level synthesis goal (from parent issue description)

### Anti-Patterns to Avoid
- **Storing comment IDs in SQLite:** Adds storage dependency, breaks if DB is wiped. Use marker search instead.
- **Polling for completion:** Worker completion callback is the right trigger — immediate, no polling.
- **Throwing on rollup errors:** Rollup errors must be warned and swallowed — never propagate. Match check run / PR description error pattern exactly.
- **Auto-closing before synthesizer completes:** Parent must stay open until synthesizer agent finishes successfully.
- **Empty parent case:** `allChildrenTerminal` returns `false` for empty `childStates` — avoid trigger on childless parents.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Comment ID persistence | SQLite comment_id column | Marker search via `listComments` | Zero storage dependency, self-healing, matches project constraint |
| Terminal state detection | Custom polling loop | `SubIssueCache.childStates` + `allChildrenTerminal()` | Cache already populated by Phase 25 infrastructure |
| Synthesizer dispatch | New scheduler loop | `tracker.updateLabels(parentId, ["forge:synthesize"], [])` | Existing scheduler's next tick handles it — no new machinery |
| Parent issue close | Direct `PATCH` state in rollup | `tracker.updateState(parentId, "closed")` | Uses existing TrackerAdapter interface — portable |

**Key insight:** Phase 25 already built the data layer (SubIssueCache with childStates). Phase 28 is purely event wiring and output formatting — no new data structures needed.

---

## Common Pitfalls

### Pitfall 1: OctokitLike Interface Not Extended
**What goes wrong:** `listComments` is not on the existing `OctokitLike` in `comments.ts` or `GitHubDeps` in `worker.ts`. Calling it will fail TypeScript compilation.
**Why it happens:** Each file defines a minimal `OctokitLike` interface with only the methods it uses. `listComments` hasn't been needed before.
**How to avoid:** Define a new `RollupOctokitLike` interface in `sub-issue-rollup.ts` that adds `issues.listComments`. Cast `githubDeps.octokit` when calling rollup functions.
**Warning signs:** TypeScript error `Property 'listComments' does not exist on type...`

### Pitfall 2: Comment Search Misses Due to Pagination
**What goes wrong:** Issues with many comments (>100) return paginated results. If the rollup comment was posted early and there are >100 newer comments, the first page won't contain it.
**Why it happens:** `listComments` defaults to 30 per_page; rollup marker could be on page 2+.
**How to avoid:** Always paginate with `per_page: 100` and follow pages until fewer than 100 results return. See `findRollupCommentId` pattern above.
**Warning signs:** Duplicate rollup comments accumulating on parent issues.

### Pitfall 3: Race Condition — Two Children Complete Simultaneously
**What goes wrong:** Two children finish nearly simultaneously; both try to create the rollup comment; both find no existing marker; both call `createComment`, creating duplicates.
**Why it happens:** `findRollupCommentId` then `createComment` is not atomic.
**How to avoid:** The worker is fire-and-forget (`void executeWorkerAndHandle(...)`). The rollup callback runs sequentially within each worker's async context. Since two simultaneous workers run as separate promises, a true race is possible. Mitigate with: accept occasional duplicate on very fast multi-completion (rare), OR serialize rollup updates with a per-parent lock (overkill). Recommended: accept the rare duplicate — the upsert pattern handles it on the next update.
**Warning signs:** Two rollup comments on same parent after very fast completion. Monitor in practice.

### Pitfall 4: SubIssueCache Expiry During Long Runs
**What goes wrong:** A long-running child completes >5 minutes after the parent's cache entry was populated. `subIssueCache.get(parentId)` returns null, rollup has no child list to display.
**Why it happens:** TTL is 5 minutes; some runs take longer.
**How to avoid:** Re-fetch sub-issues from API when cache miss in rollup callback, rather than failing silently. Cache the result for the next rollup call.
**Warning signs:** Rollup callback logs "cache miss for parent" repeatedly.

### Pitfall 5: `forge:synthesize` Label Already Present
**What goes wrong:** Adding `forge:synthesize` label twice (e.g., if the rollup callback fires again for some reason) would dispatch the synthesizer a second time.
**Why it happens:** Label add is idempotent at the API level — adding an existing label is a no-op. The scheduler would dispatch again if the label is still present after the first dispatch.
**How to avoid:** The synthesizer run should remove the `forge:synthesize` label as its first action (via `tracker.updateLabels`), or the dispatcher should remove it on dispatch. Check if issue already has `forge:synthesize` in labels before adding.
**Warning signs:** Synthesizer running twice on same parent.

### Pitfall 6: `noUnusedLocals` TypeScript Strictness
**What goes wrong:** Importing and not using something from the new module causes `tsc --noEmit` to fail.
**Why it happens:** `tsconfig` has `noUnusedLocals: true`.
**How to avoid:** Export only what is actually consumed. Don't import for side effects. Review before commit.

---

## Code Examples

Verified patterns from existing codebase:

### Existing: Error-Swallowing Pattern (from worker.ts)
```typescript
// Source: src/orchestrator/worker.ts (lines 306-317)
if (githubDeps) {
  try {
    await updateProgressComment(githubDeps.octokit as any, githubDeps.issueContext, githubDeps.commentId, {
      runId: githubDeps.runId,
      status: "running",
      completedStages: ["agent_executing"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("worker", `Failed to update progress comment (agent stage): ${msg}`);
  }
}
```
All rollup errors must follow this exact pattern — warn + swallow, never rethrow.

### Existing: Label Update Pattern (from dispatcher.ts)
```typescript
// Source: src/orchestrator/dispatcher.ts (lines 371-375)
if (config.tracker?.done_label) {
  tracker.updateLabels(issue.id, [config.tracker.done_label], [orchestratorConfig.in_progress_label]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("dispatcher", `Failed to add done label for ${issue.identifier}: ${msg}`);
  });
}
```
Same pattern for adding `forge:synthesize` — fire-and-forget with `.catch()`.

### Existing: Issue State Update (from dispatcher.ts)
```typescript
// Source: src/orchestrator/dispatcher.ts (lines 363-367)
if (config.tracker?.auto_close) {
  tracker.updateState(issue.id, "closed").catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("dispatcher", `Failed to auto-close ${issue.identifier}: ${msg}`);
  });
}
```
Parent auto-close after synthesizer uses the same `tracker.updateState(parentId, "closed")` pattern.

### Existing: SubIssueCache Entry Access (from sub-issue-cache.ts)
```typescript
// Source: src/tracker/sub-issue-cache.ts — SubIssueEntry interface
export interface SubIssueEntry {
  parentId: string;         // e.g. "42"
  childIds: string[];       // child issue number strings
  childStates: Map<string, string>; // childId -> "open"/"closed"
  fetchedAt: number;        // Date.now()
}
```
Rollup uses `childStates` to determine completed vs remaining. `childIds` gives the ordered list for the checklist.

### New: Extended OctokitLike for Rollup
```typescript
// src/github/sub-issue-rollup.ts
export interface RollupOctokitLike {
  rest: {
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: Array<{ id: number; body?: string }> }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}
```

---

## Integration Point: Where Rollup Callback Plugs In

The rollup callback fires in `executeWorkerAndHandle()` in `src/orchestrator/dispatcher.ts`, after `executeWorker()` returns and before `tracker.postComment()`:

```
executeWorker() returns WorkerResult
  ↓
[NEW] triggerParentRollup(issue, childResult, githubContext, subIssueCache, tracker, logger)
  - Find parent via subIssueCache (issue's id appears as a childId in some entry)
  - Build ChildStatus[] from entry.childStates + child result
  - Upsert rollup comment on parent
  - If allChildrenTerminal: add forge:synthesize label to parent
  ↓
tracker.postComment(issue.id, result.comment)  [existing — comment on the child]
```

**Finding the parent:** The subIssueCache stores `parentId → {childIds, childStates}`. To find a parent from a child's ID, we need either:
1. A reverse index (not currently in SubIssueCache), OR
2. Scan `getAllEntries()` and find the entry where `childIds.includes(childIssueId)`

Option 2 is simpler — `getAllEntries()` returns all non-expired entries, and O(n) scan is fine for expected issue counts (<100 parents). No new data structure needed.

**Updating childStates before allTerminal check:** The current `childStates` in the cache reflects the state at last fetch time (5-min TTL). When a child completes, we should update its state in the cache entry to "closed" before checking all-terminal, otherwise the just-completed child still shows as "open".

```typescript
// Before checking allChildrenTerminal:
const entry = subIssueCache.get(parentId);
if (entry) {
  entry.childStates.set(childIssueId, "closed"); // Update in-place (Map is mutable)
  // entry is the same object reference stored in the cache — mutation propagates
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Comment ID stored in DB | Marker-based comment search | Phase 28 decision | Eliminates storage dependency |
| Polling for parent completion | Worker completion callback | Phase 28 design | Immediate response, no polling overhead |
| New comment per update | Edit-in-place with marker | Phase 28 decision | Prevents comment spam on parent |

---

## Open Questions

1. **Child title fetch for progress comment**
   - What we know: `SubIssueEntry` stores `childIds` and `childStates`, but NOT child titles
   - What's unclear: Do we need to fetch child issue titles from the API on each rollup call?
   - Recommendation: Yes — call `GET /repos/{owner}/{repo}/issues/{number}` for each child to get title and URL. This is 1 API call per child per rollup trigger. Since rollup fires on each child completion, total calls = N children (spread over time). Cache titles in a local Map within the rollup module. If rate-limited, use `#${childId}` as fallback title.

2. **Synthesizer prompt structure (Claude's discretion)**
   - What we know: Synthesizer should receive child success/failure context
   - What's unclear: Exact prompt format
   - Recommendation: Pass a structured summary as part of the issue description or as a prefixed system context: "You are the synthesizer for parent issue #N. The following sub-issues have completed: [list]. Your job is to [parent title/description]."

3. **forge:synthesize label dispatch routing**
   - What we know: Scheduler's `filterCandidates` checks if issue has `done_label`. Synthesizer trigger uses `forge:synthesize`.
   - What's unclear: How the synthesizer label causes a different prompt template vs normal runs
   - Recommendation: Check for `forge:synthesize` label in `dispatchIssue` or in the prompt builder; if present, use a synthesizer-specific template. This is a planner decision — research flags it as needing design.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (project standard) |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/github-sub-issue-rollup.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUBISSUE-05 | `buildSubIssueProgressComment()` renders correct markdown checklist with emojis | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/github-sub-issue-rollup.test.ts` | ❌ Wave 0 |
| SUBISSUE-05 | `findRollupCommentId()` scans comments for marker, returns null when absent | unit | same | ❌ Wave 0 |
| SUBISSUE-05 | `upsertRollupComment()` creates when not found, updates when found | unit | same | ❌ Wave 0 |
| SUBISSUE-05 | Rollup callback fires after child completion and swallows errors | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/wiring-sub-issue-rollup.test.ts` | ❌ Wave 0 |
| SUBISSUE-06 | `allChildrenTerminal()` returns true only when all states are terminal | unit | same | ❌ Wave 0 |
| SUBISSUE-06 | `forge:synthesize` label added when all children terminal | unit | same | ❌ Wave 0 |
| SUBISSUE-06 | Parent closed after synthesizer completes successfully | unit | same | ❌ Wave 0 |
| SUBISSUE-06 | Parent stays open if synthesizer fails; error comment posted | unit | same | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/github-sub-issue-rollup.test.ts test/unit/wiring-sub-issue-rollup.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/github-sub-issue-rollup.test.ts` — unit tests for all exports from `src/github/sub-issue-rollup.ts`
- [ ] `test/unit/wiring-sub-issue-rollup.test.ts` — integration wiring: rollup fires after worker completion, errors swallowed, label added when all terminal

*(No new framework install needed — vitest already configured)*

---

## Sources

### Primary (HIGH confidence)
- Direct source read: `src/github/comments.ts` — existing comment builder and OctokitLike patterns
- Direct source read: `src/tracker/sub-issue-cache.ts` — SubIssueEntry structure with childStates
- Direct source read: `src/orchestrator/dispatcher.ts` — worker completion callback hook point, label/state update patterns
- Direct source read: `src/orchestrator/worker.ts` — error-swallowing pattern for non-critical GitHub API calls
- Direct source read: `src/tracker/github.ts` — fetchSubIssues, pagination, rate limit handling
- Direct source read: `src/orchestrator/scheduler.ts` — TickDeps, terminalIssueIds population from cache
- GitHub REST API (implicit): `issues.listComments` pagination is standard REST with `Link` header — same pattern already used in `parseLinkHeader()` in github.ts

### Secondary (MEDIUM confidence)
- `@octokit/rest` v22 API: `issues.listComments`, `issues.createComment`, `issues.updateComment` — verified as existing endpoints; pagination via `page`/`per_page` params is standard

### Tertiary (LOW confidence)
- Race condition analysis for simultaneous child completion: based on code analysis; actual occurrence rate in production is unknown

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, all existing Octokit endpoints
- Architecture: HIGH — directly derived from existing patterns in codebase
- Pitfalls: HIGH (OctokitLike, pagination, noUnusedLocals) / MEDIUM (race condition — theoretical, not observed)
- Open questions: MEDIUM — child title fetch and synthesizer prompt format need planner decisions

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable GitHub API, no breaking changes expected)
