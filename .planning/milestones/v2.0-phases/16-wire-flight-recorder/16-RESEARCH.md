# Phase 16: Wire Flight Recorder - Research

**Researched:** 2026-03-10
**Domain:** Daemon wiring / event persistence integration
**Confidence:** HIGH

## Summary

Phase 16 is a gap-closure phase that fixes a broken integration pipeline: the `EventRecorder` class exists, is fully tested (6 unit tests), and works correctly -- but it is never instantiated in the daemon's `startDaemon()` function. As a result, the 39 `emitRunEvent()` call sites across 7 source files fire events into the void, and `forgectl run inspect <id>` reads from an empty events table.

The fix is surgical: instantiate `EventRecorder` in `startDaemon()` after repository creation, add `createEventRepository` to the imports, and call `recorder.close()` during shutdown. No new libraries, no new patterns, no architectural changes.

**Primary recommendation:** Add EventRecorder instantiation to `src/daemon/server.ts` (3-5 lines total including import, construction, and shutdown cleanup).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUDT-01 | Append-only event log records all run actions | EventRecorder + EventRepository exist and are tested; need instantiation in daemon |
| AUDT-03 | CLI: `forgectl run inspect <id>` shows full audit trail | Inspect command works but reads empty table; fix depends on AUDT-01 being wired |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | existing | SQLite driver | Already in use via Phase 10 |
| drizzle-orm | existing | ORM layer | Already in use via Phase 10 |

### Supporting
No new libraries needed. All code already exists.

## Architecture Patterns

### Existing Event Flow (Currently Broken)
```
emitRunEvent() -> runEvents EventEmitter -> [NOTHING LISTENING]
                                              ^-- EventRecorder never instantiated
```

### Target Event Flow (After Fix)
```
emitRunEvent() -> runEvents EventEmitter -> EventRecorder.handler()
                                              -> eventRepo.insert() -> SQLite
```

### Key Source Files
```
src/daemon/server.ts           # WHERE: instantiate EventRecorder (line ~49, after repos)
src/logging/recorder.ts        # WHAT: EventRecorder class (already complete)
src/logging/events.ts          # HOW: emitRunEvent() + runEvents EventEmitter (already complete)
src/storage/repositories/events.ts  # WHERE: event persistence (already complete)
src/cli/inspect.ts             # READS: eventRepo.findByRunId() (already complete)
```

### Pattern: EventRecorder Constructor Auto-Subscribes
The `EventRecorder` constructor automatically calls `runEvents.on("run", this.handler)`. No manual subscription needed. Just instantiate it and it starts persisting events.

```typescript
// Source: src/logging/recorder.ts (existing code)
constructor(eventRepo: EventRepository, snapshotRepo: SnapshotRepository) {
  this.eventRepo = eventRepo;
  this.snapshotRepo = snapshotRepo;
  this.handler = (event: RunEvent) => {
    try {
      this.eventRepo.insert({ ... });
    } catch (err) {
      console.error("[EventRecorder] Failed to persist event:", err);
    }
  };
  runEvents.on("run", this.handler);
}
```

### Pattern: Shutdown Cleanup
`EventRecorder.close()` removes the listener. Must be called in the daemon shutdown handler.

### Anti-Patterns to Avoid
- **Do NOT create a new EventEmitter:** The global singleton `runEvents` from `src/logging/events.ts` is the single bus. All 39 call sites already use it.
- **Do NOT try to make EventRecorder a singleton module:** It needs the repo instances from `startDaemon()`, so it must be instantiated there.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event persistence | Custom DB writes in server.ts | EventRecorder class | Already built, tested, handles errors |
| Event emission | New event system | Existing `emitRunEvent()` | 39 call sites already use it |
| Audit trail display | New CLI command | Existing `inspectCommand` | Already wired into CLI |

**Key insight:** All the pieces exist. This phase is purely about connecting them.

