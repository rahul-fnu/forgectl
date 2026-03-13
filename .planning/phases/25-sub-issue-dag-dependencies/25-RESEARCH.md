# Phase 25: Sub-Issue DAG Dependencies - Research

**Researched:** 2026-03-13
**Domain:** GitHub REST API sub-issues, DAG cycle detection, orchestrator dispatch ordering
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Parent dispatches FIRST as planner — scopes work, creates/links sub-issues
- Children execute next in dependency order (bottom-up among siblings)
- Parent re-dispatches LAST as synthesizer — merges results, closes
- Parent goes through dispatch loop twice: once before children exist, once after all children reach terminal state
- Label-driven mode detection: parent gets `forge:synthesize` label when children complete, triggering different prompt template
- Synthesizer receives summary-only child context (final status comment + branch name per child, not full diffs)
- If any child fails, synthesizer still runs with partial results — it decides how to handle gaps
- Sub-issues found during fetch are automatically added as candidates even without trigger label
- Bidirectional: if a sub-issue is a candidate, also fetch its parent and wire the dependency
- Full depth supported (up to 8 levels of GitHub nesting)
- Long TTL (5 minutes) for sub-issue cache — rate-limit friendly
- Webhook + TTL invalidation: GitHub App webhook for issue events invalidates cache immediately, TTL as fallback
- Graceful degradation: if rate limit low, skip sub-issue fetch and serve stale cache with warning log
- Works without GitHub App configured (TTL-only fallback)
- All cycle sources validated: sub-issue hierarchy, cross-source (sub-issues + labels), and cross-issue manual deps (blocked-by in body/labels)

### Claude's Discretion
- Sub-issue fetch timing strategy (lazy vs per-tick vs on-dispatch) — pick based on rate limit math
- Cycle detection frequency and resolution strategy (comment + skip vs comment + break)
- GitHub internal ID storage approach in TrackerIssue metadata
- `terminalIssueIds` population strategy in scheduler

### Deferred Ideas (OUT OF SCOPE)
- GraphQL batch query for sub-issues (reduce API pressure) — future optimization
- GitHub blocked-by/blocking REST API (no documented endpoints) — defer to v3.1
- Sub-issue creation from pipeline definitions (two-way sync) — out of scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUBISSUE-01 | Fetch GitHub sub-issues via REST API and populate `blocked_by` field on TrackerIssue | GitHub REST `GET /repos/{owner}/{repo}/issues/{number}/sub_issues` returns array of issue objects. `normalizeIssue()` in `src/tracker/github.ts` hardcodes `blocked_by: []` — this is the exact injection point. |
| SUBISSUE-02 | Store GitHub internal resource ID (`id`) in TrackerIssue metadata for write operations | `ghIssue.id` (numeric, e.g. `2564734`) is already present on `GitHubIssue` interface but discarded. `normalizeIssue()` stores `reactions` in metadata — same pattern applies for `ghInternalId`. Needed as `sub_issue_id` parameter when adding sub-issues via POST. |
| SUBISSUE-03 | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | `tick()` in `src/orchestrator/scheduler.ts:64` hardcodes `new Set<string>()` for `terminalIds`. Sub-issue cache service provides live fetch with 5-min TTL. Terminal = issue state is in `config.tracker.terminal_states` (default: `["closed"]`). |
| SUBISSUE-04 | Detect and report DAG cycles created by merging sub-issue hierarchy with manual overrides | `pipeline/dag.ts` has DFS `detectCycle()` operating on `PipelineDefinition` nodes. An issue-specific adapter is needed that converts `Map<string, string[]>` (issue → blockers) into equivalent node list for cycle checking, then posts comment via `tracker.postComment()`. |
</phase_requirements>

---

## Summary

Phase 25 adds sub-issue awareness to the GitHub tracker adapter and orchestrator scheduler. The work is primarily data-plumbing: fetch sub-issue relationships from GitHub's REST API, store them in the `blocked_by` field of `TrackerIssue`, and feed a populated `terminalIssueIds` set to the existing `filterCandidates()` function which already enforces blocking semantics. The existing `pipeline/dag.ts` DFS cycle detector is reusable with a thin adapter layer.

