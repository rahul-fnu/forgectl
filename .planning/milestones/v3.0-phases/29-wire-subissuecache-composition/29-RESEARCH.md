# Phase 29: Wire SubIssueCache Through Composition Layer - Research

**Researched:** 2026-03-14
**Domain:** TypeScript orchestrator composition, dependency injection, wiring
**Confidence:** HIGH

## Summary

Phase 29 is a pure composition/wiring phase. All logic (SubIssueCache, triggerParentRollup, handleSynthesizerOutcome, webhook invalidation) was implemented and unit-tested in phases 25 and 28. The gap is that three call sites in the runtime composition layer never pass `subIssueCache` to the functions that need it, so the sub-issue runtime features are dead code in production even though they pass unit tests.

The three concrete gaps are:
1. `Orchestrator.start()` in `src/orchestrator/index.ts` builds `this.deps` (TickDeps) without `subIssueCache`, so the scheduler tick never populates `terminalIssueIds` from live cache.
2. `Orchestrator.dispatchIssue()` in `src/orchestrator/index.ts` calls `dispatchIssueImpl(...)` without `subIssueCache`, so `triggerParentRollup` and `handleSynthesizerOutcome` never execute at runtime.
3. `registerWebhookHandlers(...)` in `src/daemon/server.ts` does not pass `subIssueCache` to `WebhookDeps`, so webhook-driven cache invalidation (`issues.edited`) never fires.

The fix is to instantiate one `SubIssueCache` instance in the orchestrator initialization block in `server.ts`, store it on the `Orchestrator` instance (adding it to `OrchestratorOptions`), and thread it through the three call sites above. All three call sites have already been written to accept `subIssueCache?: SubIssueCache` as an optional parameter. No new logic, no new tests for the logic itself — only composition wiring and composition-layer tests.

**Primary recommendation:** Create one `SubIssueCache` instance in `server.ts` during orchestrator initialization. Store it on `Orchestrator`. Thread it into `this.deps` (TickDeps), into `dispatchIssueImpl` calls, and into `WebhookDeps`. Add a narrow composition test in a new `test/unit/wiring-orchestrator-subissuecache.test.ts` that verifies the orchestrator actually passes `subIssueCache` when `start()` is called.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUBISSUE-03 | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | `TickDeps.subIssueCache` field exists and is consumed by `tick()`. Gap: orchestrator never sets it in `this.deps`. Fix: set `subIssueCache` in the `this.deps` object in `Orchestrator.start()`. |
| SUBISSUE-04 | Detect and report DAG cycles created by merging sub-issue hierarchy with manual overrides | Cycle detection implemented in Phase 25. Runtime wiring requires `subIssueCache` to be present in `TickDeps` so the scheduler tick can consult it. Same fix as SUBISSUE-03. |
| SUBISSUE-05 | Post progress rollup comments on parent issues as sub-issues complete | `triggerParentRollup` is called inside `executeWorkerAndHandle` only when `subIssueCache && githubContext`. Gap: `dispatchIssue()` in `orchestrator/index.ts` never passes `subIssueCache`. Fix: store cache on orchestrator, pass it through. |
| SUBISSUE-06 | Auto-close parent issue when all sub-issues reach terminal state | `handleSynthesizerOutcome` executes in the success path of `executeWorkerAndHandle`. Same gap and fix as SUBISSUE-05. The `forge:synthesize` label is applied by `triggerParentRollup`, which requires `subIssueCache`. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.x (project-wide) | Type-safe wiring, interface extension | Project language |
| vitest | project-wide | Unit testing for composition wiring | Project test framework |

No new npm dependencies. This phase uses only existing modules: `SubIssueCache` from `src/tracker/sub-issue-cache.ts`, `TickDeps` from `src/orchestrator/scheduler.ts`, `WebhookDeps` from `src/github/webhooks.ts`, `OrchestratorOptions` from `src/orchestrator/index.ts`.

**Installation:** None required.

