# Phase 5: Orchestration State Machine - Research

**Researched:** 2026-03-08
**Domain:** State machine orchestration, polling loop, concurrency control, retry/backoff
**Confidence:** HIGH

## Summary

Phase 5 builds the orchestrator "brain" that ties together the tracker (Phase 1), workspace (Phase 2), workflow contract (Phase 3), and agent sessions (Phase 4) into a continuous autonomous loop. The orchestrator polls for candidate issues, dispatches agents to isolated Docker containers with persistent workspaces, handles retries with exponential backoff, reconciles running workers against tracker state, and detects stalled agents.

The implementation is entirely in-process TypeScript with no external state machine libraries needed. All dependencies already exist in the project (dockerode, zod, fastify, vitest). The orchestrator integrates into the existing Fastify daemon, reusing SSE infrastructure, config loading, and agent session factories. The primary complexity is coordination: managing concurrent workers, timer lifecycles, and graceful shutdown with drain.

**Primary recommendation:** Use a Map-based in-memory state machine with typed transitions, setTimeout-chain tick loop (not setInterval for drift safety), and closure-scoped worker state. Lean on existing `prepareExecution()` flow but swap workspace binding to use `WorkspaceManager` paths instead of temp dirs.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Label-based priority: parse priority from labels (P0/P1/P2 or priority:high/medium/low). Lower number = higher priority, then oldest created_at as tie-breaker. Reuses Phase 1's existing label priority extraction
- Respect `blocked_by` dependencies: if issue A has blocked_by: [B] and B is not in a terminal state, skip A during candidate selection
- Global concurrency cap only (default maxConcurrentAgents: 3). No per-state limits -- keep slot management simple
- Dual claiming: in-memory Set for speed + best-effort label update in tracker (add in_progress_label on dispatch, remove on release). Label failure doesn't block dispatch
- Docker container per run: reuse existing prepareExecution() flow from single.ts. Each dispatch creates a Docker container with the persistent workspace mounted. Container destroyed after the run
- Validation is optional, from WORKFLOW.md: if validation steps configured, run them (like v1). If none configured, skip
- Structured comment write-back: post markdown comment with status (pass/fail), validation results, duration, token usage, branch/PR link if git output
- Continuation retry after success: schedule a 1s continuation retry after successful completion. Re-fetch issue -- if still in active state, dispatch again
- Three-tier failure classification: normal exit -> continuation, agent error -> exponential backoff, stall -> kill + exponential backoff
- Configurable max retries: default max_retries: 5. After exhausting retries, release issue, remove in-progress label, post failure comment
- Stall timeout: 10 minutes (600s) default
- Exponential backoff: `min(10000 * 2^(attempt-1), maxRetryBackoffMs)` with default maxRetryBackoffMs: 300000 (5 min)
- Preserve workspace across all retry types
- Daemon mode: orchestrator runs inside the existing Fastify daemon (port 4856)
- Config-driven auto-start: if `orchestrator.enabled: true` AND tracker config is present, orchestrator starts with the daemon
- `forgectl orchestrate` convenience command: starts daemon with orchestration enabled
- Graceful shutdown with drain: stop polling, wait up to 30s for in-flight agents, then force-kill. Release all claims, remove in-progress labels
- Reconciliation: run every tick before dispatch. Fetch states for all running issue IDs. Terminal -> stop + clean workspace. Non-active/non-terminal -> stop without cleanup. Active -> update snapshot. Failure -> keep running, retry next tick
- Startup recovery: fetch terminal-state issues, clean their workspaces. No persistent state. Fresh dispatch after cleanup