The critical architectural addition is a `SubIssueCache` service (factory-scoped, lives inside the GitHub adapter closure) that manages the 5-minute TTL and webhook invalidation. This cache is queried during `fetchCandidateIssues()` to enrich issues with `blocked_by` entries. The scheduler's `tick()` function must also query this cache to build `terminalIssueIds` from the fetched sub-issue state data.

The parent three-phase lifecycle (planner → children → synthesizer) is implemented by: (a) NOT blocking parent from first dispatch (no blockers initially), (b) blocking parent re-dispatch until all children reach terminal state via `blocked_by` populated from sub-issue fetch, and (c) applying `forge:synthesize` label once all children terminate, triggering a different prompt template on next dispatch.

**Primary recommendation:** Build `SubIssueCache` as a new module `src/tracker/sub-issue-cache.ts`, integrate into `createGitHubAdapter()` via closure, and extend `TickDeps` with an optional `subIssueCache` reference that `tick()` uses to build `terminalIssueIds`.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none new) | - | All features use existing fetch/GitHub API | Zero new npm dependencies constraint from v3.0 planning |

### Existing Modules Used
| Module | Location | Purpose |
|--------|----------|---------|
| `githubFetch()` | `src/tracker/github.ts:131` | Authenticated fetch with rate limit tracking and retry |
| `fetchAllPages()` | `src/tracker/github.ts:198` | Paginated fetch via Link header |
| `normalizeIssue()` | `src/tracker/github.ts:54` | GitHubIssue → TrackerIssue conversion — primary injection point |
| `detectCycle()` / `validateDAG()` | `src/pipeline/dag.ts` | DFS cycle detection, topological sort — reusable with adapter |
| `filterCandidates()` | `src/orchestrator/dispatcher.ts:83` | Already gates on `blocked_by` vs `terminalIssueIds` |
| `tick()` | `src/orchestrator/scheduler.ts:35` | Hardcodes empty `terminalIds` — must be populated |

---

## Architecture Patterns

### Recommended Project Structure (new files)
```
src/
├── tracker/
│   ├── github.ts                # Existing — modify normalizeIssue(), fetchCandidateIssues()
│   ├── sub-issue-cache.ts       # NEW — SubIssueCache class with TTL + invalidation
│   └── sub-issue-dag.ts         # NEW — cycle detection adapter for issue ID graphs
├── orchestrator/
│   └── scheduler.ts             # Modify — populate terminalIssueIds from cache
└── github/
    └── webhooks.ts              # Modify — register issues.edited for cache invalidation
```

### Pattern 1: SubIssueCache as Factory-Scoped Service
**What:** A cache class that stores fetched sub-issue relationships, keyed by parent issue number, with a 5-minute TTL. Lives inside the `createGitHubAdapter()` closure so it shares the same `rateLimitRemaining` state.
**When to use:** Called during `fetchCandidateIssues()` to enrich each candidate with its sub-issue relationships.

```typescript
// src/tracker/sub-issue-cache.ts
export interface SubIssueEntry {
  parentId: string;          // Issue number string ("42")
  childIds: string[];        // Issue number strings of direct children
  childStates: Map<string, string>; // childId -> GitHub state ("open"/"closed")
  fetchedAt: number;         // Date.now()
}

export class SubIssueCache {
  private readonly ttlMs: number;
  private entries = new Map<string, SubIssueEntry>();

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(parentId: string): SubIssueEntry | null {
    const entry = this.entries.get(parentId);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(parentId);
      return null;
    }
    return entry;
  }

  set(entry: SubIssueEntry): void {
    this.entries.set(entry.parentId, entry);
  }

  invalidate(parentId: string): void {
    this.entries.delete(parentId);
  }

  invalidateAll(): void {
    this.entries.clear();
  }
}
```

### Pattern 2: Sub-Issue Fetch in GitHub Adapter
**What:** `fetchSubIssues()` private function inside `createGitHubAdapter()` that calls `GET /repos/{owner}/{repo}/issues/{number}/sub_issues` with pagination.
**When to use:** Called from `fetchCandidateIssues()` for each issue that either has sub-issues already or is a sub-issue of a known parent.

```typescript
// Inside createGitHubAdapter() closure — new private function
async function fetchSubIssues(issueNumber: number): Promise<GitHubIssue[]> {
  const url = `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`;
  const result = await fetchAllPages(url);
  return result ? result.issues : [];
}
```