## Architecture Patterns

### Current Wiring State (what exists vs what is wired)

```
src/tracker/sub-issue-cache.ts       SubIssueCache class — IMPLEMENTED
src/orchestrator/dispatcher.ts       dispatchIssue(..., subIssueCache?) — IMPLEMENTED, accepts cache
src/orchestrator/scheduler.ts        TickDeps.subIssueCache? field — IMPLEMENTED, consumed in tick()
src/github/webhooks.ts               WebhookDeps.subIssueCache? field — IMPLEMENTED, consumed in issues.edited
src/orchestrator/index.ts            Orchestrator — MISSING: no subIssueCache field, not in deps, not passed
src/daemon/server.ts                 startDaemon() — MISSING: no SubIssueCache instance created or passed
```

### Pattern 1: Optional Field Injection (project pattern)
The project uses optional dependency injection uniformly. `subIssueCache?: SubIssueCache` in all three interfaces already follows the `DurabilityDeps`, `GovernanceOpts`, `GitHubDeps` pattern: optional, backward-compatible, Notion users are never affected.

From STATE.md:
> `Optional injection for subIssueCache in TickDeps and WebhookDeps — backward compat preserved, Notion adapter users unaffected`

**Correct pattern for extending OrchestratorOptions:**
```typescript
// src/orchestrator/index.ts
export interface OrchestratorOptions {
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  runRepo?: RunRepository;
  autonomy?: AutonomyLevel;
  autoApprove?: AutoApproveRule;
  subIssueCache?: SubIssueCache;   // ADD THIS
}
```

**Correct pattern for Orchestrator.start():**
```typescript
// In Orchestrator.start(), add subIssueCache to this.deps:
this.deps = {
  state: this.state,
  tracker: this.tracker,
  workspaceManager: this.workspaceManager,
  slotManager: this.slotManager,
  config: this.config,
  promptTemplate: this.promptTemplate,
  logger: this.logger,
  metrics: this.metrics,
  runRepo: this.runRepo,
  autonomy: this.autonomy,
  autoApprove: this.autoApprove,
  subIssueCache: this.subIssueCache,   // ADD THIS
};
```

**Correct pattern for Orchestrator.dispatchIssue():**
```typescript
// In Orchestrator.dispatchIssue(), add subIssueCache as last arg:
dispatchIssueImpl(
  issue,
  this.state,
  this.tracker,
  this.config,
  this.workspaceManager,
  this.promptTemplate,
  this.logger,
  this.metrics,
  governance,
  githubContext,
  this.subIssueCache,   // ADD THIS
);
```

**Correct pattern for server.ts WebhookDeps:**
```typescript
// In startDaemon(), add subIssueCache to registerWebhookHandlers call:
const subIssueCache = new SubIssueCache();

orchestrator = new Orchestrator({
  tracker, workspaceManager, config: mergedConfig, promptTemplate, logger: daemonLogger,
  runRepo,
  autonomy: wf?.config?.autonomy,
  autoApprove: wf?.config?.auto_approve,
  subIssueCache,   // ADD THIS
});

// Later in the GitHub App block:
registerWebhookHandlers(ghAppService.app, {
  triggerLabel: "forgectl",
  onDispatch: ...,
  onCommand: ...,
  runRepo,
  findWaitingRunForIssue: ...,
  resumeRun,
  subIssueCache,   // ADD THIS
});
```

### Pattern 2: Scheduler dispatchIssue does NOT pass subIssueCache (scheduler gap)

Looking at `scheduler.ts` line 94, the `dispatchIssue` call in the scheduler tick does NOT pass `subIssueCache`:

```typescript
// Current (broken):
dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance);

// Fixed:
dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance, undefined, deps.subIssueCache);
```

Note: `dispatchIssue` signature is:
```
dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance?, githubContext?, subIssueCache?)
```
The scheduler tick does not have a `githubContext` (no live octokit per-tick), so `undefined` is passed for that argument.

