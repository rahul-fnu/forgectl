# Phase 8: Wire Workflow Runtime Integration - Research

**Researched:** 2026-03-08
**Domain:** Daemon startup wiring, config merge integration, file watcher lifecycle
**Confidence:** HIGH

## Summary

Phase 8 closes two integration gaps identified in the v1.0 milestone audit: `WorkflowFileWatcher` (R4.3) and `mergeWorkflowConfig` (R4.4) are both fully implemented and unit-tested (8 tests each, 16 total) but have zero importers in the runtime. They exist as orphaned exports in `src/workflow/watcher.ts` and `src/workflow/merge.ts` respectively.

The daemon's `server.ts` currently loads `forgectl.yaml` via `loadConfig()` and loads `WORKFLOW.md` via `loadWorkflowFile()` separately, extracting only the `promptTemplate` string. The four-layer config merge is never applied, and the `WorkflowFileWatcher` is never started. The Orchestrator receives a static `config: ForgectlConfig` and `promptTemplate: string` at construction time with no mechanism to update them at runtime.

**Primary recommendation:** Wire `WorkflowFileWatcher` into daemon startup, apply `mergeWorkflowConfig` at startup and on reload, and add a method on `Orchestrator` to accept updated config/promptTemplate without restarting the scheduler or disrupting in-flight workers.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R4.3 | Dynamic Reload - Watch WORKFLOW.md for changes, re-read/re-parse/re-validate/apply new config; invalid reload keeps last good config; apply to poll interval, concurrency, prompt template, hooks, agent settings; do NOT restart in-flight sessions | WorkflowFileWatcher exists with debounce, last-good-config retention, AbortController cancellation. Needs wiring into server.ts startup/shutdown and Orchestrator reload method. |
| R4.4 | Config Merge - WORKFLOW.md settings merge with forgectl.yaml and CLI flags; priority: CLI flags > WORKFLOW.md > forgectl.yaml > defaults | mergeWorkflowConfig exists with sequential deepMerge. Needs to be called at daemon startup (replacing current separate loads) and on each watcher reload callback. |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | existing | Testing | Project standard |
| zod | existing | Config validation | Already validates WorkflowFrontMatterSchema |
| js-yaml | existing | YAML parsing | Used by loadWorkflowFile |
| node:fs/promises | built-in | watch() for file watching | Already used by WorkflowFileWatcher |

### No new dependencies needed
This phase is pure wiring of existing components. No new libraries required.

## Architecture Patterns

### Current State (the gap)

```
server.ts startup:
  const config = loadConfig();                           // forgectl.yaml only
  const wf = await loadWorkflowFile("WORKFLOW.md");      // separate load
  const promptTemplate = wf.promptTemplate;              // extract string only
  // wf.config (front matter) is DISCARDED - never merged
  // WorkflowFileWatcher is NEVER started
  orchestrator = new Orchestrator({ config, promptTemplate, ... });
```

### Target State (what Phase 8 delivers)

```
server.ts startup:
  const rawConfig = loadConfig();                        // forgectl.yaml
  const wf = await loadWorkflowFile("WORKFLOW.md");      // WORKFLOW.md
  const merged = mergeWorkflowConfig(defaults, rawConfig, wf.config, cliFlags);
  orchestrator = new Orchestrator({ config: merged, promptTemplate: wf.promptTemplate, ... });

  // Start watcher
  watcher = new WorkflowFileWatcher();
  watcher.start("WORKFLOW.md", {
    onReload: (newWf) => {
      const newMerged = mergeWorkflowConfig(defaults, rawConfig, newWf.config, cliFlags);
      orchestrator.applyConfig(newMerged, newWf.promptTemplate);
    },
    onWarning: (msg) => logger.warn("watcher", msg),
  });

  // On shutdown: watcher.stop()
```

### Pattern 1: Mutable TickDeps for Hot Reload

**What:** The `TickDeps` object passed to the scheduler holds `config` and `promptTemplate` as plain properties. Since the scheduler captures the `deps` object reference (not the individual values), mutating `deps.config` and `deps.promptTemplate` causes the next tick to use updated values automatically.

**When to use:** When the scheduler tick loop needs to pick up config changes without restarting.

**Key insight:** The `startScheduler` function captures `deps` by reference:
```typescript
// scheduler.ts line 94
pendingTimer = setTimeout(scheduleTick, deps.config.orchestrator.poll_interval_ms);
```
If `deps.config` is reassigned, the next `setTimeout` reads the new `poll_interval_ms`. No scheduler restart needed.

