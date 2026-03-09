# Phase 11: Flight Recorder - Research

**Researched:** 2026-03-09
**Domain:** Append-only event logging, audit trail, state snapshots, structured write-back
**Confidence:** HIGH

## Summary

Phase 11 builds an immutable audit trail for every forgectl run. The existing system already has the raw ingredients: `RunEvent` emissions via `EventEmitter` in `src/logging/events.ts`, structured `RunLog` JSON files in `src/logging/run-log.ts`, and `Logger` entries with `LogEntry` objects. The missing piece is persisting these events to the SQLite database (from Phase 10), adding state snapshots at step boundaries, providing a CLI `inspect` command, and upgrading the GitHub write-back comment from the current basic `buildResultComment()` format to a richer structured summary with changes, validation results, and cost breakdown.

The core challenge is instrumentation: tapping into the existing event flow (RunEvent emissions, Logger entries, validation results, agent results) and persisting them as append-only rows in a new `run_events` table and `run_snapshots` table. The existing `emitRunEvent()` calls in `src/orchestration/single.ts` already mark phase transitions (prepare, execute, validate, output, completed, failed). These need to be supplemented with finer-grained events (prompt sent, agent response, validation step result, retry, cost data) and a subscriber that writes each event to the database.

**Primary recommendation:** Add two new Drizzle tables (`run_events` and `run_snapshots`), create an `EventRecorder` class that subscribes to `runEvents` and persists events to the database, instrument the orchestration and validation code to emit richer events, and build a `forgectl run inspect` CLI command that queries and displays the audit trail. Upgrade `buildResultComment()` to produce richer GitHub comments using the recorded event data.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUDT-01 | Append-only event log records all run actions (prompts, tool calls, validation, retries, costs) | New `run_events` table with auto-increment integer PK, `run_id` FK, `type` discriminator, `timestamp`, and JSON `data` column. EventRecorder class subscribes to `runEvents` EventEmitter and persists. Existing `emitRunEvent()` calls provide skeleton; add new event types for prompt, agent_response, validation_step, retry, cost. |
| AUDT-02 | Rich write-back: structured GitHub comments with changes, validation results, cost breakdown | Extend existing `buildResultComment()` in `src/orchestrator/comment.ts` to accept richer data: file changes list, per-step validation details with stderr, token usage with cost estimate, timing breakdown. Query `run_events` to build the comment data. TrackerAdapter.postComment() already exists. |
| AUDT-03 | CLI: `forgectl run inspect <id>` shows full audit trail | New subcommand in `src/cli/run.ts`. Query `run_events` table ordered by sequence/timestamp. Format as chronological timeline with colored output (chalk). Include event type icons, timestamps, durations, and expandable data. |
| AUDT-04 | State snapshots captured at each step boundary | New `run_snapshots` table with `run_id`, `step_name`, `timestamp`, and JSON `state` column. Capture snapshots at phase transitions (prepare -> execute -> validate -> output) and at each validation retry boundary. State includes: current phase, validation results so far, agent status, files changed, elapsed time. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| drizzle-orm | ^0.45.x | ORM for event and snapshot tables | Already installed (Phase 10), type-safe schema and queries |
| better-sqlite3 | ^11.x | SQLite driver | Already installed (Phase 10), synchronous inserts are fast for append-only workloads |
| chalk | ^5.x | CLI output formatting for `inspect` command | Already installed, used throughout CLI |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| drizzle-kit | ^0.31.x (devDep) | Migration generation for new tables | Generate migration SQL for run_events and run_snapshots tables |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SQLite events table | Keep JSON files (current run-log.ts) | JSON files are not queryable, not append-only, not concurrent-safe |
| EventRecorder class | Direct DB writes at each call site | Scattered persistence logic, harder to test, violates SRP |
| Auto-increment integer PK | UUID for events | Integer PK gives natural ordering and is more efficient for append-only workloads in SQLite |