### Claude's Discretion
- Internal state machine representation (enum vs string union, Map structure)
- Tick sequence implementation (setInterval vs setTimeout chain)
- How prepareExecution() is adapted for orchestrated runs vs v1 single runs
- Slot manager internal design
- Retry timer management (setTimeout handles, cancellation)
- Config schema for orchestrator section (field names, defaults)
- How workspace is bind-mounted into the Docker container

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R2.1 | Issue Orchestration States (Unclaimed -> Claimed -> Running -> Released) | State machine types, transition functions, Map-based tracking |
| R2.2 | Polling Loop with tick sequence | setTimeout chain pattern, reconcile -> validate -> fetch -> sort -> dispatch |
| R2.3 | Concurrency Control (global maxConcurrentAgents) | Simple counter-based slot manager with acquire/release |
| R2.4 | Retry and Backoff (three-tier, exponential) | Timer management, backoff formula, retry handler pattern |
| R2.5 | Reconciliation (state refresh, stall detection) | fetchIssueStatesByIds integration, activity callback wiring |
| R2.6 | Startup Recovery (cleanup terminal workspaces) | cleanupTerminalWorkspaces integration, fresh dispatch |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.x | Language | Already in project |
| zod | 3.x | Config validation | Already used for all schemas |
| dockerode | 3.x | Docker container lifecycle | Already used throughout |
| fastify | 4.x | Daemon HTTP server | Already used for daemon |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| vitest | 1.x | Testing | All unit tests |
| chalk | 5.x | Terminal output | CLI orchestrate command |

### No New Dependencies
This phase requires zero new npm packages. Everything builds on existing project infrastructure:
- State machine: plain TypeScript Maps + Sets + enums
- Timers: Node.js built-in `setTimeout`/`clearTimeout`
- Concurrency: simple counter
- Events: existing `EventEmitter` from `src/logging/events.ts`

## Architecture Patterns

### Recommended Project Structure
```
src/orchestrator/
  state.ts          # OrchestratorState type, WorkerState, state transitions
  scheduler.ts      # Tick loop (poll -> reconcile -> dispatch), start/stop
  dispatcher.ts     # Candidate filtering, priority sort, slot check, claim + launch
  reconciler.ts     # State refresh, stall detection, worker cleanup
  retry.ts          # RetryQueue with backoff timers, three-tier classification
  worker.ts         # Single worker lifecycle (prepare -> execute -> report -> cleanup)
  index.ts          # Orchestrator class tying it all together
```

### Pattern 1: In-Memory State Machine
**What:** TypeScript-native state tracking using Maps and Sets. No external state machine library.
**When to use:** When state is ephemeral (recovered from tracker on restart) and transitions are simple.

```typescript
// State types
type IssueState = "claimed" | "running" | "retry_queued" | "released";

interface WorkerInfo {
  issueId: string;
  identifier: string;
  issue: TrackerIssue;
  session: AgentSession;
  container: Docker.Container;
  cleanup: CleanupContext;
  startedAt: number;
  lastActivityAt: number;
  attempt: number;
}

interface OrchestratorState {
  claimed: Set<string>;                    // issue IDs we own
  running: Map<string, WorkerInfo>;        // active workers
  retryTimers: Map<string, ReturnType<typeof setTimeout>>; // pending retries
  retryAttempts: Map<string, number>;      // attempt counts
}
```

### Pattern 2: setTimeout Chain (not setInterval)
**What:** Each tick schedules the next tick via `setTimeout` after completion.
**Why:** Prevents tick overlap if a tick takes longer than the interval. setInterval would queue ticks.

```typescript
async function scheduleTick(): Promise<void> {
  if (stopped) return;
  try {
    await tick();
  } catch (err) {
    logger.error("orchestrator", `Tick failed: ${err}`);
  }
  if (!stopped) {
    tickTimer = setTimeout(() => void scheduleTick(), pollIntervalMs);
  }
}
```

### Pattern 3: Worker Lifecycle Adapting prepareExecution()
**What:** Reuse `prepareExecution()` but swap the workspace binding.
**Key difference:** v1 `prepareExecution()` creates temp dirs and copies repo content. Orchestrated runs use `WorkspaceManager.ensureWorkspace()` paths directly as bind mounts.