**GitHub API details:**
- Endpoint: `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`
- Response: Array of standard GitHubIssue objects (same shape as `/issues` endpoint)
- Pagination: Standard Link header, supports `per_page` (default 30, max 100)
- Each sub-issue has `id` (internal numeric), `number` (display), `state` fields
- No preview headers required as of late 2024 — endpoint is GA

**Key distinction (CRITICAL):** The `sub_issue_id` write parameter requires the internal `id` (e.g. `2564734`), NOT the display `number` (e.g. `42`). `normalizeIssue()` must store `ghIssue.id` in `metadata.ghInternalId`.

### Pattern 3: normalizeIssue() Extension
**What:** Two changes to `normalizeIssue()`: (1) capture `ghIssue.id` as `metadata.ghInternalId`, (2) accept optional pre-fetched `subIssues` array to populate `blocked_by`.

```typescript
// src/tracker/github.ts — modified normalizeIssue signature
function normalizeIssue(
  ghIssue: GitHubIssue,
  subIssues?: GitHubIssue[],  // Optional: already fetched children
): TrackerIssue | null {
  if (ghIssue.pull_request) return null;

  const metadata: Record<string, unknown> = {
    ghInternalId: ghIssue.id,  // ADD: store internal ID for write operations
  };
  if (ghIssue.reactions) {
    metadata.reactions = ghIssue.reactions;
  }

  // blocked_by: parent is blocked by its children (children must complete first)
  const blocked_by = subIssues
    ? subIssues
        .filter(s => !s.pull_request)
        .map(s => String(s.number))
    : [];

  return {
    id: String(ghIssue.number),
    // ... rest unchanged
    blocked_by,
    metadata,
  };
}
```

### Pattern 4: Cycle Detection Adapter
**What:** A function that converts a `Map<string, string[]>` (issue number → blocker issue numbers) into the `PipelineDefinition` node shape that `pipeline/dag.ts` expects, then calls `validateDAG()`.

```typescript
// src/tracker/sub-issue-dag.ts
import type { PipelineDefinition } from "../pipeline/types.js";
import { validateDAG } from "../pipeline/dag.ts";

export interface IssueDAGNode {
  id: string;
  blocked_by: string[];
}

export function detectIssueCycles(issues: IssueDAGNode[]): string | null {
  const pipeline: PipelineDefinition = {
    id: "issue-dag",
    nodes: issues.map(issue => ({
      id: issue.id,
      agent: "noop",
      prompt: "",
      depends_on: issue.blocked_by,
    })),
  };
  const result = validateDAG(pipeline);
  if (!result.valid) {
    return result.errors.find(e => e.startsWith("Cycle")) ?? result.errors[0];
  }
  return null;
}
```

### Pattern 5: Scheduler terminalIssueIds Population
**What:** `tick()` in `scheduler.ts` must build `terminalIssueIds` from the sub-issue cache instead of using an empty set. Extend `TickDeps` with an optional `subIssueCache` reference.

```typescript
// src/orchestrator/scheduler.ts — modified tick()
const terminalIds = new Set<string>();

// Populate from sub-issue cache if available
if (deps.subIssueCache) {
  const allEntries = deps.subIssueCache.getAllEntries();
  const terminalStates = new Set(config.tracker?.terminal_states ?? ["closed"]);
  for (const entry of allEntries) {
    for (const [childId, childState] of entry.childStates) {
      if (terminalStates.has(childState)) {
        terminalIds.add(childId);
      }
    }
  }
}

const eligible = filterCandidates(candidates, state, terminalIds, doneLabel);
```

### Pattern 6: Webhook Cache Invalidation
**What:** Register `issues.edited` and `issues.labeled` webhook handlers that call `subIssueCache.invalidate()` when sub-issue-relevant events fire.

```typescript
// src/github/webhooks.ts — new handler in registerWebhookHandlers()
app.webhooks.on("issues.edited", async ({ payload }) => {
  const issueNumber = String(payload.issue.number);
  deps.subIssueCache?.invalidate(issueNumber);
  // Also invalidate parent if known
  if (payload.issue.parent_issue_id) {
    deps.subIssueCache?.invalidate(String(payload.issue.parent_issue_id));
  }
});
```