**Installation:**
```bash
# No new dependencies -- all already installed from Phase 10
npx drizzle-kit generate  # Generate migration for new tables
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── storage/
│   ├── schema.ts              # ADD: runEvents and runSnapshots tables
│   └── repositories/
│       ├── events.ts          # NEW: EventRepository (insert, findByRunId, findByType)
│       └── snapshots.ts       # NEW: SnapshotRepository (insert, findByRunId, latest)
├── logging/
│   ├── events.ts              # MODIFY: add new event types to RunEvent
│   └── recorder.ts            # NEW: EventRecorder class (subscribes + persists)
├── cli/
│   └── run.ts                 # MODIFY: add inspect subcommand
└── orchestrator/
    └── comment.ts             # MODIFY: richer buildResultComment with event data
```

### Pattern 1: Append-Only Event Table
**What:** A `run_events` table where rows are only ever inserted, never updated or deleted. Each event has a monotonically increasing integer PK that provides natural ordering.
**When to use:** Always for audit trail data -- immutability is a core requirement.
**Example:**
```typescript
// src/storage/schema.ts (additions)
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  timestamp: text("timestamp").notNull(),
  data: text("data"),  // JSON-serialized event payload
});

export const runSnapshots = sqliteTable("run_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  stepName: text("step_name").notNull(),
  timestamp: text("timestamp").notNull(),
  state: text("state").notNull(),  // JSON-serialized state object
});
```

### Pattern 2: EventRecorder (Subscriber Pattern)
**What:** A class that subscribes to the existing `runEvents` EventEmitter and persists each event to the database. Decouples event emission from storage.
**When to use:** In the daemon and CLI run paths -- anywhere runs execute.
**Example:**
```typescript
// src/logging/recorder.ts
import { runEvents, type RunEvent } from "./events.js";
import type { EventRepository } from "../storage/repositories/events.js";

export class EventRecorder {
  private repo: EventRepository;

  constructor(repo: EventRepository) {
    this.repo = repo;
    runEvents.on("run", (event: RunEvent) => {
      this.repo.insert({
        runId: event.runId,
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      });
    });
  }

  /** Detach from event emitter */
  close(): void {
    runEvents.removeAllListeners("run");
  }
}
```

### Pattern 3: State Snapshot at Boundaries
**What:** Capture a snapshot of the run's current state at each phase transition and validation retry boundary. Snapshots are JSON objects stored in the `run_snapshots` table.
**When to use:** At every call to `emitRunEvent` with type "phase", "retry", or "validation".
**Example:**
```typescript
// Snapshot shape
interface RunStateSnapshot {
  phase: string;                    // "prepare" | "execute" | "validate" | "output"
  agentStatus?: string;             // "completed" | "failed" | "timeout"
  validationAttempt?: number;
  validationResults?: Array<{ name: string; passed: boolean }>;
  elapsedMs: number;
  filesChanged?: number;
  tokenUsage?: { input: number; output: number; total: number };
}
```

### Pattern 4: CLI Inspect Output
**What:** `forgectl run inspect <id>` queries run_events and run_snapshots, formats as chronological timeline.
**When to use:** Post-run debugging, audit review.
**Example output:**
```
forgectl run inspect abc-123

Run: abc-123
Task: Fix login validation
Workflow: code
Status: completed
Duration: 2m 34s

Timeline:
  00:00  [started]   Task dispatched
  00:01  [phase]     prepare - Ensuring image, creating container
  00:05  [phase]     execute - Running claude-code
  00:05  [prompt]    System + task prompt (1,200 tokens)
  01:45  [response]  Agent completed (3,400 output tokens)
  01:46  [phase]     validate - Running 2 validation steps
  01:46  [validate]  typecheck -- passed (2.1s)
  01:48  [validate]  test -- FAILED (exit 1)
  01:48  [retry]     Attempt 2 - feeding errors back to agent
  01:49  [prompt]    Fix prompt with errors (800 tokens)
  02:10  [response]  Agent completed (1,200 output tokens)
  02:10  [validate]  typecheck -- passed (2.0s)
  02:12  [validate]  test -- passed (3.4s)
  02:12  [phase]     output - Collecting git output
  02:34  [completed] Branch: forgectl/fix-login-abc123

Cost: ~$0.12 (4,600 input + 4,600 output tokens)
```