The worker should:
1. Call `workspaceManager.ensureWorkspace(issue.identifier)` to get/create the persistent workspace path
2. Call `workspaceManager.runBeforeHook(issue.identifier)` before agent invocation
3. Build a modified `RunPlan` with `input.sources = [workspacePath]` and `input.mode = "repo"`
4. Call `prepareExecution()` with this modified plan (it handles image, creds, network, container)
5. Create agent session with `onActivity` callback for stall detection
6. Invoke agent, optionally run validation
7. Post structured comment with results
8. Call `workspaceManager.runAfterHook(issue.identifier)`
9. Destroy container (but NOT the workspace directory)

### Pattern 4: Priority Sorting
**What:** Sort candidates by priority label (ascending numeric), then `created_at`, then `identifier`.

```typescript
function sortCandidates(issues: TrackerIssue[]): TrackerIssue[] {
  return [...issues].sort((a, b) => {
    const pa = extractPriorityNumber(a.priority, a.labels);
    const pb = extractPriorityNumber(b.priority, b.labels);
    if (pa !== pb) return pa - pb;  // lower number = higher priority
    const da = new Date(a.created_at).getTime();
    const db = new Date(b.created_at).getTime();
    if (da !== db) return da - db;  // older first
    return a.identifier.localeCompare(b.identifier);
  });
}
```

### Pattern 5: Structured Comment
**What:** Markdown comment posted to tracker after each worker completion.

```markdown
## forgectl Agent Report

**Status:** Pass / Fail
**Duration:** 2m 34s
**Agent:** claude-code
**Attempt:** 2

### Validation Results
- [x] typecheck (passed)
- [ ] test (failed: 3 tests failed)

### Token Usage
| Input | Output | Total |
|-------|--------|-------|
| 12,450 | 3,200 | 15,650 |
```

### Anti-Patterns to Avoid
- **Shared mutable state without coordination:** All state mutations must happen in the tick function or callbacks it controls. Never mutate `running` Map from multiple concurrent async paths without guard.
- **setInterval for polling:** Causes tick overlap and drift. Use setTimeout chain.
- **Holding container references after cleanup:** Clear `WorkerInfo` from `running` Map before destroying the container to prevent use-after-destroy.
- **Blocking shutdown on stuck agents:** Use Promise.race with a 30s timeout during drain, then force-kill.
- **Throwing from reconciliation:** Reconciliation failures should log and skip, never crash the tick loop.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Container lifecycle | Custom Docker exec | Existing `prepareExecution()` + `cleanupRun()` | Handles image, creds, network, container creation, cleanup |
| Agent invocation | Raw Docker exec | `createAgentSession()` from `src/agent/session.ts` | Handles one-shot vs app-server, activity tracking, token usage |
| Workspace management | Manual mkdir/rm | `WorkspaceManager` from `src/workspace/manager.ts` | Handles sanitization, containment, hooks, cleanup |
| Tracker polling | Raw HTTP | `TrackerAdapter.fetchCandidateIssues()` | Handles ETag, pagination, rate limits |
| Config validation | Manual checks | Zod schema with `.default()` | Consistent with all other config sections |
| Event streaming | Custom SSE | `emitRunEvent()` from `src/logging/events.ts` | Already wired to daemon SSE endpoints |

**Key insight:** The orchestrator is primarily a coordinator. Almost all the "doing" code already exists in Phases 1-4. This phase wires it together with state management, timing, and error handling.

## Common Pitfalls

### Pitfall 1: Concurrent State Mutation
**What goes wrong:** Two async operations (e.g., reconciler killing a worker + retry handler dispatching same issue) race on the `running` Map.
**Why it happens:** Node.js is single-threaded but async operations interleave at await points.
**How to avoid:** All state mutations happen synchronously within the tick function. Retry handlers check `claimed` Set before re-dispatching. Use a guard: `if (running.has(issueId)) return;` before dispatch.
**Warning signs:** Duplicate containers for the same issue, "container not found" errors during cleanup.

