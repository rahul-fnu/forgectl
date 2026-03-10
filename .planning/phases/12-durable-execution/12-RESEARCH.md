# Phase 12: Durable Execution - Research

**Researched:** 2026-03-10
**Domain:** Crash recovery, checkpoint/resume, execution locks, pause/resume for human input
**Confidence:** HIGH

## Summary

Phase 12 adds durability to forgectl's run execution: runs survive daemon crashes, checkpoint at step boundaries for idempotent replay, support pausing for human input, and prevent duplicate execution via SQLite-based locks. The existing infrastructure from Phase 10 (SQLite + Drizzle ORM, repository pattern) and Phase 11 (EventRecorder, snapshots at step boundaries) provides a strong foundation.

The core challenge is retrofitting the existing fire-and-forget execution model (RunQueue processes runs sequentially, orchestrator dispatches workers with `void` async) to persist enough state that a restarted daemon can detect interrupted runs and either resume or mark them as failed. The key insight is that forgectl already has the `runs` table with status tracking and the `run_snapshots` table with step-boundary state capture -- what's missing is (1) a recovery routine on daemon startup, (2) richer checkpoint data at each execution phase, (3) a `waiting_for_input` status with context persistence, and (4) SQLite-based execution locks.

**Primary recommendation:** Build on the existing `runs` table + `run_snapshots` table. Add a `waiting_for_input` status, an `execution_locks` table, and a daemon startup recovery routine. Keep it simple: interrupted `running` runs become `interrupted` on restart, with enough snapshot data to replay from the last completed phase.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DURA-01 | Interrupted runs resume or fail cleanly on daemon restart | Recovery routine on startup scans for `running` status runs, uses snapshots to determine resumability |
| DURA-02 | Checkpoint/resume at step boundaries with idempotent replay | Extend existing `run_snapshots` with richer phase state; add replay logic per phase (prepare/execute/validate/output) |
| DURA-03 | Agent can pause into `waiting_for_input` state, persist context, resume on human reply | New status in runs table, context serialization, API endpoint for resume |
| DURA-04 | Atomic execution locks per issue/workspace via SQLite transactions | New `execution_locks` table with unique constraints, acquired/released in transactions |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| drizzle-orm | (existing) | Schema, queries, transactions | Already in use from Phase 10 |
| better-sqlite3 | (existing) | SQLite driver | Already in use, synchronous API for locks |
| zod | (existing) | Runtime validation of checkpoint/lock data | Already in use for all config validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| fastify | (existing) | REST endpoints for pause/resume | Already used for daemon API |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SQLite locks | File locks (flock) | SQLite is already the persistence layer; file locks don't survive daemon restart cleanly |
| App-level checkpointing | Temporal/BullMQ | Explicitly out of scope per REQUIREMENTS.md |
| Separate lock table | Advisory locks | SQLite doesn't have advisory locks; table-based is idiomatic |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── durability/
│   ├── recovery.ts         # Daemon startup recovery routine
│   ├── checkpoint.ts       # Enhanced checkpoint save/load for run phases
│   ├── locks.ts            # Execution lock acquire/release via SQLite
│   └── pause.ts            # Pause/resume state management
├── storage/
│   ├── schema.ts           # Add execution_locks table, waiting_input_context column
│   └── repositories/
│       └── locks.ts        # Lock repository
```

### Pattern 1: Startup Recovery
**What:** On daemon startup, scan `runs` table for rows with status `running`. For each, check if a snapshot exists. If the last snapshot shows the run completed a recoverable phase (e.g., prepare succeeded, agent invocation is the interrupted step), attempt resume. Otherwise, mark as `interrupted` with an explanation.
**When to use:** Every daemon startup.
**Example:**
```typescript
// src/durability/recovery.ts
export async function recoverInterruptedRuns(
  runRepo: RunRepository,
  snapshotRepo: SnapshotRepository,
  logger: Logger,
): Promise<RecoveryResult[]> {
  const interrupted = runRepo.findByStatus("running");
  const results: RecoveryResult[] = [];

  for (const run of interrupted) {
    const lastSnapshot = snapshotRepo.latest(run.id);

    if (!lastSnapshot) {
      // No checkpoint — mark as failed
      runRepo.updateStatus(run.id, {
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: "Daemon crashed before any checkpoint was saved",
      });
      results.push({ runId: run.id, action: "marked_interrupted" });
      continue;
    }

    // Determine if resumable based on last completed step
    const state = lastSnapshot.state as CheckpointState;
    if (state.phase === "prepare" && state.containerId) {
      // Container may be dead — mark as interrupted
      runRepo.updateStatus(run.id, {
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: `Interrupted after ${state.phase} phase. Container likely dead after daemon restart.`,
      });
      results.push({ runId: run.id, action: "marked_interrupted" });
    }
    // Additional resume logic for phases that can be replayed
  }

  return results;
}
```

### Pattern 2: Phase-Boundary Checkpoints
**What:** The existing `executeSingleAgent` function has clear phase boundaries: prepare, execute, validate, output. Insert snapshot captures between each phase transition. The snapshot includes enough state to determine what was completed.
**When to use:** At every phase boundary in the execution flow.
**Example:**
```typescript
// Enhanced phase tracking in executeSingleAgent
const checkpointState: CheckpointState = {
  phase: "prepare",
  runPlanSerialized: JSON.stringify(plan),
  timestamp: new Date().toISOString(),
};
recorder.captureSnapshot(plan.runId, "after:prepare", checkpointState);