### Anti-Patterns to Avoid
- **Fetching sub-issues for every issue on every tick:** One extra HTTP call per candidate per tick exhausts rate limits fast. Use the TTL cache — only fetch when cache misses.
- **Storing `blocked_by` as issue numbers from different repos:** `blocked_by` stores IDs matching `TrackerIssue.id` format — always `String(ghIssue.number)`, never `ghIssue.id`.
- **Calling `validateDAG()` directly with raw issue data:** `validateDAG()` requires `PipelineDefinition` shape with `agent` and `prompt` fields. Use the adapter `detectIssueCycles()` wrapper.
- **Blocking parent dispatch on first tick:** Parent should dispatch immediately as planner (no sub-issues exist yet). Only block on second dispatch (after `forge:synthesize` label is applied).
- **Infinite loop in `fetchCandidateIssues()` for bidirectional wiring:** When enriching a sub-issue with its parent context, do not re-fetch the parent's sub-issues recursively. Fetch sub-issues of discovered parents only one level up.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DFS cycle detection | Custom graph traversal | `pipeline/dag.ts` `validateDAG()` + adapter | Already handles multi-cycle, cross-reference, and error message formatting |
| Topological ordering of children | Custom sort | `pipeline/dag.ts` `topologicalSort()` | Handles depth, parallels, Kahn's algorithm already tested |
| Pagination of sub-issue list | Manual loop | `fetchAllPages()` in `github.ts` | Already handles Link header, pagination, ETag |
| Rate-limit-aware fetch | Custom retry/wait | `githubFetch()` in `github.ts` | Has 3-retry with backoff, rate limit header tracking, 5xx retry |

**Key insight:** The dispatcher `filterCandidates()` already implements blocking semantics (`blocked_by` vs `terminalIssueIds`). This phase's job is only to populate those two data sources correctly — not to change the dispatch mechanism.

---

## Common Pitfalls

### Pitfall 1: Rate Limit Budget Burn from Eager Sub-Issue Fetch
**What goes wrong:** Fetching sub-issues for all 20-100 candidates on every 30-second poll tick consumes 20-100 extra API calls per tick, burning through the 5000/hour budget in ~50 ticks (25 minutes).
**Why it happens:** Naive implementation calls `fetchSubIssues()` inside `fetchCandidateIssues()` for every issue unconditionally.
**How to avoid:** Check cache first. Only fetch when cache misses (TTL expired or never fetched). With 5-minute TTL, each parent is fetched at most once every 5 minutes regardless of poll frequency.
**Warning signs:** `rateLimitRemaining` dropping fast; log lines showing sub-issue fetch on every tick.

### Pitfall 2: Parent Blocked Indefinitely Before Children Exist
**What goes wrong:** Parent issue gets `blocked_by` populated with children on first fetch, but children haven't been created yet (planner hasn't run). Parent never dispatches as planner.
**Why it happens:** Fetching sub-issues from GitHub returns any manually-linked children, even if added before the planner ran.
**How to avoid:** The three-phase pattern assumes the planner runs first (creates children), then children execute, then synthesizer. The parent should have no `blocked_by` on first dispatch. Sub-issue fetch should only wire `blocked_by` on the PARENT when all children are already created (or after `forge:synthesize` label is applied). Initially, parent has empty sub-issues → empty `blocked_by` → dispatches as planner.

### Pitfall 3: Cycle Detection False Positives from Cross-Repo References
**What goes wrong:** `blocked_by` entries that reference issue IDs from other repos look like unknown nodes to `validateDAG()`, causing "depends on unknown node" errors mistaken for cycles.
**Why it happens:** `validateDAG()` validates that all `depends_on` references point to known nodes. Sub-issues are always in the same repo, but manual overrides could reference external issues.
**How to avoid:** Filter the issue set to same-repo issues before cycle check, or skip unknown-node validation for issue DAG (use only the cycle-detection step).

### Pitfall 4: WebhookDeps Type Mismatch for SubIssueCache
**What goes wrong:** `WebhookDeps` in `src/github/webhooks.ts` doesn't know about the sub-issue cache, so invalidation handler can't be registered.
**Why it happens:** The cache lives in the tracker adapter closure; webhooks need a reference passed separately.
**How to avoid:** Add optional `subIssueCache?: SubIssueCache` to `WebhookDeps`. The daemon wiring code that calls `registerWebhookHandlers()` passes the cache reference.

