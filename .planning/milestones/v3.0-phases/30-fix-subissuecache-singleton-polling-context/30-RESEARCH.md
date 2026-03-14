# Phase 30: Fix SubIssueCache Singleton + Polling githubContext - Research

**Researched:** 2026-03-14
**Domain:** TypeScript dependency injection, orchestrator wiring, tracker adapter pattern
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Dual SubIssueCache (SUBISSUE-03)**
- server.ts:117 creates Instance B (passed to orchestrator/webhooks)
- github.ts:139 creates Instance A inside createGitHubAdapter() closure
- Writes go to Instance A during fetchCandidateIssues; reads come from Instance B (always empty)
- Fix: single instance shared between adapter and orchestrator — adapter must use the externally-provided cache, not create its own

**Missing githubContext in Polling Path (SUBISSUE-05, SUBISSUE-06)**
- scheduler.ts:94 passes undefined as githubContext (position 10) to dispatchIssue
- triggerParentRollup guard at dispatcher.ts:437 requires both subIssueCache AND githubContext
- Fix: scheduler must receive and forward githubContext so rollup fires for polling-dispatched issues (the primary production path)

**Behavioral Decisions (Locked from Prior Phases)**
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

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUBISSUE-03 | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | Fix the dual-instance bug so cache writes in `fetchCandidateIssues` (Instance A) are visible to scheduler reads (Instance B). Single shared instance required. |
| SUBISSUE-05 | Post progress rollup comments on parent issues as sub-issues complete | Rollup only fires when `githubContext` is truthy at dispatcher.ts:437. Scheduler must pass githubContext for polling-dispatched issues to trigger rollup. |
| SUBISSUE-06 | Auto-close parent issue when all sub-issues reach terminal state | Same gate as SUBISSUE-05 — `triggerParentRollup` handles auto-close via synthesizer label. Both require githubContext in the polling path. |
</phase_requirements>

## Summary

Phase 30 fixes two independent but related wiring bugs uncovered during the post-Phase-29 milestone audit. Both bugs cause sub-issue rollup and auto-close to silently do nothing for the vast majority of production dispatches (polling-originated), while working only for the minority of webhook-triggered dispatches.

**Bug 1 (SUBISSUE-03): Dual SubIssueCache instances.** `createGitHubAdapter()` constructs a private `SubIssueCache` at `github.ts:139` and uses it throughout `fetchCandidateIssues`. `server.ts:117` constructs a second independent instance and passes it to `Orchestrator` and `registerWebhookHandlers`. The two instances never share data — writes during polling go to the adapter's private Instance A, while the scheduler reads from Instance B which is always empty. The fix is to allow the adapter to accept an externally-provided cache instead of constructing its own.

**Bug 2 (SUBISSUE-05/06): Missing githubContext in scheduler dispatch.** `scheduler.ts:94` calls `dispatchIssue(...)` with `undefined` as position 10 (the `githubContext` parameter). The `triggerParentRollup` guard at `dispatcher.ts:437` requires both `subIssueCache` AND `githubContext` to be truthy. Without githubContext, rollup comments and auto-close never fire for polling-originated work. The fix is to extend `TickDeps` with an optional `githubContext` field and wire it from `Orchestrator` through to the scheduler's `dispatchIssue` calls.

**Primary recommendation:** Inject the externally-created `SubIssueCache` into the adapter factory, and add `githubContext?: GitHubContext` to `TickDeps` so the scheduler can forward it to `dispatchIssue`.

## Standard Stack