// After agent execution
checkpointState.phase = "execute";
checkpointState.agentResultSummary = { status: agentResult.status };
recorder.captureSnapshot(plan.runId, "after:execute", checkpointState);
```

### Pattern 3: SQLite Execution Locks
**What:** An `execution_locks` table with a unique constraint on `(lock_type, lock_key)`. Lock acquisition uses INSERT within a transaction; release uses DELETE. Locks include an `owner_id` (run ID or daemon PID) to identify stale locks on recovery.
**When to use:** Before starting any run execution.
**Example:**
```typescript
// src/durability/locks.ts
export interface ExecutionLock {
  lockType: "issue" | "workspace";
  lockKey: string;          // issue ID or workspace path
  ownerId: string;          // run ID
  acquiredAt: string;
  daemonPid: number;        // for stale detection
}

export function acquireLock(
  db: AppDatabase,
  lock: Omit<ExecutionLock, "acquiredAt">,
): boolean {
  try {
    db.insert(executionLocks).values({
      lockType: lock.lockType,
      lockKey: lock.lockKey,
      ownerId: lock.ownerId,
      acquiredAt: new Date().toISOString(),
      daemonPid: lock.daemonPid,
    }).run();
    return true;
  } catch {
    // Unique constraint violation — lock held
    return false;
  }
}

export function releaseLock(
  db: AppDatabase,
  lockType: string,
  lockKey: string,
  ownerId: string,
): void {
  db.delete(executionLocks)
    .where(and(
      eq(executionLocks.lockType, lockType),
      eq(executionLocks.lockKey, lockKey),
      eq(executionLocks.ownerId, ownerId),
    ))
    .run();
}
```

### Pattern 4: Pause for Human Input
**What:** When an agent or validation step requires human input, the run transitions to `waiting_for_input`. The run's context (plan, current phase, any partial results) is serialized to the `runs` table or a dedicated column. A Fastify API endpoint accepts human input and resumes the run.
**When to use:** When agent signals it needs input, or governance (Phase 13) requires approval.
**Example:**
```typescript
// Pause a run
export function pauseRun(
  runRepo: RunRepository,
  runId: string,
  reason: string,
  context: PauseContext,
): void {
  runRepo.updateStatus(runId, {
    status: "waiting_for_input",
  });
  // Store pause context for resume
  runRepo.updatePauseContext(runId, {
    reason,
    pausedAt: new Date().toISOString(),
    phase: context.phase,
    serializedState: JSON.stringify(context.state),
  });
}