### Anti-Patterns to Avoid
- **Mutable event rows:** Never UPDATE or DELETE from run_events. Append-only is a core invariant.
- **Storing raw stdout/stderr in events:** Agent output can be megabytes. Store truncated summaries (first 2KB) in events; full output stays in the existing RunLog JSON file.
- **Blocking on event writes:** Event inserts are synchronous (better-sqlite3) but fast (~1us per insert). Do not add async wrappers that could lose events on crash.
- **Over-instrumenting:** Not every log line needs an event. Events are for auditable actions (prompt, response, validation, phase transition, cost). Debug-level log entries stay in Logger only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event ordering | Custom sequence counters | SQLite auto-increment integer PK | Guaranteed monotonic ordering, no gaps in single-writer SQLite |
| JSON serialization in DB | Custom serialize/deserialize | Repository layer JSON.stringify/parse (established Phase 10 pattern) | Consistent with existing RunRepository pattern |
| Event subscription | Custom pub/sub | Node.js EventEmitter (already used in events.ts) | Already the established pattern; just add a persistent subscriber |
| Cost estimation | Custom token-to-dollar calculator | Simple multiplier constants per model | Token pricing changes; keep it a simple lookup table, not a service |

**Key insight:** The existing `emitRunEvent()` + `EventEmitter` pattern is the right foundation. The Flight Recorder adds a persistent subscriber (EventRecorder) -- it does not replace the event flow.

## Common Pitfalls

### Pitfall 1: Event Loss on Crash
**What goes wrong:** If the daemon crashes between event emission and database write, events are lost.
**Why it happens:** In-memory EventEmitter delivers synchronously, but if the subscriber throws, the event is dropped.
**How to avoid:** The subscriber (EventRecorder) uses synchronous better-sqlite3 inserts. The event is persisted before the emitRunEvent call returns. Wrap the insert in try/catch to prevent subscriber errors from crashing the emitter.
**Warning signs:** Events missing from the audit trail that appear in log files.

### Pitfall 2: Unbounded Event Data
**What goes wrong:** Storing full agent stdout/stderr in event data column causes database bloat.
**Why it happens:** Agent output can be 100KB+. Multiplied by retries and many runs, this fills SQLite quickly.
**How to avoid:** Truncate data payloads to a reasonable limit (2KB for stdout/stderr). Reference the full RunLog JSON file for complete output. Store only structured summaries in events.
**Warning signs:** Database file growing rapidly (>100MB after few hundred runs).

### Pitfall 3: Schema Migration Ordering
**What goes wrong:** New migration breaks existing tables or runs out of order.
**Why it happens:** Drizzle migration files are ordered by filename. If you manually edit migration order, the migrator gets confused.
**How to avoid:** Always use `npx drizzle-kit generate` to create migrations. Never manually renumber. The migrator tracks applied migrations in a `__drizzle_migrations` table.
**Warning signs:** "Migration already applied" errors on startup.

### Pitfall 4: Inspect Command Without Database
**What goes wrong:** `forgectl run inspect` fails when run from CLI without daemon (no database path).
**Why it happens:** The database is created by the daemon at a configurable path.
**How to avoid:** The inspect command should use the same database path resolution as the daemon (`~/.forgectl/forgectl.db` default). It opens a read-only connection to query events.
**Warning signs:** "Database not found" errors from inspect command.

### Pitfall 5: Comment Formatting Exceeds GitHub Limits
**What goes wrong:** Rich write-back comments are too long for GitHub (65,535 character limit).
**Why it happens:** Including full validation output, all file changes, and complete cost breakdown.
**How to avoid:** Cap the comment body. Truncate file change lists (show top 20, "and N more"). Use collapsible `<details>` sections for verbose output. Keep the primary summary under 2KB.
**Warning signs:** GitHub API 422 errors on comment posting.

## Code Examples