### Core (in-scope only)
| File | Current State | Change Needed |
|------|--------------|---------------|
| `src/tracker/github.ts` | Creates private `SubIssueCache` at line 139 | Accept optional `subIssueCache` param; use it instead of creating a new one |
| `src/tracker/registry.ts` | Calls `createGitHubAdapter(config)` | Must stay TypeScript-compatible — registry uses `TrackerAdapterFactory = (config: TrackerConfig) => TrackerAdapter` |
| `src/daemon/server.ts` | Creates `subIssueCache = new SubIssueCache()` at line 117, passes to Orchestrator+webhooks | After adapter is created, inject the single cache into it (or create cache first and pass to both adapter and orchestrator) |
| `src/orchestrator/scheduler.ts` | `TickDeps` has no `githubContext` field; dispatch call at line 94 passes `undefined` | Add `githubContext?: GitHubContext` to `TickDeps`; pass `deps.githubContext` to `dispatchIssue` |
| `src/orchestrator/index.ts` | Receives `githubContext` in `dispatchIssue()` but does not store it for scheduler ticks | Store githubContext and include it in `TickDeps` via `this.deps` |

### No New Dependencies
Zero new npm packages — this phase is purely TypeScript wiring changes.

## Architecture Patterns

### Pattern 1: Externally-Injected Cache (Factory Parameter vs Setter)

Two viable approaches for how the adapter accepts the external cache:

**Option A — Factory function receives cache as second param:**
```typescript
// src/tracker/github.ts
export function createGitHubAdapter(
  config: TrackerConfig,
  subIssueCache?: SubIssueCache,  // NEW optional param
): TrackerAdapter & { subIssueCache: SubIssueCache } {
  // ...
  const cache = subIssueCache ?? new SubIssueCache(); // fallback for backward compat
  // use `cache` everywhere instead of creating a new one
}
```

**Option B — Post-construction setter (injectCache method):**
```typescript
adapter.injectCache = (cache: SubIssueCache) => { /* replace private ref */ };
```

Option A is preferred: it is simpler, aligns with how `TrackerConfig` injection works throughout the codebase, and avoids mutable post-construction state. The registry's `TrackerAdapterFactory` type only accepts `(config: TrackerConfig) => TrackerAdapter`, so `server.ts` must call `createGitHubAdapter` directly (bypassing `createTrackerAdapter`) to pass the cache, then store the result in the `tracker` variable. Backward compat is preserved because the param is optional — the factory creates its own internal cache if none is provided.

**Recommended wiring in server.ts:**
```typescript
// BEFORE (creates two independent caches):
subIssueCache = new SubIssueCache();
const tracker = createTrackerAdapter(config.tracker);  // creates its OWN cache
orchestrator = new Orchestrator({ ..., subIssueCache });

// AFTER (single shared cache):
subIssueCache = new SubIssueCache();
const adapter = config.tracker.kind === "github"
  ? createGitHubAdapter(config.tracker, subIssueCache)  // shares the cache
  : createTrackerAdapter(config.tracker);               // non-GitHub path unchanged
orchestrator = new Orchestrator({ tracker: adapter, ..., subIssueCache });
```

### Pattern 2: githubContext in TickDeps

The `TickDeps` interface in `scheduler.ts` already carries optional deps (`subIssueCache?`, `runRepo?`). Extending it with `githubContext?` follows the same pattern:

```typescript
// src/orchestrator/scheduler.ts
export interface TickDeps {
  // ... existing fields ...
  subIssueCache?: SubIssueCache;
  /** GitHub context for rollup/auto-close in polling-dispatched issues (SUBISSUE-05, SUBISSUE-06) */
  githubContext?: GitHubContext;
}

// dispatchIssue call at line 94 — pass deps.githubContext:
dispatchIssue(
  issue, state, tracker, config, workspaceManager, promptTemplate,
  logger, metrics, governance,
  deps.githubContext,   // WAS: undefined
  deps.subIssueCache,
);
```

The `GitHubContext` type is already defined in `src/orchestrator/index.ts` (and re-exported from `dispatcher.ts`). The `scheduler.ts` import should use the dispatcher's definition since that's already imported.

**Orchestrator wiring:**
`Orchestrator` already stores `subIssueCache` in `this.subIssueCache`. It needs to additionally store `githubContext?: GitHubContext` and include it in `this.deps` when building the `TickDeps` object in `start()`. The `dispatchIssue()` method in `Orchestrator` already accepts and forwards `githubContext` for webhook-triggered calls — no change needed there.