**Implementation:**
```typescript
// In Orchestrator class
applyConfig(newConfig: ForgectlConfig, newPromptTemplate: string): void {
  this.deps.config = newConfig;
  this.deps.promptTemplate = newPromptTemplate;

  // Update SlotManager max if concurrency changed
  const newMax = newConfig.orchestrator.max_concurrent_agents;
  if (this.slotManager.getMax() !== newMax) {
    this.slotManager.setMax(newMax);
  }

  this.logger.info("orchestrator", "Config reloaded");
}
```

### Pattern 2: CLI Flags Capture at Startup

**What:** CLI flags (e.g., `--agent-type`, `--concurrency`) must be captured at daemon startup and preserved for re-merge on each reload.

**When to use:** Every time `mergeWorkflowConfig` is called (startup and reload).

**Key insight:** The `startDaemon` function currently takes `(port, enableOrchestrator)`. It needs to also accept CLI-level overrides so they can be stored and reapplied on each WORKFLOW.md reload.

### Pattern 3: Watcher Lifecycle in Daemon

**What:** Watcher.start() returns a Promise that resolves when stopped. It must run as a fire-and-forget async task, not awaited at startup.

**Implementation:**
```typescript
// Fire-and-forget — watcher runs in background
void watcher.start(workflowPath, callbacks);

// On shutdown
watcher.stop(); // Aborts the fs.watch loop via AbortController
```

### Anti-Patterns to Avoid
- **Restarting the scheduler on config change:** Unnecessary -- mutating `deps` is sufficient since the scheduler reads from `deps` on each tick.
- **Stopping in-flight workers on config change:** R4.3 explicitly says "Do NOT restart in-flight agent sessions."
- **Re-creating the Orchestrator on reload:** Would lose state (claimed, running, retryTimers). Only config/promptTemplate should change.
- **Storing CLI flags in config object:** CLI flags must remain separate for correct re-merge priority on reload.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File watching | Custom fs polling | `WorkflowFileWatcher` (already built) | Has debounce, last-good-config, AbortController cleanup |
| Config merge | Manual property-by-property merge | `mergeWorkflowConfig` (already built) | Uses `deepMerge` with correct array-replace semantics |
| Config validation | Manual field checks | `WorkflowFrontMatterSchema.parse()` (already built) | Zod strict schema catches unknown keys |
| Debouncing | Custom timer logic | Built into `WorkflowFileWatcher` (300ms default) | Already handles rapid saves correctly |

**Key insight:** All the hard parts are already implemented and tested. This phase is purely integration wiring.

## Common Pitfalls

### Pitfall 1: SlotManager Max Not Updated on Reload
**What goes wrong:** `SlotManager` is constructed with `max_concurrent_agents` once. If WORKFLOW.md changes `concurrency.max_agents`, the SlotManager still uses the old value.
**Why it happens:** `SlotManager` stores `max` internally and `deps.config` update doesn't propagate to it.
**How to avoid:** `SlotManager` needs a `setMax(n)` method, or the Orchestrator's `applyConfig` must update it explicitly. Check if `SlotManager` already has this -- it currently only has `getMax()`.
**Warning signs:** Concurrency limit doesn't change after WORKFLOW.md edit.

### Pitfall 2: WORKFLOW.md Path Resolution
**What goes wrong:** The daemon uses `join(process.cwd(), "WORKFLOW.md")` but `cwd()` might not be the project root when the daemon is started as a background process.
**Why it happens:** Daemon startup doesn't save/restore the working directory.
**How to avoid:** Store the WORKFLOW.md path at startup time and reuse it for the watcher. Consider making it configurable.
**Warning signs:** Watcher watches wrong file or fails to find WORKFLOW.md.

### Pitfall 3: Race Between Reload and Tick
**What goes wrong:** Config is updated mid-tick, causing a tick to use partially old / partially new config.
**Why it happens:** `applyConfig` mutates `deps` while a tick may be reading from it.
**How to avoid:** The watcher reload fires on a debounced `setTimeout`, and ticks are also `setTimeout`-based. JavaScript's single-threaded event loop means they can't interleave within a single tick execution. The assignment `deps.config = newConfig` is atomic from the event loop's perspective. No lock needed.
**Warning signs:** None expected -- this is safe by design.