### Pitfall 5: `terminalIssueIds` Not Populated Before `filterCandidates()` Called
**What goes wrong:** `filterCandidates()` receives empty `terminalIds` → all children appear blocked → nothing dispatches.
**Why it happens:** Cache is queried but no entries exist yet (cold start). TTL cache hasn't been warmed by any `fetchCandidateIssues()` call yet.
**How to avoid:** On first tick, `terminalIds` is empty — this is correct behavior. Children that are already closed will only be recognized as terminal after the first sub-issue fetch completes and populates the cache. This is a one-tick delay, which is acceptable.

### Pitfall 6: Stale Sub-Issue State After GitHub Webhook Delay
**What goes wrong:** A sub-issue is closed; GitHub sends webhook; cache is invalidated. But cache is re-warmed on the next `fetchCandidateIssues()` call, not immediately. If the poll interval is 30s, there's up to 30s before the parent unblocks.
**Why it happens:** Cache invalidation just clears the entry; the re-fetch happens on the next tick.
**How to avoid:** This is acceptable latency. Document it. Optionally, trigger an immediate `fetchSubIssues()` on cache invalidation (eager warm), but this is optional optimization.

---

## Code Examples

### Fetching Sub-Issues (GitHub REST API)
```typescript
// Source: https://docs.github.com/en/rest/issues/sub-issues
// GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
// Response: standard GitHubIssue array, paginated via Link header
// per_page max: 100, default: 30

async function fetchSubIssues(issueNumber: number): Promise<GitHubIssue[]> {
  const url = `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`;
  const result = await fetchAllPages(url);
  return result ? result.issues : [];
}
```

### Storing GitHub Internal ID in Metadata
```typescript
// Source: src/tracker/github.ts normalizeIssue() — existing metadata pattern
// ghIssue.id = numeric internal ID (e.g. 2564734)
// ghIssue.number = display number (e.g. 42) — used as TrackerIssue.id
const metadata: Record<string, unknown> = {
  ghInternalId: ghIssue.id,  // Required for sub_issue_id in POST write ops
};
```

### Building terminalIssueIds from Cache
```typescript
// src/orchestrator/scheduler.ts — replaces hardcoded empty Set
const terminalIds = new Set<string>();
if (deps.subIssueCache) {
  const terminalStates = new Set(config.tracker?.terminal_states ?? ["closed"]);
  for (const entry of deps.subIssueCache.getAllEntries()) {
    for (const [childId, state] of entry.childStates) {
      if (terminalStates.has(state)) terminalIds.add(childId);
    }
  }
}
```