### Anti-Patterns to Avoid
- **Creating multiple SubIssueCache instances:** One instance must be shared between the Orchestrator (for `dispatchIssue` rollup), the scheduler (for `terminalIssueIds`), and the webhook handler (for invalidation). Create exactly one in `server.ts` and share it.
- **Passing subIssueCache as Orchestrator constructor arg to scheduler separately:** The Orchestrator already stores deps and passes them to `startScheduler`. Adding to `this.deps` is sufficient.
- **noUnusedLocals violations:** If `subIssueCache` field is added to `OrchestratorOptions`, it must be used — the constructor must assign it to `this.subIssueCache`. The field must be declared as `private readonly subIssueCache?: SubIssueCache`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TTL cache | Custom cache | `SubIssueCache` (already exists) | Phase 25 implemented this |
| Cache invalidation logic | Custom event listener | `SubIssueCache.invalidate()` (already exists) | Phase 25 implemented this |
| Progress rollup logic | Custom rollup | `triggerParentRollup` (already exists) | Phase 28 implemented this |
| Synthesizer gate logic | Custom label flow | `handleSynthesizerOutcome` (already exists) | Phase 28 implemented this |

**Key insight:** All business logic is already implemented. This phase is exclusively about wiring call sites in the composition layer.

## Common Pitfalls

### Pitfall 1: Scoping — subIssueCache created outside orchestrator block
**What goes wrong:** If `SubIssueCache` is instantiated before the `if (orchestratorEnabled && config.tracker)` block in `server.ts`, it exists for the GitHub App block but the orchestrator block doesn't have access to it for passing to the Orchestrator constructor.
**Why it happens:** The GitHub App block and orchestrator block are independent `if` blocks. `subIssueCache` declared in the outer scope is accessible to both.
**How to avoid:** Declare `subIssueCache` in the outer scope of `startDaemon` before both blocks, but only instantiate it inside the orchestrator block. Or declare it in outer scope as `SubIssueCache | null = null` and instantiate inside the orchestrator block. Then reference it in the GitHub App block.
**Warning signs:** TypeScript error "Variable used before being assigned" or runtime `undefined` in webhook deps.

**Recommended approach:** Declare `let subIssueCache: SubIssueCache | undefined` in outer scope, set it inside the orchestrator block, reference in GitHub App block. This is the minimal-change pattern.

### Pitfall 2: dispatchIssue positional argument for githubContext vs subIssueCache
**What goes wrong:** The scheduler tick's `dispatchIssue` call passes `undefined` for `githubContext` (position 10) and `deps.subIssueCache` for `subIssueCache` (position 11). If arguments are swapped, the cache ends up as githubContext and vice versa.
**Why it happens:** Long positional argument lists are error-prone.
**How to avoid:** Count arguments carefully. The signature is: `(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance?, githubContext?, subIssueCache?)`. Position 10 is `githubContext` (undefined in scheduler), position 11 is `subIssueCache`.

### Pitfall 3: noUnusedLocals — field declared but not used
**What goes wrong:** Adding `subIssueCache?: SubIssueCache` to `OrchestratorOptions` without assigning it to `this.subIssueCache` causes a TypeScript compiler error (`noUnusedLocals: true`).
**Why it happens:** `tsconfig` strictly enforces no unused locals. All destructured/imported symbols must be used.
**How to avoid:** When adding the field to OrchestratorOptions, immediately add the private field declaration and constructor assignment. Also add the import for `SubIssueCache` to `src/orchestrator/index.ts`.

### Pitfall 4: Missing import in orchestrator/index.ts
**What goes wrong:** Adding `subIssueCache?: SubIssueCache` to `OrchestratorOptions` and `private readonly subIssueCache?: SubIssueCache` without importing the type causes a TypeScript error.
**Why it happens:** `SubIssueCache` type is not currently imported in `src/orchestrator/index.ts`.
**How to avoid:** Add `import type { SubIssueCache } from "../tracker/sub-issue-cache.js";` to `src/orchestrator/index.ts`.