### Pitfall 2: Timer Leaks on Shutdown
**What goes wrong:** Retry timers keep firing after shutdown, attempting to dispatch into a stopped orchestrator.
**Why it happens:** Forgetting to clear all retry timers during shutdown.
**How to avoid:** Keep all timer handles in a Map. On shutdown, iterate and `clearTimeout` every one. Set a `stopped` flag checked by timer callbacks.
**Warning signs:** Process doesn't exit cleanly, "Cannot dispatch after shutdown" errors.

### Pitfall 3: prepareExecution() Workspace Conflict
**What goes wrong:** `prepareExecution()` creates its own temp workspace and bind-mounts it. Orchestrated runs need to use the WorkspaceManager path instead.
**Why it happens:** `prepareExecution()` was built for v1 single-run mode.
**How to avoid:** Build a modified RunPlan where `input.sources[0]` is the WorkspaceManager path and `input.mode` is `repo`. Mark the cleanup context's `tempDirs` as empty (don't delete the persistent workspace). Alternatively, refactor to extract container creation from workspace preparation.
**Warning signs:** Agent sees empty workspace, workspace gets deleted after run.

### Pitfall 4: Stall Detection False Positives
**What goes wrong:** Agent is working but `onActivity` callback doesn't fire frequently enough.
**Why it happens:** OneShotSession fires activity once per invoke (per the design decision in STATE.md), not per line of output.
**How to avoid:** Set `lastActivityAt` at dispatch time AND when `onActivity` fires. Use a generous stall timeout (600s as decided). Only stall-kill if `Date.now() - lastActivityAt > stallTimeoutMs`.
**Warning signs:** Agents killed while actively working, excessive retry churn.

### Pitfall 5: Blocked-By Circular Dependencies
**What goes wrong:** Issues A and B both have `blocked_by` pointing to each other. Neither ever dispatches.
**Why it happens:** Users create circular blocking relationships.
**How to avoid:** Detect during candidate filtering but don't try to resolve -- just skip blocked issues. Log a warning if an issue has been blocked for an extended period. The tracker (GitHub/Notion) is the source of truth; users fix circular deps there.
**Warning signs:** Issues stuck indefinitely with "blocked" skip logs.

### Pitfall 6: Label Update Race Conditions
**What goes wrong:** Orchestrator adds `in_progress` label, then a reconciliation tick removes it (because issue state looks terminal), then retry re-adds it.
**Why it happens:** Label updates are best-effort and async.
**How to avoid:** In-memory `claimed` Set is the source of truth, not labels. Labels are cosmetic signals for humans. Always check the in-memory set, not labels, for dispatch decisions.
**Warning signs:** Label flapping in the tracker UI.

## Code Examples

### Orchestrator Config Schema Extension
```typescript
// Addition to src/config/schema.ts ConfigSchema
orchestrator: z.object({
  enabled: z.boolean().default(false),
  max_concurrent_agents: z.number().int().positive().default(3),
  poll_interval_ms: z.number().int().positive().default(30000),
  stall_timeout_ms: z.number().int().positive().default(600000),
  max_retries: z.number().int().min(0).default(5),
  max_retry_backoff_ms: z.number().int().positive().default(300000),
  drain_timeout_ms: z.number().int().positive().default(30000),
  continuation_delay_ms: z.number().int().min(0).default(1000),
}).default({}),
```

### Exponential Backoff Calculation
```typescript
function calculateBackoff(attempt: number, maxBackoffMs: number): number {
  const baseMs = 10000; // 10 seconds
  const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxBackoffMs);
  return delay;
}
// attempt 1: 10s, attempt 2: 20s, attempt 3: 40s, attempt 4: 80s, attempt 5: 160s (capped at 300s)
```