### Checking Parent for Synthesizer Dispatch
```typescript
// In fetchCandidateIssues() — determine if parent should get forge:synthesize label
function allChildrenTerminal(
  childIds: string[],
  childStates: Map<string, string>,
  terminalStates: Set<string>,
): boolean {
  return childIds.length > 0 &&
    childIds.every(id => terminalStates.has(childStates.get(id) ?? ""));
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| GraphQL-only sub-issue queries | REST API for sub-issues (GA) | Dec 2024 | No GraphQL dependency needed |
| `blocked_by: []` hardcoded | `blocked_by` populated from sub-issue fetch | Phase 25 | Enables automatic dispatch ordering |
| `terminalIssueIds` always empty | Populated from sub-issue cache | Phase 25 | `filterCandidates()` can now block on sub-issue completion |
| ETag cache on candidate list | SubIssueCache with TTL + webhook invalidation | Phase 25 | Separate cache layer for sub-issue relationships |

**Deprecated/outdated:**
- GraphQL for sub-issue queries: The REST API is now GA (Dec 2024) and sufficient for all read operations needed in this phase.

---

## Open Questions

1. **Does `GET /repos/{owner}/{repo}/issues/{number}/sub_issues` return only direct children, or all descendants?**
   - What we know: GitHub UI shows nested hierarchies up to 8 levels. API docs describe listing "sub-issues" (direct children implied by naming).
   - What's unclear: Whether the endpoint returns only direct children or recursively all descendants.
   - Recommendation: Assume direct children only. Implement recursive fetch with depth counter (max 8). Cache each level separately.

2. **Does the sub-issues endpoint return `state` for each child?**
   - What we know: The response is described as standard GitHubIssue objects, which include `state`. The `jessehouwing.net` article confirms `id`, `number`, `state`, `title` are present.
   - What's unclear: Whether `state` is always populated or might be omitted.
   - Recommendation: HIGH confidence `state` is present (standard GitHubIssue shape). Handle absent `state` defensively (treat as "open").

3. **Webhook event for sub-issue relationship changes?**
   - What we know: `issues.edited` fires on issue body/title changes. The sub-issue add/remove REST API endpoints exist. It is unclear which webhook event fires when a sub-issue relationship is added or removed.
   - What's unclear: Is there an `issues.sub_issue_added` event or similar? Or does adding a sub-issue fire `issues.edited` on the parent?
   - Recommendation: Use `issues.edited` as best-effort invalidation trigger. TTL is the reliable fallback. LOW confidence on webhook event name — verify during implementation with a test GitHub App.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest, see package.json) |
| Config file | none detected — vitest defaults or package.json `test` script |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/tracker-github.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUBISSUE-01 | `normalizeIssue()` populates `blocked_by` from sub-issues | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts` | ✅ extend existing |
| SUBISSUE-01 | `fetchCandidateIssues()` calls sub-issue endpoint for candidates | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts` | ✅ extend existing |
| SUBISSUE-01 | Sub-issue fetch uses TTL cache (no double-fetch within TTL) | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-cache.test.ts` | ❌ Wave 0 |
| SUBISSUE-02 | `normalizeIssue()` stores `ghInternalId` in metadata | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts` | ✅ extend existing |
| SUBISSUE-03 | `tick()` passes populated `terminalIssueIds` to `filterCandidates()` | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | ✅ extend existing |
| SUBISSUE-03 | Issues in terminal states appear in `terminalIssueIds` set | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | ✅ extend existing |
| SUBISSUE-04 | Cycle detection identifies simple A→B→A cycles and returns error message | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-dag.test.ts` | ❌ Wave 0 |
| SUBISSUE-04 | Cycle detection posts GitHub comment and skips dispatch | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-dag.test.ts` | ❌ Wave 0 |
| SUBISSUE-04 | Non-cyclic graph passes validation | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-dag.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts test/unit/orchestrator-scheduler.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/tracker-sub-issue-cache.test.ts` — covers SUBISSUE-01 cache TTL behavior, invalidation, graceful degradation
- [ ] `test/unit/tracker-sub-issue-dag.test.ts` — covers SUBISSUE-04 cycle detection, comment posting, skip-dispatch behavior

*(Existing test files `tracker-github.test.ts` and `orchestrator-scheduler.test.ts` can be extended in-place for SUBISSUE-01/02/03 cases.)*

---

## Sources

### Primary (HIGH confidence)
- Official GitHub REST API docs — `https://docs.github.com/en/rest/issues/sub-issues` — endpoint existence, GA status
- `src/tracker/github.ts` — direct code inspection of `normalizeIssue()`, `githubFetch()`, `fetchAllPages()`
- `src/pipeline/dag.ts` — direct code inspection of `detectCycle()`, `validateDAG()`, node structure
- `src/orchestrator/dispatcher.ts:83` — direct code inspection of `filterCandidates()` using `blocked_by` + `terminalIssueIds`
- `src/orchestrator/scheduler.ts:64` — direct code inspection showing `terminalIds = new Set<string>()` hardcoded

### Secondary (MEDIUM confidence)
- `https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/` — confirmed `id` vs `number` distinction for `sub_issue_id` parameter, endpoint URL pattern `POST /repos/{owner}/{repo}/issues/{number}/sub_issues`
- GitHub Changelog Dec 2024 — `https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/` — confirmed REST API for sub-issues is GA

### Tertiary (LOW confidence)
- WebSearch results re: webhook event name for sub-issue relationship changes — unverified, validate during implementation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all existing code directly inspected; no new libraries
- Architecture: HIGH — injection points identified by direct code reading; API confirmed GA
- Pitfalls: HIGH — rate limit math and cache pattern derived from existing `github.ts` implementation; cycle detection from tested `pipeline/dag.ts`
- Sub-issue endpoint response shape: MEDIUM — standard GitHubIssue shape confirmed by multiple sources but response body schema not fully verified from official docs (page loaded empty)
- Webhook event for sub-issue changes: LOW — not verified from official docs

**Research date:** 2026-03-13
**Valid until:** 2026-04-12 (30 days — GitHub REST API is stable; sub-issues GA since Dec 2024)