## Common Pitfalls

### Pitfall 1: Forgetting to Close Recorder on Shutdown
**What goes wrong:** EventRecorder listener stays attached after DB closes, causing errors on late events
**Why it happens:** Easy to add construction but forget cleanup
**How to avoid:** Add `recorder.close()` in the `shutdown` async function before `closeDatabase(db)`
**Warning signs:** Error logs about DB writes after daemon stop

### Pitfall 2: Import Order Issues
**What goes wrong:** Missing import for `createEventRepository` or `EventRecorder`
**Why it happens:** server.ts already imports snapshot and lock repos but not event repo
**How to avoid:** Add both imports: `createEventRepository` from storage and `EventRecorder` from logging

### Pitfall 3: EventRecorder Must Be Created Before Any Run Starts
**What goes wrong:** If EventRecorder is instantiated too late (e.g., after queue starts), early events are lost
**Why it happens:** The RunQueue callback starts executing runs which emit events
**How to avoid:** Instantiate EventRecorder right after creating the repositories, before the RunQueue is created (current line ~49, before line ~67)

## Code Examples

### The Complete Fix (server.ts)

New imports to add:
```typescript
// Add to existing imports
import { createEventRepository } from "../storage/repositories/events.js";
import { EventRecorder } from "../logging/recorder.js";
```

Instantiation (after line 49, after existing repo creation):
```typescript
const eventRepo = createEventRepository(db);
const recorder = new EventRecorder(eventRepo, snapshotRepo);
```

Shutdown cleanup (in the `shutdown` async function, before `closeDatabase`):
```typescript
recorder.close();
```

### Event Flow Verification
After wiring, the inspect command should work end-to-end:
```bash
# Run a task
forgectl run --task "hello world"

# Inspect the audit trail
forgectl inspect <run-id>

# Expected: Timeline with started, prompt, agent_response, validation, completed events
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Events fire into void | Events persisted to SQLite | Phase 16 (this fix) | Enables full audit trail |

## Open Questions

None. This is a well-understood wiring fix with no ambiguity.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/event-recorder.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUDT-01 | EventRecorder persists events to DB | unit | `npx vitest run test/unit/event-recorder.test.ts -x` | Yes |
| AUDT-01 | EventRecorder instantiated in daemon | unit | `npx vitest run test/unit/daemon-recorder-wiring.test.ts -x` | No (Wave 0) |
| AUDT-03 | inspect command reads events from DB | unit | `npx vitest run test/unit/cli-inspect.test.ts -x` | Yes |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/event-recorder.test.ts test/unit/cli-inspect.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before verify

### Wave 0 Gaps
- [ ] `test/unit/daemon-recorder-wiring.test.ts` -- verifies EventRecorder is instantiated with correct repos and closed on shutdown (can verify via import analysis or integration-style test of startDaemon setup)

## Sources

### Primary (HIGH confidence)
- `src/daemon/server.ts` -- current daemon startup code, confirmed no EventRecorder instantiation
- `src/logging/recorder.ts` -- EventRecorder class, constructor auto-subscribes to runEvents
- `src/logging/events.ts` -- emitRunEvent() and runEvents singleton EventEmitter
- `src/storage/repositories/events.ts` -- createEventRepository factory, EventRepository interface
- `src/cli/inspect.ts` -- inspectCommand reads from eventRepo.findByRunId()
- `test/unit/event-recorder.test.ts` -- 6 tests confirming EventRecorder works correctly

### Secondary (MEDIUM confidence)
- `.planning/v2.0-MILESTONE-AUDIT.md` -- gap analysis confirming the exact issue and fix

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all code exists
- Architecture: HIGH -- pattern is trivial constructor call + shutdown cleanup
- Pitfalls: HIGH -- well-understood, 3 minor items all easily avoided

**Research date:** 2026-03-10
**Valid until:** Indefinite (stable internal wiring, no external dependencies)