### Pitfall 4: Readonly Fields on Orchestrator
**What goes wrong:** `this.config` and `this.promptTemplate` are currently `private readonly`. Adding `applyConfig` requires removing `readonly`.
**Why it happens:** The fields were designed for single-assignment at construction.
**How to avoid:** Change to `private` (remove `readonly`) and update via `applyConfig`. The `deps` object is already non-readonly.

### Pitfall 5: Watcher Start Failure When No WORKFLOW.md
**What goes wrong:** If there's no WORKFLOW.md file, `watcher.start()` throws because `fs.watch()` fails on non-existent files.
**Why it happens:** `fs.watch()` requires the file to exist.
**How to avoid:** Only start the watcher if WORKFLOW.md exists. If it doesn't exist, skip watching (use defaults). The current server.ts already wraps `loadWorkflowFile` in try/catch for this case.

### Pitfall 6: mergeWorkflowConfig Type Mismatch
**What goes wrong:** `WorkflowFileConfig` (from WORKFLOW.md front matter) is not the same shape as `Partial<ForgectlConfig>`. The merge function expects `Partial<ForgectlConfig>` but front matter uses a different schema (e.g., `concurrency.max_agents` vs `orchestrator.max_concurrent_agents`).
**Why it happens:** Front matter schema (`WorkflowFrontMatterSchema`) has different field names than `ConfigSchema`.
**How to avoid:** Need a mapping function that converts `WorkflowFileConfig` fields into `Partial<ForgectlConfig>` structure before passing to `mergeWorkflowConfig`. Map `polling.interval_ms` to `orchestrator.poll_interval_ms`, `concurrency.max_agents` to `orchestrator.max_concurrent_agents`, etc.
**Warning signs:** Front matter overrides silently ignored because field names don't match.

## Code Examples

### Watcher Wiring in server.ts
```typescript
// Source: src/workflow/watcher.ts (existing API)
import { WorkflowFileWatcher } from "../workflow/watcher.js";
import { mergeWorkflowConfig } from "../workflow/merge.js";

// In startDaemon():
const watcher = new WorkflowFileWatcher();
const workflowPath = join(process.cwd(), "WORKFLOW.md");

void watcher.start(workflowPath, {
  onReload: (newWf) => {
    const frontMatterAsConfig = mapFrontMatterToConfig(newWf.config);
    const newMerged = mergeWorkflowConfig(defaults, rawConfig, frontMatterAsConfig, cliFlags);
    orchestrator?.applyConfig(newMerged, newWf.promptTemplate);
    daemonLogger.info("daemon", "WORKFLOW.md reloaded, config updated");
  },
  onWarning: (msg) => {
    daemonLogger.warn("daemon", msg);
  },
});

// In shutdown():
watcher.stop();
```

### Orchestrator applyConfig Method
```typescript
// New method on Orchestrator class
applyConfig(config: ForgectlConfig, promptTemplate: string): void {
  // Update deps (scheduler reads from deps on each tick)
  this.deps.config = config;
  this.deps.promptTemplate = promptTemplate;

  // Update SlotManager if concurrency changed
  const newMax = config.orchestrator.max_concurrent_agents;
  this.slotManager.setMax(newMax);

  this.logger.info("orchestrator", `Config reloaded (max=${newMax}, poll=${config.orchestrator.poll_interval_ms}ms)`);
}
```