### Extending RunEvent Types
```typescript
// src/logging/events.ts (modified)
export interface RunEvent {
  runId: string;
  type:
    | "started" | "phase" | "validation" | "retry"
    | "output" | "completed" | "failed"
    | "dispatch" | "reconcile" | "stall" | "orch_retry"
    // New event types for flight recorder:
    | "prompt" | "agent_response" | "validation_step"
    | "cost" | "snapshot";
  timestamp: string;
  data: Record<string, unknown>;
}
```

### EventRepository
```typescript
// src/storage/repositories/events.ts
import { eq, and, desc } from "drizzle-orm";
import { runEvents } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface EventRow {
  id: number;
  runId: string;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface EventInsertParams {
  runId: string;
  type: string;
  timestamp: string;
  data?: unknown;
}

export interface EventRepository {
  insert(params: EventInsertParams): void;
  findByRunId(runId: string): EventRow[];
  findByRunIdAndType(runId: string, type: string): EventRow[];
}

export function createEventRepository(db: AppDatabase): EventRepository {
  return {
    insert(params: EventInsertParams): void {
      db.insert(runEvents).values({
        runId: params.runId,
        type: params.type,
        timestamp: params.timestamp,
        data: params.data ? JSON.stringify(params.data) : null,
      }).run();
    },

    findByRunId(runId: string): EventRow[] {
      return db.select().from(runEvents)
        .where(eq(runEvents.runId, runId))
        .all()
        .map(deserializeRow);
    },

    findByRunIdAndType(runId: string, type: string): EventRow[] {
      return db.select().from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
        .all()
        .map(deserializeRow);
    },
  };
}

function deserializeRow(raw: typeof runEvents.$inferSelect): EventRow {
  return {
    id: raw.id,
    runId: raw.runId,
    type: raw.type,
    timestamp: raw.timestamp,
    data: raw.data ? JSON.parse(raw.data) : null,
  };
}
```

### Rich Comment Builder
```typescript
// src/orchestrator/comment.ts (enhanced)
export interface RichCommentData extends CommentData {
  filesChanged?: Array<{ path: string; additions: number; deletions: number }>;
  costEstimate?: { inputCost: number; outputCost: number; totalCost: number; currency: string };
  timeline?: Array<{ timestamp: string; event: string; detail?: string }>;
}

export function buildRichResultComment(data: RichCommentData): string {
  const lines: string[] = [];
  lines.push("## forgectl Agent Report");
  lines.push("");
  // ... status, agent, duration (existing) ...

  // Cost breakdown
  if (data.costEstimate) {
    lines.push("");
    lines.push("### Cost");
    lines.push(`**Estimated:** $${data.costEstimate.totalCost.toFixed(4)}`);
    lines.push(`- Input: $${data.costEstimate.inputCost.toFixed(4)} (${data.tokenUsage.input.toLocaleString()} tokens)`);
    lines.push(`- Output: $${data.costEstimate.outputCost.toFixed(4)} (${data.tokenUsage.output.toLocaleString()} tokens)`);
  }

  // File changes (collapsible if many)
  if (data.filesChanged && data.filesChanged.length > 0) {
    lines.push("");
    lines.push("### Changes");
    const shown = data.filesChanged.slice(0, 20);
    for (const f of shown) {
      lines.push(`- \`${f.path}\` (+${f.additions} -${f.deletions})`);
    }
    if (data.filesChanged.length > 20) {
      lines.push(`- ... and ${data.filesChanged.length - 20} more files`);
    }
  }

  // Validation (existing, enhanced with stderr in <details>)
  // ...

  return lines.join("\n");
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| JSON run log files (run-log.ts) | SQLite append-only event table | Phase 11 | Queryable, concurrent-safe, supports inspect command |
| Basic comment (status + tokens) | Rich comment (changes, validation, cost, timeline) | Phase 11 | Users see full context without leaving GitHub |
| No state snapshots | Snapshots at each step boundary | Phase 11 | Enables Phase 12 crash recovery from last snapshot |