The `githubContext` for the scheduler comes from `server.ts` where the GitHub App is initialized. The orchestrator's `start()` is called before the GitHub App block, so the context cannot be passed in `OrchestratorOptions` as a constructor param at startup time. Two patterns handle this:

**Option A — `setGitHubContext(ctx)` method on Orchestrator:**
```typescript
orchestrator.setGitHubContext({ octokit: ..., repo });
```
Called after GitHub App init in server.ts. Updates `this.deps.githubContext` so subsequent ticks use it.

**Option B — githubContext in OrchestratorOptions, accepted at construction time:**
Server.ts creates context *before* creating the orchestrator (refactor startup order).

Option A is simpler — it mirrors the existing `applyConfig()` mutation pattern already on `Orchestrator`. It also handles the case where the GitHub App fails to initialize (context stays undefined = same behavior as today, rollup disabled).

### Pattern 3: Backward Compatibility

The `SubIssueCache` param in `createGitHubAdapter` is optional — Notion/non-GitHub users calling `createTrackerAdapter(config)` via the registry are unaffected. The new `githubContext?` in `TickDeps` is optional — all existing tests and non-GitHub orchestrators continue to work with `undefined`.

### Anti-Patterns to Avoid
- **Passing the adapter's private cache up to server.ts:** `createGitHubAdapter` already exposes `adapter.subIssueCache` on its return type and server.ts ignores it. Do NOT use this path — it creates a timing dependency where server.ts reads the cache after construction. Inject down instead.
- **Changing the `TrackerAdapterFactory` type signature:** Would require changing all registry callsites and non-GitHub adapters.
- **Adding a `repo` param to TickDeps without an octokit:** The `GitHubContext` type already bundles both `{ octokit, repo }` — do not split them.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Cache sharing between adapter and orchestrator | Custom event bus, SharedArrayBuffer, or pub/sub | Simple parameter injection — pass the same instance to both |
| GitHub context reaching the scheduler | Middleware layer, message queue | Store on orchestrator instance, include in TickDeps |
| Rollup firing for polling issues | New rollup trigger mechanism | Fix the `undefined` githubContext arg — rollup logic already exists and works |

**Key insight:** Both bugs are wiring defects, not logic defects. The rollup, auto-close, and cache logic in Phases 25/28 are correct. The only missing piece is getting the right objects to the right places at construction time.

## Common Pitfalls

### Pitfall 1: Registry Type Constraint
**What goes wrong:** Trying to pass `subIssueCache` through `createTrackerAdapter()` from `registry.ts` fails because `TrackerAdapterFactory = (config: TrackerConfig) => TrackerAdapter` takes only one argument.
**Why it happens:** The registry factory type was defined before SubIssueCache existed.
**How to avoid:** In `server.ts`, call `createGitHubAdapter(config.tracker, subIssueCache)` directly for the GitHub case instead of going through the registry. Gate this on `config.tracker.kind === "github"` and fall back to `createTrackerAdapter(config.tracker)` for all other kinds.
**Warning signs:** TypeScript error "Expected 1 arguments, but got 2" on `createTrackerAdapter`.

### Pitfall 2: Startup Order in server.ts
**What goes wrong:** `orchestrator.start()` is called at line 118 before the GitHub App block at line 156. If githubContext is passed as a constructor param, it's unavailable at construction time.
**Why it happens:** GitHub App init is optional and happens after orchestrator start.
**How to avoid:** Use a `setGitHubContext()` method called after GitHub App init succeeds, or pass it as part of a late-binding mechanism. Never assume GitHub App init succeeds.
**Warning signs:** `orchestrator` is `null` in the GitHub App block — the existing null-check pattern shows the right model.

### Pitfall 3: Stale TickDeps Reference
**What goes wrong:** `this.deps` is built once in `start()` and reused. Mutating `this.deps.githubContext` via `setGitHubContext()` works only if the scheduler's `tick()` reads `deps.githubContext` by reference on each call (which it does — `deps` is an object reference).
**Why it happens:** JavaScript objects are reference types — mutations to `this.deps` are visible to the scheduler's closure.
**How to avoid:** Mutate `this.deps.githubContext` directly (same pattern as `applyConfig()` which does `this.deps.config = config`).
**Warning signs:** If githubContext is spread into a new object inside `startScheduler`, changes won't propagate.