### Tick Sequence
```typescript
async function tick(): Promise<void> {
  // 1. Reconcile: check running workers against tracker state
  await reconcile(state, tracker, workspaceManager, logger);

  // 2. Validate config (skip dispatch if invalid)
  if (!validateConfig(currentConfig)) {
    logger.warn("orchestrator", "Config validation failed, skipping dispatch");
    return;
  }

  // 3. Fetch candidates from tracker
  const candidates = await tracker.fetchCandidateIssues();

  // 4. Filter: not claimed, not running, not blocked, slots available
  const eligible = filterCandidates(candidates, state);

  // 5. Sort by priority, then age
  const sorted = sortCandidates(eligible);

  // 6. Dispatch up to available slots
  const available = maxConcurrentAgents - state.running.size;
  for (const issue of sorted.slice(0, available)) {
    await dispatch(issue, state, tracker, workspaceManager, logger);
  }
}
```

### Worker Completion Handler
```typescript
async function onWorkerComplete(
  issueId: string,
  result: AgentResult,
  state: OrchestratorState,
  tracker: TrackerAdapter,
  config: OrchestratorConfig,
): Promise<void> {
  const worker = state.running.get(issueId);
  if (!worker) return;

  // Clean up container (but NOT workspace)
  await cleanupRun(worker.cleanup);
  state.running.delete(issueId);

  // Post structured comment
  const comment = buildResultComment(result, worker);
  await tracker.postComment(issueId, comment).catch(err =>
    logger.warn("orchestrator", `Failed to post comment: ${err}`)
  );

  // Classify and retry
  if (result.status === "completed") {
    // Continuation retry: re-check if issue still needs work
    scheduleRetry(issueId, config.continuation_delay_ms, "continuation", state, config);
  } else if (result.status === "failed" || result.status === "timeout") {
    const attempt = (state.retryAttempts.get(issueId) ?? 0) + 1;
    if (attempt > config.max_retries) {
      await releaseIssue(issueId, state, tracker, "max retries exhausted");
      return;
    }
    state.retryAttempts.set(issueId, attempt);
    const delay = calculateBackoff(attempt, config.max_retry_backoff_ms);
    scheduleRetry(issueId, delay, "error", state, config);
  }
}
```