### Front Matter to Config Mapping
```typescript
// Map WorkflowFileConfig fields to Partial<ForgectlConfig> structure
function mapFrontMatterToConfig(fm: WorkflowFileConfig): Partial<ForgectlConfig> {
  const result: Partial<ForgectlConfig> = {};

  if (fm.agent) result.agent = fm.agent;
  if (fm.tracker) result.tracker = fm.tracker as any;
  if (fm.workspace) result.workspace = fm.workspace as any;
  if (fm.validation) result.validation = fm.validation as any;

  if (fm.polling?.interval_ms) {
    result.orchestrator = { poll_interval_ms: fm.polling.interval_ms } as any;
  }
  if (fm.concurrency?.max_agents) {
    result.orchestrator = {
      ...result.orchestrator,
      max_concurrent_agents: fm.concurrency.max_agents,
    } as any;
  }

  return result;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Load WORKFLOW.md once at startup, discard front matter | Merge front matter into config, watch for changes | Phase 8 | Hot-reload without daemon restart |
| Separate config + promptTemplate loads | Four-layer merge (defaults > yaml > front matter > CLI) | Phase 8 | Correct priority chain per R4.4 |
| Orchestrator config immutable after construction | Mutable deps with applyConfig method | Phase 8 | Runtime config updates |

## Open Questions

1. **CLI flags passthrough to daemon**
   - What we know: `startDaemon(port, enableOrchestrator)` is the current signature. CLI flags like `--agent-type` are not currently passed through.
   - What's unclear: Whether any CLI flags currently affect daemon behavior beyond `--port` and `--enable-orchestrator`. The `run` command has flags but `daemon up` may not.
   - Recommendation: Check `src/cli/` for daemon-related commands. If no CLI flags exist for daemon config, pass an empty object for the CLI layer in `mergeWorkflowConfig`.

2. **SlotManager.setMax() existence**
   - What we know: `SlotManager` has `getMax()` but may not have `setMax()`.
   - What's unclear: Need to verify and potentially add `setMax()`.
   - Recommendation: Add if missing -- it's a one-liner.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` (existing) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=dot` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R4.3 | Watcher started on daemon startup | unit | `npx vitest run test/unit/daemon-watcher.test.ts -x` | No - Wave 0 |
| R4.3 | Watcher stopped on daemon shutdown | unit | `npx vitest run test/unit/daemon-watcher.test.ts -x` | No - Wave 0 |
| R4.3 | Reload propagates new config to Orchestrator | unit | `npx vitest run test/unit/daemon-watcher.test.ts -x` | No - Wave 0 |
| R4.3 | Invalid reload keeps last good config (existing) | unit | `npx vitest run test/unit/workflow-watcher.test.ts -x` | Yes |
| R4.3 | Poll interval/concurrency/prompt updated on reload | unit | `npx vitest run test/unit/orchestrator-reload.test.ts -x` | No - Wave 0 |
| R4.3 | In-flight workers NOT restarted on reload | unit | `npx vitest run test/unit/orchestrator-reload.test.ts -x` | No - Wave 0 |
| R4.4 | Four-layer merge at startup | unit | `npx vitest run test/unit/daemon-config-merge.test.ts -x` | No - Wave 0 |
| R4.4 | Merge priority: CLI > WORKFLOW.md > yaml > defaults | unit | `npx vitest run test/unit/workflow-merge.test.ts -x` | Yes (8 tests) |
| R4.4 | Front matter mapped to ForgectlConfig structure | unit | `npx vitest run test/unit/daemon-config-merge.test.ts -x` | No - Wave 0 |
| R4.3+R4.4 | Integration: watcher reload triggers re-merge | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | No - Wave 0 |
| R4.3 | Claude Code adapter works with merged config | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | No - Wave 0 |
| R4.3 | Codex adapter works with merged config (mocked) | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=dot`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/orchestrator-reload.test.ts` -- covers R4.3 reload propagation to Orchestrator
- [ ] `test/unit/daemon-watcher.test.ts` -- covers R4.3 watcher lifecycle in daemon
- [ ] `test/unit/daemon-config-merge.test.ts` -- covers R4.4 four-layer merge at startup + front matter mapping
- [ ] `test/unit/daemon-integration.test.ts` -- covers R4.3+R4.4 integration with agent adapters

## Sources

### Primary (HIGH confidence)
- `src/workflow/watcher.ts` -- WorkflowFileWatcher implementation, complete and tested
- `src/workflow/merge.ts` -- mergeWorkflowConfig implementation, complete and tested
- `src/daemon/server.ts` -- Current daemon startup, shows exact integration gap
- `src/orchestrator/index.ts` -- Orchestrator class, shows constructor and deps structure
- `src/orchestrator/scheduler.ts` -- TickDeps interface and startScheduler closure pattern
- `src/config/schema.ts` -- ForgectlConfig schema, shows field names
- `src/workflow/workflow-file.ts` -- WorkflowFrontMatterSchema, shows front matter field names
- `.planning/v1.0-MILESTONE-AUDIT.md` -- Gap analysis confirming R4.3 and R4.4 are partial

### Secondary (MEDIUM confidence)
- `test/unit/workflow-watcher.test.ts` -- 8 tests showing watcher behavior
- `test/unit/workflow-merge.test.ts` -- 8 tests showing merge behavior

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing
- Architecture: HIGH - code inspected directly, patterns clear from source
- Pitfalls: HIGH - identified from actual code inspection (type mismatches, readonly fields, SlotManager gap)

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- internal wiring only)