### Pitfall 4: noUnusedLocals TypeScript Rule
**What goes wrong:** If `githubContext` is added to `OrchestratorOptions` or `TickDeps` and not immediately used in all code paths, `tsc --noEmit` fails.
**Why it happens:** `tsconfig` has `noUnusedLocals: true` per CLAUDE.md.
**How to avoid:** Ensure every new field is referenced in at least one code path. The `githubContext` field must be passed to `dispatchIssue` in the tick loop, not just declared.
**Warning signs:** TypeScript error "'githubContext' is declared but its value is never read."

### Pitfall 5: Test isolation for new wiring tests
**What goes wrong:** Existing test `wiring-orchestrator-subissuecache.test.ts` mocks `startScheduler` at module level. A new test verifying `githubContext` in `TickDeps` must check `vi.mocked(startScheduler).mock.calls[0][0].githubContext`.
**Why it happens:** Test already uses `startScheduler` mock to inspect `TickDeps` — same pattern can be reused.
**How to avoid:** Follow the exact pattern from existing Test 1/2/3 in `wiring-orchestrator-subissuecache.test.ts`.

## Code Examples

### Injecting cache into adapter factory
```typescript
// src/tracker/github.ts — modified signature
export function createGitHubAdapter(
  config: TrackerConfig,
  externalCache?: SubIssueCache,
): TrackerAdapter & { subIssueCache: SubIssueCache } {
  // ...
  // Sub-issue TTL cache (5min default) — use externally-provided instance if given
  const subIssueCache = externalCache ?? new SubIssueCache();
  // rest of function unchanged — subIssueCache is used exactly as before
}
```

### server.ts — single cache, injected into both adapter and orchestrator
```typescript
// src/daemon/server.ts — inside orchestratorEnabled block
subIssueCache = new SubIssueCache();

// Use createGitHubAdapter directly for GitHub kind to share the cache
const tracker = config.tracker.kind === "github"
  ? createGitHubAdapter(config.tracker, subIssueCache)
  : createTrackerAdapter(config.tracker);

orchestrator = new Orchestrator({
  tracker, workspaceManager, config: mergedConfig, promptTemplate,
  logger: daemonLogger, runRepo,
  autonomy: wf?.config?.autonomy,
  autoApprove: wf?.config?.auto_approve,
  subIssueCache,
});
await orchestrator.start();

// After GitHub App init (line ~178), call:
orchestrator.setGitHubContext({ octokit: ghOctokit, repo: { owner, repo } });
```

### scheduler.ts TickDeps extension
```typescript
// src/orchestrator/scheduler.ts
import type { GitHubContext } from "./dispatcher.js";

export interface TickDeps {
  // ... existing fields ...
  subIssueCache?: SubIssueCache;
  /** GitHub context for rollup/auto-close in polling path (SUBISSUE-05, SUBISSUE-06) */
  githubContext?: GitHubContext;
}

// In tick(), Step 8 dispatch loop:
dispatchIssue(
  issue, state, tracker, config, workspaceManager, promptTemplate,
  logger, metrics, governance,
  deps.githubContext,    // was: undefined
  deps.subIssueCache,
);
```