### Graceful Shutdown
```typescript
async function shutdown(state: OrchestratorState, tracker: TrackerAdapter): Promise<void> {
  stopped = true;

  // 1. Cancel tick timer
  if (tickTimer) clearTimeout(tickTimer);

  // 2. Cancel all retry timers
  for (const [id, timer] of state.retryTimers) {
    clearTimeout(timer);
  }
  state.retryTimers.clear();

  // 3. Wait for running workers to finish (with timeout)
  if (state.running.size > 0) {
    const drainPromises = [...state.running.values()].map(w =>
      w.session.close().catch(() => {})
    );
    await Promise.race([
      Promise.allSettled(drainPromises),
      new Promise(resolve => setTimeout(resolve, drainTimeoutMs)),
    ]);
  }

  // 4. Force-kill remaining + cleanup
  for (const [id, worker] of state.running) {
    await cleanupRun(worker.cleanup).catch(() => {});
  }

  // 5. Release all claims
  for (const issueId of state.claimed) {
    await tracker.updateLabels(issueId, [], [inProgressLabel]).catch(() => {});
  }
  state.claimed.clear();
  state.running.clear();
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| XState/statecharts | Plain TS Maps + Sets | N/A (this is greenfield) | No library overhead for simple state |
| setInterval polling | setTimeout chain | Common Node.js pattern | Prevents tick overlap |
| Persistent state (DB/file) | Recover from tracker | Design decision | Simpler, no corruption risk |

## Open Questions

1. **RunPlan construction for orchestrated runs**
   - What we know: `prepareExecution()` expects a full `RunPlan`. The orchestrator has a `TrackerIssue` + `WorkflowFileConfig` + `ForgectlConfig`.
   - What's unclear: The exact mapping from orchestrator context to RunPlan fields (especially `task`, `input.sources`, `context`).
   - Recommendation: Build a `buildOrchestratedRunPlan()` function that constructs a RunPlan from issue + config + workspace path. The `task` field uses `renderPromptTemplate()` with issue data. `input.sources[0]` is the workspace path.

2. **Container image for orchestrated runs**
   - What we know: v1 gets the image from the workflow definition resolved by `resolveRunPlan()`.
   - What's unclear: Where the orchestrator gets the container image. WORKFLOW.md front matter has `extends` to reference a built-in workflow.
   - Recommendation: Use the workflow definition's container image. The merged config from `mergeWorkflowConfig()` provides this.

3. **Credential handling across concurrent runs**
   - What we know: `prepareExecution()` calls `getClaudeAuth()`/`getCodexAuth()` which read from keychain.
   - What's unclear: Whether concurrent `prepareExecution()` calls create conflicting temp credential files (via `prepareClaudeMounts`).
   - Recommendation: Each run gets a unique `runId` which is already used to namespace credential temp files. Should be safe.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 1.x |
| Config file | `vitest.config.ts` (or inline in `package.json`) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R2.1 | State transitions: claim -> run -> complete -> release | unit | `npx vitest run test/unit/orchestrator-state.test.ts -x` | Wave 0 |
| R2.1 | Duplicate claim prevention | unit | `npx vitest run test/unit/orchestrator-state.test.ts -x` | Wave 0 |
| R2.2 | Tick sequence: reconcile -> validate -> fetch -> sort -> dispatch | unit | `npx vitest run test/unit/orchestrator-scheduler.test.ts -x` | Wave 0 |
| R2.2 | Poll interval respected | unit | `npx vitest run test/unit/orchestrator-scheduler.test.ts -x` | Wave 0 |
| R2.3 | Concurrency cap prevents over-dispatch | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | Wave 0 |
| R2.3 | Slot release on worker exit | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | Wave 0 |
| R2.4 | Exponential backoff values for attempts 1-5 | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | Wave 0 |
| R2.4 | Continuation retry (1s) on success | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | Wave 0 |
| R2.4 | Max retries exhausted -> release | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | Wave 0 |
| R2.5 | Terminal state -> stop agent + clean workspace | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | Wave 0 |
| R2.5 | Stall detection kills agent past threshold | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | Wave 0 |
| R2.5 | State refresh failure -> keep running | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | Wave 0 |
| R2.6 | Startup cleanup of terminal workspaces | unit | `npx vitest run test/unit/orchestrator-startup.test.ts -x` | Wave 0 |
| R2.6 | Fresh dispatch after cleanup | unit | `npx vitest run test/unit/orchestrator-startup.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-*.test.ts -x`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/orchestrator-state.test.ts` -- covers R2.1
- [ ] `test/unit/orchestrator-scheduler.test.ts` -- covers R2.2
- [ ] `test/unit/orchestrator-dispatcher.test.ts` -- covers R2.3
- [ ] `test/unit/orchestrator-retry.test.ts` -- covers R2.4
- [ ] `test/unit/orchestrator-reconciler.test.ts` -- covers R2.5
- [ ] `test/unit/orchestrator-startup.test.ts` -- covers R2.6

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/tracker/types.ts`, `src/agent/session.ts`, `src/workspace/manager.ts`, `src/orchestration/single.ts`, `src/daemon/server.ts`, `src/config/schema.ts`
- Project CLAUDE.md and MEMORY.md -- established patterns and conventions
- CONTEXT.md -- locked design decisions from discussion phase

### Secondary (MEDIUM confidence)
- Node.js `setTimeout` vs `setInterval` -- well-established Node.js pattern for polling loops

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing project infrastructure
- Architecture: HIGH -- patterns derived directly from existing codebase and locked design decisions
- Pitfalls: HIGH -- identified from codebase analysis (async interleaving, timer lifecycle, workspace binding)

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, no external dependencies)