**Existing infrastructure preserved:**
- `RunLog` JSON files continue to be written (backward compat, full stdout/stderr archive)
- `Logger` entries continue in-memory for real-time terminal output
- `emitRunEvent()` continues to fire for SSE streaming to dashboard

## Open Questions

1. **Cost estimation accuracy**
   - What we know: Token counts are available from AgentResult.tokenUsage. Claude API pricing is public.
   - What's unclear: Codex pricing model, whether to include tool-use tokens separately.
   - Recommendation: Start with Claude-only cost estimation using a simple per-model price table. Flag Codex costs as "unknown" until pricing is confirmed. Cost is always an estimate, label it as such.

2. **Event retention policy**
   - What we know: Append-only means events accumulate indefinitely.
   - What's unclear: When to prune old events, how much disk space is acceptable.
   - Recommendation: Defer retention/pruning to a future phase. SQLite handles millions of rows efficiently. Add an index on `run_id` for query performance.

3. **Inspect command scope**
   - What we know: Requirement says "full chronological audit trail."
   - What's unclear: Should it also show live/in-progress runs or only completed ones?
   - Recommendation: Show whatever events exist for the run ID, regardless of completion status. In-progress runs will have a partial timeline.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts (implicit via package.json) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUDT-01 | Events persisted to run_events table | unit | `npx vitest run test/unit/event-repository.test.ts -x` | No - Wave 0 |
| AUDT-01 | EventRecorder subscribes and persists | unit | `npx vitest run test/unit/event-recorder.test.ts -x` | No - Wave 0 |
| AUDT-02 | Rich comment includes changes, validation, cost | unit | `npx vitest run test/unit/rich-comment.test.ts -x` | No - Wave 0 |
| AUDT-03 | Inspect command queries and formats events | unit | `npx vitest run test/unit/run-inspect.test.ts -x` | No - Wave 0 |
| AUDT-04 | Snapshots captured at step boundaries | unit | `npx vitest run test/unit/snapshot-repository.test.ts -x` | No - Wave 0 |
| AUDT-04 | Snapshot content matches expected state shape | unit | `npx vitest run test/unit/snapshot-capture.test.ts -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/ -x`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/event-repository.test.ts` -- covers AUDT-01 (event CRUD)
- [ ] `test/unit/event-recorder.test.ts` -- covers AUDT-01 (subscriber persistence)
- [ ] `test/unit/snapshot-repository.test.ts` -- covers AUDT-04 (snapshot CRUD)
- [ ] `test/unit/rich-comment.test.ts` -- covers AUDT-02 (comment formatting)
- [ ] `test/unit/run-inspect.test.ts` -- covers AUDT-03 (inspect output formatting)
- [ ] Drizzle migration for `run_events` and `run_snapshots` tables (via `drizzle-kit generate`)

## Sources

### Primary (HIGH confidence)
- Project codebase: `src/storage/schema.ts`, `src/logging/events.ts`, `src/logging/run-log.ts`, `src/orchestration/single.ts`, `src/orchestrator/comment.ts`, `src/orchestrator/worker.ts`
- Phase 10 RESEARCH.md: Drizzle ORM patterns, repository pattern, migration approach
- `src/storage/repositories/runs.ts`: Established repository pattern (synchronous methods, JSON serialization in repo layer)
- `src/cli/run.ts`: Existing CLI structure for run commands
- `src/tracker/github.ts`: `postComment()` method for GitHub write-back

### Secondary (MEDIUM confidence)
- Drizzle ORM docs: `integer().primaryKey({ autoIncrement: true })` for auto-increment PKs
- SQLite documentation: append-only table patterns, WAL mode performance for write-heavy workloads

### Tertiary (LOW confidence)
- Cost estimation per-token pricing: varies by model and may change; hardcoded lookup table is fragile but acceptable for estimates

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all dependencies already installed, patterns established in Phase 10
- Architecture: HIGH - extending established EventEmitter + repository patterns, minimal new design
- Pitfalls: HIGH - based on direct codebase analysis (event loss, data bloat, migration ordering)
- Cost estimation: LOW - model pricing is external and changes frequently

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable -- internal architecture, no external API dependencies)