### Pitfall 5: Missing import in server.ts
**What goes wrong:** Instantiating `new SubIssueCache()` in `server.ts` without importing it.
**Why it happens:** `SubIssueCache` is not currently imported in `src/daemon/server.ts`.
**How to avoid:** Add `import { SubIssueCache } from "../tracker/sub-issue-cache.js";` to `src/daemon/server.ts`.

## Code Examples

### Exact files to modify

**File 1: `src/orchestrator/index.ts`**
- Add `import type { SubIssueCache } from "../tracker/sub-issue-cache.js";`
- Add `subIssueCache?: SubIssueCache;` field to `OrchestratorOptions`
- Add `private readonly subIssueCache?: SubIssueCache;` private field
- Assign in constructor: `this.subIssueCache = opts.subIssueCache;`
- In `start()`: add `subIssueCache: this.subIssueCache,` to `this.deps`
- In `dispatchIssue()`: add `this.subIssueCache` as last arg to `dispatchIssueImpl`

**File 2: `src/orchestrator/scheduler.ts`**
- In `tick()` line 94: add `undefined, deps.subIssueCache` to `dispatchIssue` call (after `governance`)

**File 3: `src/daemon/server.ts`**
- Add `import { SubIssueCache } from "../tracker/sub-issue-cache.js";`
- Declare `let subIssueCache: SubIssueCache | undefined;` before the orchestrator block
- Inside the orchestrator block: `subIssueCache = new SubIssueCache();`
- Pass to `new Orchestrator({ ..., subIssueCache })`
- In the GitHub App block: pass `subIssueCache` to `registerWebhookHandlers`

### Composition test pattern (new test file)

The existing unit tests verify logic in isolation. Phase 29 needs composition tests verifying the wiring: that `Orchestrator.start()` results in `subIssueCache` being in `TickDeps`, and that `Orchestrator.dispatchIssue()` forwards the cache.

```typescript
// test/unit/wiring-orchestrator-subissuecache.test.ts
// Source: project test patterns (orchestrator-scheduler.test.ts, wiring-sub-issue-rollup.test.ts)

import { describe, it, expect, vi } from "vitest";
import { SubIssueCache } from "../../src/tracker/sub-issue-cache.js";
import { Orchestrator } from "../../src/orchestrator/index.js";

vi.mock("../../src/orchestrator/scheduler.js", () => ({
  startScheduler: vi.fn().mockReturnValue(() => {}),
  tick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/orchestrator/dispatcher.js", () => ({
  dispatchIssue: vi.fn(),
  // ...other exports
}));

// Tests:
// 1. When Orchestrator.start() is called with subIssueCache, startScheduler receives TickDeps with subIssueCache set
// 2. When Orchestrator.dispatchIssue() is called, dispatchIssueImpl receives the same subIssueCache instance
// 3. Backward compat: no subIssueCache in OrchestratorOptions => subIssueCache absent from deps (undefined)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No sub-issue awareness | SubIssueCache + TTL, dependency-aware dispatch | Phase 25 | Cache exists but not wired to runtime |
| Rollup logic missing | triggerParentRollup + upsertRollupComment | Phase 28 | Logic exists but not wired to runtime |
| Synthesizer gate missing | handleSynthesizerOutcome for forge:synthesize | Phase 28 | Logic exists but not wired to runtime |
| Webhook invalidation missing | WebhookDeps.subIssueCache?.invalidate() | Phase 25 | Handler exists but not wired at startup |

**Deprecated/outdated:** None. All code is current; this phase closes the wiring gap.

## Open Questions

1. **SubIssueCache location in server.ts**
   - What we know: The orchestrator block is inside `if (orchestratorEnabled && config.tracker)`. The GitHub App block is inside `if (config.github_app)`. Both are independent.
   - What's unclear: Whether the subIssueCache should be scoped to the orchestrator block or the outer startDaemon scope.
   - Recommendation: Outer scope (`let subIssueCache: SubIssueCache | undefined`), instantiated inside orchestrator block. This allows the GitHub App block to reference it as `subIssueCache` (which will be undefined if orchestrator didn't start, which is fine since `WebhookDeps.subIssueCache` is optional).

2. **Scheduler's dispatchIssue pass-through for subIssueCache**
   - What we know: The scheduler tick dispatches issues from the polling path (no GitHub context). The `githubContext` arg is undefined for scheduler-dispatched issues.
   - What's unclear: None — the pattern is clear. `dispatchIssue(..., governance, undefined, deps.subIssueCache)` is correct.
   - Recommendation: Pass `undefined` for githubContext and `deps.subIssueCache` for subIssueCache.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (project-wide) |
| Config file | vitest.config.ts (project root) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUBISSUE-03 | `TickDeps.subIssueCache` populated when orchestrator starts with cache | unit | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` | Wave 0 |
| SUBISSUE-04 | Same wiring as SUBISSUE-03 (cache in TickDeps enables cycle-aware dispatch) | unit | same | Wave 0 |
| SUBISSUE-05 | `dispatchIssueImpl` receives `subIssueCache` from orchestrator dispatch path | unit | same | Wave 0 |
| SUBISSUE-06 | `dispatchIssueImpl` receives `subIssueCache` (needed for `triggerParentRollup` which sets `forge:synthesize`) | unit | same | Wave 0 |