### Orchestrator.setGitHubContext() and start() update
```typescript
// src/orchestrator/index.ts
private githubContext?: GitHubContext;

// In start():
this.deps = {
  // ... existing fields ...
  subIssueCache: this.subIssueCache,
  githubContext: this.githubContext,  // NEW
};

// New method:
setGitHubContext(ctx: GitHubContext): void {
  this.githubContext = ctx;
  this.deps.githubContext = ctx;  // live update — scheduler reads on next tick
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No sub-issue cache | SubIssueCache with 5-min TTL | Phase 25 | Reduces API calls per poll cycle |
| No rollup comments | Edit-in-place rollup with HTML marker | Phase 28 | Progress visible on parent issues |
| No synthesizer close | Synthesizer-gated auto-close | Phase 28 | Parent closed only after review agent |
| Cache created in server.ts only | Cache ALSO created in adapter (bug) | Phase 29 introduced partial fix | This phase completes the fix |

**Deprecated/outdated:**
- The private `const subIssueCache = new SubIssueCache()` inside `createGitHubAdapter` closure (line 139) — will be replaced by the injected param with fallback.

## Open Questions

1. **How to get the `repo` context (owner/repo string) for `GitHubContext.repo` when constructing it in server.ts**
   - What we know: `config.tracker.repo` is the `"owner/repo"` string (validated by the adapter). `RepoContext` is `{ owner: string; repo: string }`.
   - What's unclear: server.ts doesn't currently destructure `config.tracker.repo` anywhere in the orchestrator block.
   - Recommendation: `const [owner, repo] = config.tracker.repo.split("/")` in the GitHub App init block; pass `{ owner, repo }` as `RepoContext`.

2. **Which octokit instance to use for githubContext in the scheduler**
   - What we know: `ghAppService` provides an authenticated Octokit. The webhook `onDispatch` callback receives `octokit` per-call.
   - What's unclear: Whether a single installation-level Octokit from `ghAppService` suffices for rollup/auto-close API calls, or if a per-request Octokit is needed.
   - Recommendation: Use the installation Octokit from `ghAppService` — rollup writes to the same repo the orchestrator is already polling, so one installation covers it. The existing webhook path passes per-request Octokit but that's only because it's already present in the webhook payload.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest) |
| Config file | vitest.config.ts (or package.json scripts) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/wiring-orchestrator-subissuecache.test.ts test/unit/orchestrator-scheduler.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUBISSUE-03 | Cache writes in adapter are visible to scheduler via shared instance | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/wiring-orchestrator-subissuecache.test.ts` | Extend existing ✅ |
| SUBISSUE-05 | dispatchIssue call in tick() receives githubContext (not undefined) | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | Extend existing ✅ |
| SUBISSUE-06 | triggerParentRollup fires for polling-dispatched issues | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | Extend existing ✅ |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/wiring-orchestrator-subissuecache.test.ts test/unit/orchestrator-scheduler.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. New test cases are additive to existing files:
- `test/unit/wiring-orchestrator-subissuecache.test.ts` — add test for `githubContext` in TickDeps
- `test/unit/orchestrator-scheduler.test.ts` — add test verifying tick() passes `deps.githubContext` to `dispatchIssue`
- `test/unit/tracker-sub-issue-cache.test.ts` — no changes needed (cache unit tests are complete)

## Sources

### Primary (HIGH confidence)
- Direct source code inspection — `src/tracker/github.ts`, `src/daemon/server.ts`, `src/orchestrator/scheduler.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/index.ts`, `src/tracker/sub-issue-cache.ts`, `src/tracker/registry.ts`
- Direct test inspection — `test/unit/wiring-orchestrator-subissuecache.test.ts`, `test/unit/orchestrator-scheduler.test.ts`, `test/unit/wiring-sub-issue-rollup.test.ts`
- `.planning/phases/30-fix-subissuecache-singleton-polling-context/30-CONTEXT.md` — locked decisions from prior discussion

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` — accumulated architectural decisions from Phases 25-29
- `.planning/REQUIREMENTS.md` — v3.0 requirement definitions

## Metadata

**Confidence breakdown:**
- Root cause analysis: HIGH — confirmed by reading exact line numbers in source
- Fix approach (factory injection): HIGH — consistent with existing patterns, TypeScript constraints verified
- Fix approach (githubContext in TickDeps): HIGH — exact pattern match to existing `subIssueCache` extension
- Test plan: HIGH — existing test files already cover the injection patterns; new tests follow established patterns

**Research date:** 2026-03-14
**Valid until:** Stable (internal wiring fix, no external dependencies)