// Resume a run
export async function resumeRun(
  runRepo: RunRepository,
  runId: string,
  humanInput: string,
): Promise<void> {
  const run = runRepo.findById(runId);
  if (!run || run.status !== "waiting_for_input") {
    throw new Error(`Run ${runId} is not waiting for input`);
  }
  // Restore context and continue execution
  runRepo.updateStatus(runId, { status: "running" });
  // Re-enter execution from paused phase
}
```

### Anti-Patterns to Avoid
- **Trying to resume inside a dead container:** Docker containers don't survive daemon crashes. After restart, the container is gone. Resumable phases must account for container re-creation.
- **Storing full agent output in checkpoints:** Agent stdout/stderr can be huge. Store only status and metadata, not full output.
- **Using in-memory locks:** The current `PipelineExecutor.repoLocks` (in-memory Map) and `RunQueue.running` flag are lost on crash. All lock state must be in SQLite.
- **Treating checkpoint as event replay:** Per REQUIREMENTS.md, events are audit trail, not source of truth. Checkpoints store enough state to resume, but we don't replay events to reconstruct state (no CQRS).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Distributed locks | Custom TCP/file-based lock protocol | SQLite unique constraint + INSERT | Atomic, crash-safe, zero-config |
| Job queue with persistence | Custom queue with file-based state | Existing RunQueue + `runs` table (already persisted) | Already has the right abstraction |
| Process supervision | Custom watchdog/heartbeat | Daemon PID file + startup recovery | Simple, sufficient for single-machine |
| Serialization format | Custom binary checkpoint format | JSON serialization (already used everywhere) | Consistent with existing repos |

**Key insight:** The existing SQLite infrastructure (WAL mode, busy timeout, Drizzle ORM) already handles the hard concurrency problems. Execution locks are just a table with a unique constraint.

## Common Pitfalls

### Pitfall 1: Container State is Ephemeral
**What goes wrong:** Attempting to resume a run by reconnecting to a Docker container that no longer exists after daemon crash.
**Why it happens:** Docker containers are process-scoped; they die when the daemon crashes or can be cleaned up by Docker independently.
**How to avoid:** Accept that post-crash resume means re-creating the container. Only phases that don't depend on container state (like "mark as failed" or "collect already-committed git output") can be completed without the original container.
**Warning signs:** Code that stores `containerId` in checkpoint and tries to `docker.getContainer(id)`.

### Pitfall 2: Non-Idempotent Operations
**What goes wrong:** Replaying a phase that already partially completed causes duplicate side effects (double git commits, double comments, double label updates).
**Why it happens:** Phase operations weren't designed with replay in mind.
**How to avoid:** Each phase should check preconditions before acting. For git: check if branch already exists. For comments: check if comment was already posted (use idempotency keys). For labels: label operations are naturally idempotent.
**Warning signs:** Tests that fail when run twice in sequence.

### Pitfall 3: Stale Locks After Crash
**What goes wrong:** Daemon crashes while holding locks. On restart, the locks are still in the database, blocking all new runs for those issues/workspaces.
**Why it happens:** Lock release happens in `finally` blocks that never execute during a crash.
**How to avoid:** On startup recovery, identify locks owned by the current daemon PID (stored in lock row). If the daemon PID doesn't match the current process, release stale locks.
**Warning signs:** After restart, runs for certain issues stay in "queued" forever.

### Pitfall 4: Race Between Recovery and New Runs
**What goes wrong:** Daemon starts, new run is submitted via API, recovery routine hasn't finished yet, both try to process the same issue.
**Why it happens:** Recovery is async; the HTTP server starts accepting requests before recovery completes.
**How to avoid:** Run recovery synchronously during daemon startup, before the Fastify server starts listening. Or block the queue from processing until recovery completes.
**Warning signs:** Duplicate run attempts for the same issue immediately after restart.

### Pitfall 5: Pause Context Grows Unbounded
**What goes wrong:** Serializing the entire run state (including agent output, validation results) makes the pause context column huge.
**Why it happens:** Lazy serialization of everything "just in case."
**How to avoid:** Store only what's needed to resume: run plan reference (or ID), the phase name, and any human-relevant context (the question being asked). Agent output is already in the events table.
**Warning signs:** `runs` table rows exceeding 1MB.

## Code Examples

### Schema Extension for Execution Locks
```typescript
// src/storage/schema.ts — additions
export const executionLocks = sqliteTable("execution_locks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lockType: text("lock_type").notNull(),     // "issue" | "workspace"
  lockKey: text("lock_key").notNull(),       // issue ID or workspace path
  ownerId: text("owner_id").notNull(),       // run ID
  daemonPid: integer("daemon_pid").notNull(),
  acquiredAt: text("acquired_at").notNull(),
}, (table) => ({
  uniqueLock: unique().on(table.lockType, table.lockKey),
}));
```

### Extended Run Status Values
```typescript
// The `runs.status` column currently supports: "queued" | "running" | "completed" | "failed"
// Add: "interrupted" | "waiting_for_input"
// Also add columns for pause context:
// - pause_reason: text (nullable)
// - pause_context: text (nullable, JSON-serialized)
```

### Daemon Startup Recovery Integration
```typescript
// In src/daemon/server.ts — startDaemon()
// BEFORE app.listen():
const lockRepo = createLockRepository(db);
const snapshotRepo = createSnapshotRepository(db);
const recoveryResults = await recoverInterruptedRuns(runRepo, snapshotRepo, lockRepo, daemonLogger);
for (const r of recoveryResults) {
  daemonLogger.info("recovery", `Run ${r.runId}: ${r.action} — ${r.reason}`);
}
// Release all stale locks from previous daemon PID
releaseAllStaleLocks(db, process.pid);
```

### API Endpoint for Resume
```typescript
// In src/daemon/routes.ts
app.post("/api/v1/runs/:id/resume", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { input } = req.body as { input: string };
  const run = runRepo.findById(id);
  if (!run) return reply.status(404).send({ error: "Run not found" });
  if (run.status !== "waiting_for_input") {
    return reply.status(409).send({ error: `Run is ${run.status}, not waiting_for_input` });
  }
  await resumeRun(runRepo, id, input, queue);
  return reply.send({ status: "resumed" });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-memory RunQueue.running flag | Persisted `runs.status` column (Phase 10) | Phase 10 | Status survives restart but recovery not implemented |
| File-system checkpoints (pipeline) | SQLite snapshots (Phase 11) | Phase 11 | Snapshots exist but not used for recovery |
| No execution locks | In-memory `PipelineExecutor.repoLocks` | Phase 7 | Prevents concurrent git ops in-process only |

**Current gaps this phase fills:**
- `runs` table has status but no startup recovery routine
- `run_snapshots` has data but no replay/resume logic
- No `waiting_for_input` status exists
- No persistent execution locks (only in-memory)

## Open Questions

1. **Container re-creation on resume**
   - What we know: Containers die with daemon. Workspace bind-mounts survive on host.
   - What's unclear: Whether full re-creation (image pull, network, credentials) is acceptable latency for resume.
   - Recommendation: For v2.0, mark most interrupted runs as failed rather than attempting full re-creation. Only resume runs where the remaining work doesn't need the original container (e.g., "output" phase with git-mode where commits are already on the host branch).

2. **Granularity of "step boundaries"**
   - What we know: `executeSingleAgent` has 4 phases: prepare, execute, validate, output. The validation loop has sub-steps.
   - What's unclear: Whether validation loop sub-steps need individual checkpoints.
   - Recommendation: Checkpoint at major phase boundaries only (4 phases). Validation sub-steps are fast enough to replay from the start of validation. Keep it simple.

3. **How `waiting_for_input` integrates with Phase 14 (GitHub App)**
   - What we know: GHAP-06 requires conversational clarification where agent asks question, pauses, resumes on reply.
   - What's unclear: Exact mechanism for Phase 14 to trigger pause and provide resume input.
   - Recommendation: Build the generic pause/resume infrastructure now. Phase 14 will call `pauseRun()` and wire the resume to GitHub webhook events.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DURA-01 | Startup recovery marks interrupted runs or resumes them | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-recovery.test.ts -x` | Wave 0 |
| DURA-02 | Checkpoint save/load at phase boundaries, idempotent replay | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-checkpoint.test.ts -x` | Wave 0 |
| DURA-03 | Pause into waiting_for_input, persist context, resume | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-pause.test.ts -x` | Wave 0 |
| DURA-04 | SQLite-based execution locks, stale lock cleanup | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-locks.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/durability-recovery.test.ts` -- covers DURA-01 (startup recovery)
- [ ] `test/unit/durability-checkpoint.test.ts` -- covers DURA-02 (checkpoint/resume)
- [ ] `test/unit/durability-pause.test.ts` -- covers DURA-03 (pause/resume)
- [ ] `test/unit/durability-locks.test.ts` -- covers DURA-04 (execution locks)

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/storage/schema.ts`, `src/storage/database.ts`, `src/storage/repositories/*.ts`
- Codebase analysis: `src/orchestration/single.ts` (execution flow with phase boundaries)
- Codebase analysis: `src/daemon/queue.ts`, `src/daemon/server.ts`, `src/daemon/lifecycle.ts`
- Codebase analysis: `src/logging/recorder.ts` (EventRecorder + captureSnapshot)
- Codebase analysis: `src/orchestrator/state.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/worker.ts`
- Codebase analysis: `src/pipeline/checkpoint.ts` (existing file-based checkpoint pattern)
- Project requirements: `.planning/REQUIREMENTS.md` (DURA-01 through DURA-04, out-of-scope items)

### Secondary (MEDIUM confidence)
- SQLite unique constraint for locks: standard SQLite pattern, well-documented behavior
- Drizzle ORM unique constraints: consistent with existing schema patterns in project

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already in use, no new dependencies needed
- Architecture: HIGH - builds directly on Phase 10/11 infrastructure with clear extension points
- Pitfalls: HIGH - derived from concrete codebase analysis (e.g., container ephemerality, in-memory locks, fire-and-forget patterns)

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable domain, no external API dependencies)