SUBISSUE-03/04 logic is already tested in `test/unit/orchestrator-scheduler.test.ts` (subIssueCache integration section). The new test covers the composition: that orchestrator wires the cache to tick.

SUBISSUE-05/06 logic is already tested in `test/unit/wiring-sub-issue-rollup.test.ts`. The new test covers the composition: that orchestrator passes cache to dispatcher.

Webhook invalidation (issues.edited) behavior is already tested in `test/unit/github-webhooks.test.ts`. Server.ts wiring can be verified by inspecting the argument passed to `registerWebhookHandlers`.

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/wiring-orchestrator-subissuecache.test.ts` — composition tests covering SUBISSUE-03/04/05/06 wiring through `Orchestrator` class

## Sources

### Primary (HIGH confidence)
- Direct source code inspection: `src/orchestrator/index.ts` — confirmed no `subIssueCache` field or import
- Direct source code inspection: `src/orchestrator/scheduler.ts` line 94 — confirmed `dispatchIssue` call missing `subIssueCache`
- Direct source code inspection: `src/daemon/server.ts` lines 169-199 — confirmed `registerWebhookHandlers` call missing `subIssueCache`
- Direct source code inspection: `src/orchestrator/dispatcher.ts` — confirmed `dispatchIssue` already accepts `subIssueCache?` as optional 11th arg
- Direct source code inspection: `src/github/webhooks.ts` — confirmed `WebhookDeps.subIssueCache?` field already exists and is consumed
- Direct source code inspection: `src/orchestrator/scheduler.ts` — confirmed `TickDeps.subIssueCache?` field already exists and is consumed in `tick()`

### Secondary (MEDIUM confidence)
- `test/unit/orchestrator-scheduler.test.ts` — `subIssueCache integration (SUBISSUE-03)` describe block already passes; logic is confirmed working when wired
- `test/unit/wiring-sub-issue-rollup.test.ts` — `triggerParentRollup` logic fully unit tested; only missing from composition path

### Tertiary (LOW confidence)
- None required. Research is from direct source inspection with HIGH confidence throughout.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all code already exists, no new dependencies
- Architecture: HIGH - three concrete gaps identified with exact line numbers
- Pitfalls: HIGH - verified from TypeScript conventions already enforced in this codebase

**Research date:** 2026-03-14
**Valid until:** Until Phase 29 is implemented (code will change; research is pre-implementation snapshot)
