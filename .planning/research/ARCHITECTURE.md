# Architecture Research: v5.0 Intelligent Decomposition

**Domain:** LLM-driven task decomposition, worktree-based lightweight runtimes, rate limit retry scheduling, run outcome learning integrated into an existing AI agent orchestrator
**Researched:** 2026-03-14
**Confidence:** HIGH

---

## Context: What Exists

v5.0 adds four new capabilities to the forgectl orchestrator stack that shipped in v3.0 (16,662 LOC, 1,162 tests):

```
Existing layers (DO NOT REPLACE):
  GitHub App webhooks → Orchestrator (scheduler/dispatcher/worker/reconciler)
  → Agent sessions (oneshot/appserver/browser-use) → Docker containers (dockerode)
  Pipeline DAG executor (topological sort, parallel slots)
  SQLite + Drizzle ORM (runs, events, locks, snapshots, pipelines)
  Flight recorder (append-only events)
  Governance (autonomy levels, approval state machine)
  Sub-issue DAG with TTL cache + cycle detection
```

The v5.0 features are entirely **additive** — no existing subsystem needs replacement, only extension.

---

## System Overview: v5.0 Integration Points

```
                     ┌──────────────────────────────────────────────┐
                     │          EXISTING INTERACTION LAYER          │
                     │  GitHub webhooks  │  REST API  │  Dashboard   │
                     └────────────────────────────────┬─────────────┘
                                                      │
                     ┌────────────────────────────────▼─────────────┐
                     │           EXISTING GOVERNANCE LAYER           │
                     │   Autonomy enforcement, approval gates,       │
                     │   budget checks  (src/governance/)            │
                     └────────────────────────────────┬─────────────┘
                                                      │
    NEW: Rate Limit               ┌───────────────────▼──────────────────┐
    Retry Scheduler ─────────────►│     ORCHESTRATOR  (src/orchestrator/) │
    (src/rate-limit/)             │  scheduler / dispatcher / worker      │
                                  │  reconciler / retry                   │
                                  │                                       │
                                  │  [MODIFIED] Dispatcher gains          │
                                  │    RateLimitError detection path →    │
                                  │    schedule-for-resume, preserve ws   │
                                  └────────────────┬─────────────────────┘
                                                   │
    NEW: Decomposition            ┌────────────────▼─────────────────────┐
    Engine ──────────────────────►│         WORKER  (src/orchestrator/)   │
    (src/decomposition/)          │  [MODIFIED] DetectsDecomposable flag  │
                                  │  → DecompositionEngine.analyze()      │
                                  │  → emits sub-issue DAG or fallback    │
                                  └──────┬──────────────────┬─────────────┘
                                         │                  │
                        ┌────────────────▼───┐      ┌───────▼──────────────┐
                        │  Docker Runtime     │      │  Worktree Runtime     │
                        │  (existing)         │      │  (NEW)               │
                        │  src/container/     │      │  src/worktree/       │
                        │  Full isolation for │      │  Lightweight for      │
                        │  decomposition pass │      │  parallel sub-tasks   │
                        └────────────────────┘      └──────────────────────┘
                                                              │
                                         ┌────────────────────▼─────────────────┐
                                         │    OUTCOME LEARNER  (src/learning/)   │
                                         │  Persists lessons, dead-ends,         │
                                         │  playbook hints per issue/workflow     │
                                         │  → feeds context/prompt.ts on next    │
                                         │    run for same repo/issue type       │
                                         └───────────────────────────────────────┘
                                                              │
                     ┌────────────────────────────────────────▼─────────────┐
                     │              EXISTING STORAGE LAYER                  │
                     │  SQLite + Drizzle ORM (src/storage/)                 │
                     │  [SCHEMA EXTENSION] + decomposition_plans,           │
                     │    rate_limit_state, outcome_lessons tables           │
                     └──────────────────────────────────────────────────────┘
```

---

## New vs Modified Components

| Component | Directory | Status | Responsibility |
|-----------|-----------|--------|----------------|
| Decomposition Engine | `src/decomposition/` | **NEW** | LLM-driven issue analysis, DAG output, validation, fallback |
| Worktree Runtime | `src/worktree/` | **NEW** | git worktree lifecycle, branch-per-task, process spawn, merge, conflict detection |
| Rate Limit Retry Scheduler | `src/rate-limit/` | **NEW** | Detect LLM 429/rate errors, schedule deferred retry, preserve workspace |
| Outcome Learner | `src/learning/` | **NEW** | Persist run outcomes, dead-end tracking, lesson injection |
| Worker | `src/orchestrator/worker.ts` | **MODIFIED** | Detect decomposable issues, invoke DecompositionEngine, route to worktree or Docker |
| Dispatcher | `src/orchestrator/dispatcher.ts` | **MODIFIED** | Handle RateLimitError from worker, schedule resume with preserved workspace |
| Retry scheduler | `src/orchestrator/retry.ts` | **MODIFIED** | Gain RateLimitRetry entry type (scheduled_at, preserved_workspace_path) |
| Context/prompt builder | `src/context/prompt.ts` | **MODIFIED** | Inject outcome lessons and dead-end hints from OutcomeLearner |
| Storage schema | `src/storage/schema.ts` | **MODIFIED** | Add decomposition_plans, rate_limit_retries, outcome_lessons tables |
| Config schema | `src/config/schema.ts` | **MODIFIED** | Add decomposition, worktree, learning config sections |
| Workflow types | `src/workflow/types.ts` | **MODIFIED** | Add decompose: true/false and learning: enabled fields |

---

## Component 1: Decomposition Engine

### Responsibility

When a worker picks up a complex issue, the Decomposition Engine runs first inside a Docker container: an LLM call analyzes the issue body and codebase index, then outputs a structured DAG of sub-tasks. That DAG either gets approved (human gate or auto-approve) and executed in parallel worktrees, or falls back to single-agent execution.

### Architecture: Two-Pass Flow

```
Worker picks up issue #42 (marked decompose:true or heuristic triggers)
  │
  ├─ Pass 1: DECOMPOSITION AGENT (runs in Docker container, full isolation)
  │    • Prompt: issue body + repo context + file index
  │    • Output: JSON DAG { nodes: [{id, task, depends_on, files_hint}] }
  │    • Schema-validated with Zod (reject malformed output)
  │    • Cycle detection reused from src/tracker/sub-issue-dag.ts
  │
  ├─ Validation Gate:
  │    • Node count ≤ maxNodes (configurable, default 8)
  │    • No cycles (DFS from existing detectIssueCycles())
  │    • Autonomy check: if supervised/interactive → human approval gate
  │    • Auto-approve if cost estimate < threshold
  │
  ├─ APPROVED → emit sub-issue DAG → WorktreeRuntime (parallel)
  │
  └─ REJECTED / FALLBACK → single-agent execution (existing Docker path)
```

### Key Design Decisions

**Use the existing Docker container for decomposition, not a new process.** The decomposition agent needs codebase access (files, git log) to produce a meaningful task split. Spinning up a container for decomposition is consistent with the existing pattern for trusted, isolated work.

**Output format is the existing PipelineNode shape.** The decomposition produces a `PipelineDefinition`-compatible structure, reusing `src/pipeline/dag.ts`'s `validateDAG()` and `topologicalSort()`. No new DAG format needed.

**Fallback is always available.** If decomposition produces too many nodes, cycles, or the LLM output fails schema validation, the worker silently falls back to single-agent execution. This keeps the system resilient without human intervention.

### Directory Structure

```
src/decomposition/
  engine.ts       # DecompositionEngine class: analyze(), validate(), emit()
  prompt.ts       # Decomposition prompt template (issue + repo context → DAG JSON)
  validator.ts    # Zod schema for DAG JSON output, cycle detection, node count check
  approval.ts     # Human approval gate (reuses governance/approval.ts patterns)
  fallback.ts     # Conditions that trigger single-agent fallback
  types.ts        # DecompositionPlan, SubTask, DecompositionResult types
```

### Integration Points

- **Worker** (`src/orchestrator/worker.ts`): checks `issue.labels.includes('decompose')` or `workflowConfig.decompose === true` before calling `DecompositionEngine.analyze(issue, container)`
- **Pipeline DAG** (`src/pipeline/dag.ts`): reuse `topologicalSort()` and `validateDAG()` — decomposition produces PipelineNode[] directly
- **Governance** (`src/governance/approval.ts`): decomposition approval gate uses the same `enterPendingApproval()` / `evaluateAutoApprove()` as the existing pre-dispatch gate
- **Storage** (`src/storage/schema.ts`): new `decomposition_plans` table persists the generated DAG for audit and re-planning

---

## Component 2: Worktree Runtime

### Responsibility

For approved decomposition plans, the Worktree Runtime creates one `git worktree` per DAG node, spawns a Node.js `claude-code` CLI process (not Docker) per worktree, manages concurrency (slot-weighted), and merges results back into a single branch with conflict detection.

### Why Worktrees (Not Docker) for Sub-tasks

Docker containers have ~2-5 second startup overhead per container plus memory allocation. For sub-tasks that split a single issue into 4-6 parallel slices, that overhead adds up to 10-30 seconds before any agent work begins. Worktrees with a spawned process start in under 500ms, share the host `.git` directory (no clone), and produce lightweight branches that merge cleanly via `git merge-tree`.

The trade-off: worktrees are trusted execution paths only. The decomposition agent (first pass) runs in full Docker isolation to analyze the codebase. The sub-task agents run in worktrees because the task scope is already validated and constrained by the decomposition plan.

### Architecture: Branch-Per-Node with Merge

```
DecompositionPlan { nodes: [A, B, C] } where B depends on A
  │
  ├─ Topological sort → execution layers: [ [A], [B, C] ]
  │
  ├─ Layer 1: node A
  │    • git worktree add /tmp/forgectl-ws-42-A feature/issue-42-A
  │    • spawn: claude -p "<task A prompt>" in /tmp/forgectl-ws-42-A
  │    • await completion
  │    • git merge-tree base A → detect conflicts (dry run)
  │    • if clean: merge to integration branch
  │    • if conflict: record conflict, trigger re-plan or manual resolution
  │
  ├─ Layer 2: nodes B and C (parallel, both depend on A output)
  │    • git worktree add /tmp/forgectl-ws-42-B feature/issue-42-B
  │    • git worktree add /tmp/forgectl-ws-42-C feature/issue-42-C
  │    • spawn B and C concurrently (Promise.all with slot limit)
  │    • intermediate merge after each completes
  │
  └─ Final: git merge-tree on integration branch → PR
```

### Conflict Detection Strategy

Use `git merge-tree <base> <branch-A> <branch-B>` in dry-run mode before merging. This is a three-way merge simulation with no side effects on the working tree. If `git merge-tree` exits non-zero, conflict markers are present in the output — parse to identify conflicted files.

On conflict: post a structured comment on the parent issue listing conflicted files and which sub-tasks produced them, then either (a) re-plan just the conflicted nodes or (b) fall back to sequential execution for those nodes.

### Worktree Cleanup

Worktrees are removed after merge via `git worktree remove --force <path>`. This is registered as an `afterHook` equivalent — cleanup runs whether the sub-task succeeds or fails. Cleanup failures are warned and logged but do not fail the run.

### Directory Structure

```
src/worktree/
  manager.ts      # WorktreeManager: create, remove, list, cleanup on crash
  executor.ts     # WorktreeExecutor: spawn agent process in worktree, stream output
  merger.ts       # WorktreeMerger: merge-tree dry run, conflict detection, integration branch
  scheduler.ts    # Parallel sub-task scheduler: slot management, concurrency limits
  types.ts        # WorktreeHandle, SubTaskResult, MergeResult, ConflictReport
```

### Integration Points

- **Agent spawn** (`src/agent/`): WorktreeExecutor spawns `claude` or `codex` CLI directly as a Node.js child process (no Docker). Uses the same `agentConfig.type`, `agentConfig.model`, `agentConfig.flags` from the existing config.
- **Workspace manager** (`src/workspace/manager.ts`): worktrees live under the existing workspace path — `wsInfo.path/worktrees/<nodeId>` — so they survive daemon restarts and get picked up by crash recovery.
- **Slot management** (`src/orchestrator/scheduler.ts`): WorktreeScheduler respects the same `config.orchestrator.max_concurrent_slots` limit. Each active worktree counts as one slot.
- **Flight recorder** (`src/storage/repositories/events.ts`): each sub-task emits `worktree_started`, `worktree_completed`, `merge_clean`, `merge_conflict` events to the existing RunEvent infrastructure.

---

## Component 3: Rate Limit Retry Scheduler

### Responsibility

When an agent invocation hits an LLM provider rate limit (HTTP 429, `Retry-After` header, or provider-specific error shapes), the run must not fail immediately. Instead: preserve the workspace, record the retry schedule, release the concurrency slot, and wake the dispatcher when the rate limit window expires.

### Detection Points

Rate limit errors can surface in three locations within the existing stack:

1. **Agent CLI invocation** (`src/agent/oneshot-session.ts`): Claude Code exits with a non-zero code and stderr containing "rate limit" or "429". The existing `AgentResult.status === 'failed'` path already captures this, but it's currently treated as a generic error for retry.

2. **Tracker adapter fetch** (`src/tracker/github.ts`): Already handles GitHub API rate limits via `rateLimitRemaining` state. No new detection needed here — this is tracker-level, not LLM-level.

3. **Validation commands** (`src/validation/runner.ts`): Validation steps that call external APIs can hit rate limits. Less common but must be caught.

### Architecture: Rate-Limit-Aware Retry Path

```
Worker catches AgentResult { status: 'failed', stderr: '...' }
  │
  ├─ RateLimitDetector.classify(agentResult)
  │    → checks: exit code, stderr patterns, process exit signals
  │    → returns: { isRateLimit: bool, retryAfterMs: number | null }
  │
  ├─ if isRateLimit:
  │    • DO NOT delete workspace (preserve for resume)
  │    • UPDATE runs SET status='rate_limited', retry_at=<timestamp>
  │    • releaseIssue(state, issue.id)  ← frees the slot immediately
  │    • RateLimitRetryScheduler.schedule(issue, retryAfterMs)
  │         → setTimeout (or recoverable timer in SQLite) for retryAfterMs
  │         → on wake: re-add issue to candidate queue (does NOT create new workspace)
  │
  └─ if not rate limit: existing error retry path (exponential backoff)
```

### Workspace Preservation

When a run is rate-limited, the workspace is preserved at `wsInfo.path`. On resume:
- The same `WorkspaceManager.ensureWorkspace(issue.identifier)` returns the existing path (no new clone)
- The agent is re-invoked with the existing workspace state — partial work is preserved
- The dispatcher increments `attempt` but does not reset `retryAttempts` for this specific failure mode (rate limits don't count toward max_retries by default)

### Timer Durability

For rate limit retry timers, the `Retry-After` value can be 60-3600 seconds. The in-memory `setTimeout` approach from `src/orchestrator/retry.ts` is fine for short windows, but crashes lose timers. Solution: persist the scheduled retry in the new `rate_limit_retries` table. On daemon restart, `startupRecovery()` queries this table and restores any pending rate-limit retry timers.

### Directory Structure

```
src/rate-limit/
  detector.ts    # RateLimitDetector: classify AgentResult as rate-limited vs other error
  scheduler.ts   # RateLimitRetryScheduler: schedule resume, persist timer, restore on crash
  types.ts       # RateLimitEntry: issueId, retryAt, workspacePath, attemptCount
```

### Integration Points

- **Worker** (`src/orchestrator/worker.ts`): calls `RateLimitDetector.classify(agentResult)` after agent invocation; returns `{ isRateLimit: true }` to the dispatcher via an extended `WorkerResult` field
- **Dispatcher** (`src/orchestrator/dispatcher.ts`): new branch in `executeWorkerAndHandle()` checks `result.isRateLimit` and delegates to `RateLimitRetryScheduler` instead of the standard retry path
- **Existing retry** (`src/orchestrator/retry.ts`): `cancelRetry()` / `scheduleRetry()` reused by the rate limit scheduler; the new `RateLimitRetryScheduler` wraps these with persistence
- **Storage schema**: new `rate_limit_retries` table — minimal: `(issue_id, workspace_path, retry_at, attempt_count)`
- **Startup recovery** (`src/orchestrator/index.ts` or daemon startup): query `rate_limit_retries WHERE retry_at > now()` and re-arm timers

---

## Component 4: Outcome Learner

### Responsibility

After each run completes (success or failure), the Outcome Learner persists structured lessons to SQLite. Those lessons are injected into future agent prompts for the same repository and issue type — dead ends are flagged, successful approaches are noted. Over time, the agent gets domain-specific context it didn't have on the first run.

### Architecture: Closed-Loop Feedback

```
Run completes (success or failure)
  │
  ├─ OutcomeLearner.record(runId, issue, agentResult, validationResult)
  │    • classifies outcome: success | partial | failure | dead_end
  │    • extracts signals:
  │        - which validation steps passed/failed
  │        - agent stderr patterns (dead-end markers)
  │        - files touched (from git diff summary)
  │        - cost (tokens, dollars)
  │    • persists outcome_lessons row:
  │        { repo, issue_type_labels, outcome_class, lesson_text, files_pattern }
  │
  └─ On NEXT run for same repo:
       OutcomeLearner.query(repo, issue.labels) → RelevantLessons[]
       → prompt.ts injects lessons as a "Prior experience" context block:
           "In previous runs on this repo:
            - Approach X failed (validation: test-suite). Avoid.
            - Files matching src/payment/** require extra care (3 prior failures).
            - Dead end: 'modify package.json version' alone is insufficient."
```

### Lesson Classification

| Outcome Class | Trigger | Lesson Type |
|---------------|---------|-------------|
| `success` | `agentResult.status === 'completed'` AND all validation passes | Positive hint: what worked |
| `partial` | Agent completed but ≥1 validation step failed | Warning: partial approach |
| `failure` | Agent failed or max retries exhausted | Negative hint: what to avoid |
| `dead_end` | Repeated failures on same issue after 2+ attempts, same file set | Strong warning: mark this approach as exhausted |

### Dead-End Detection

A dead end is detected when: (a) the same issue has been attempted 2+ times, (b) the agent is writing to the same set of files each time, and (c) validation keeps failing with the same error. The `dead_end` lesson is highest priority — injected first into the prompt context block.

**Confidence:** MEDIUM. Dead-end detection via file-set overlap is a heuristic that works well for deterministic validation (build/test failures) but may miss semantic dead-ends (the agent writing different code that produces the same logical error). This is acceptable for v5.0; semantic dead-end detection requires LLM-assisted lesson analysis (out of scope).

### Schema Addition

```typescript
// In src/storage/schema.ts:
export const outcomeLessons = sqliteTable('outcome_lessons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  repo: text('repo').notNull(),            // "owner/repo" for scoping
  issueLabels: text('issue_labels'),        // JSON: string[] for matching
  outcomeClass: text('outcome_class').notNull(), // 'success'|'partial'|'failure'|'dead_end'
  lessonText: text('lesson_text').notNull(),
  filesPattern: text('files_pattern'),      // JSON: string[] of touched file paths
  validationFailures: text('validation_failures'), // JSON: failed step names
  costCents: integer('cost_cents'),
  createdAt: text('created_at').notNull(),
});
```

### Lesson Injection in Prompt Builder

**Modified file:** `src/context/prompt.ts`

```typescript
// After existing context assembly:
if (config.learning?.enabled !== false) {
  const lessons = await outcomeLearner.query(repo, issue.labels);
  if (lessons.length > 0) {
    context.priorExperience = formatLessons(lessons);
    // Injected as a distinct section before the task:
    // "Prior experience on this repository: ..."
  }
}
```

### Directory Structure

```
src/learning/
  learner.ts     # OutcomeLearner: record(), query(), detectDeadEnd()
  classifier.ts  # Outcome classification logic
  formatter.ts   # Format lessons into prompt context block
  types.ts       # Lesson, OutcomeClass, LessonQuery types
```

### Integration Points

- **Worker** (`src/orchestrator/worker.ts`): calls `OutcomeLearner.record()` after run completes — fire-and-forget, errors swallowed (same pattern as EventRecorder)
- **Prompt builder** (`src/context/prompt.ts`): calls `OutcomeLearner.query()` during `buildPrompt()` to inject prior lessons
- **Flight recorder** (`src/storage/repositories/events.ts`): outcome recording emits a `lesson_persisted` event to the audit trail
- **Storage schema**: new `outcome_lessons` table (see above)

---

## Data Flow: Full v5.0 Path

### Path A: Standard Issue (No Decomposition)

```
Tracker poll / GitHub webhook → issue #42
  → OrchestratorScheduler: candidate selection, slot claim
  → OutcomeLearner.query(repo, issue.labels) → [RelevantLessons]
  → prompt.ts: inject lessons into agent prompt
  → Worker → Docker container → Claude Code agent
  → AgentResult:
      if rate_limited:
          → RateLimitDetector.classify() → true
          → RateLimitRetryScheduler.schedule(issue, retryAfterMs)
          → workspace preserved, slot released
      else:
          → validation loop → output collection
          → OutcomeLearner.record(runId, outcome)
          → GitHub comment / PR creation
```

### Path B: Decomposable Issue

```
Tracker poll → issue #42 (label: decompose OR heuristic triggers)
  → Worker: detect decomposable → run DecompositionEngine
  → DecompositionEngine:
      → Docker container (isolated): LLM call → DAG JSON
      → Zod validate → cycle detection (detectIssueCycles())
      → Approval gate (governance): auto or human
      → APPROVED → DecompositionPlan { nodes: [A, B, C] }
  → WorktreeRuntime:
      → topologicalSort() → [[A], [B, C]]
      → Layer 1: worktree A → spawn claude → await
          → merge-tree dry run → clean → merge to integration branch
      → Layer 2: worktrees B and C in parallel
          → merge-tree per node → detect conflicts → record
      → Final integration branch → PR
  → OutcomeLearner.record(runId, decomposition outcome)
```

### Path C: Rate Limit Recovery

```
Worker: rate limit detected during agent invocation
  → WorkerResult { isRateLimit: true, retryAfterMs: 60000 }
  → Dispatcher: RateLimitRetryScheduler.schedule(issue, 60000)
      → UPDATE rate_limit_retries SET retry_at = now + 60s
      → releaseIssue(state, issue.id) — slot freed
      → setTimeout(60000, () => requeueIssue(issue))
  [60 seconds later]
  → Scheduler: requeueIssue(issue) → candidate queue
  → Worker: WorkspaceManager.ensureWorkspace() → same path (no re-clone)
  → OutcomeLearner: prior lesson "rate limited on attempt 1" injected
  → Normal agent execution continues
```

---

## Schema Extensions (Additive)

All additions to `src/storage/schema.ts` are new tables only — no changes to existing table columns.

```typescript
// New table 1: Decomposition plans (audit + re-planning)
export const decompositionPlans = sqliteTable('decomposition_plans', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  issueId: text('issue_id').notNull(),
  status: text('status').notNull(), // 'pending_approval' | 'approved' | 'rejected' | 'fallback'
  planJson: text('plan_json').notNull(), // JSON: PipelineDefinition (nodes + deps)
  nodeCount: integer('node_count').notNull(),
  approvedBy: text('approved_by'),
  fallbackReason: text('fallback_reason'),
  createdAt: text('created_at').notNull(),
});

// New table 2: Rate limit retry state (for crash-safe timer recovery)
export const rateLimitRetries = sqliteTable('rate_limit_retries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  issueId: text('issue_id').notNull(),
  workspacePath: text('workspace_path').notNull(),
  retryAt: text('retry_at').notNull(),    // ISO timestamp
  attemptCount: integer('attempt_count').notNull().default(1),
  resolvedAt: text('resolved_at'),        // null until retried or cancelled
});

// New table 3: Outcome lessons
export const outcomeLessons = sqliteTable('outcome_lessons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  repo: text('repo').notNull(),
  issueLabels: text('issue_labels'),
  outcomeClass: text('outcome_class').notNull(),
  lessonText: text('lesson_text').notNull(),
  filesPattern: text('files_pattern'),
  validationFailures: text('validation_failures'),
  costCents: integer('cost_cents'),
  createdAt: text('created_at').notNull(),
});
```

---

## Patterns to Follow

### Pattern 1: Additive Subscriber for Outcome Recording

**What:** `OutcomeLearner.record()` is called at the end of `executeWorkerAndHandle()` as a fire-and-forget side effect, matching the EventRecorder pattern.

**Why:** Outcome recording must never block or fail the worker's main path. Swallowed errors, same as the EventRecorder.

```typescript
// In dispatcher.ts executeWorkerAndHandle():
if (outcomeLearner) {
  outcomeLearner
    .record(runId, issue, result.agentResult, result.validationResult)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('dispatcher', `Outcome recording failed (ignored): ${msg}`);
    });
}
```

### Pattern 2: Decomposition Engine as Pre-Worker Step in Existing Worker

**What:** DecompositionEngine runs as the first step inside `executeWorker()`, before `prepareExecution()` for sub-tasks. It decides the execution path (worktree vs Docker single-agent).

**Why:** Keeping decomposition inside the worker maintains the existing claim/release lifecycle. The scheduler doesn't need to know about decomposition — it just dispatches issues.

```typescript
// In worker.ts executeWorker():
if (shouldDecompose(issue, workflowConfig)) {
  const decompositionResult = await decompositionEngine.analyze(issue, container, logger);
  if (decompositionResult.approved) {
    return await worktreeRuntime.execute(decompositionResult.plan, workspaceManager, logger);
  }
  // fallback: continue to existing single-agent path
}
```

### Pattern 3: Rate Limit as a First-Class Worker Exit Code

**What:** `WorkerResult` gains an `isRateLimit` boolean. The dispatcher's error handler branch checks this first before entering the standard retry logic.

**Why:** Rate limit retries are fundamentally different from agent errors. They preserve workspace state, release slots immediately (not after backoff), and respect the provider's `Retry-After`. Treating them as generic errors wastes the retry budget.

```typescript
// Extended WorkerResult:
export interface WorkerResult {
  agentResult: AgentResult;
  comment: string;
  isRateLimit?: boolean;    // NEW
  rateLimitRetryMs?: number; // NEW: Retry-After value from provider
  // ... existing fields
}
```

### Pattern 4: Lessons as Prompt Context Section (Not System Prompt Injection)

**What:** Prior lessons are injected as a dedicated `## Prior Experience` section in the task prompt, not into the system prompt.

**Why:** System prompts are static per-workflow. Lessons are dynamic per-issue and per-repo. Injecting lessons into the task context keeps the system prompt clean and makes lessons visible in the audit trail (they're part of the logged prompt).

### Pattern 5: Optional Dependency Injection for New Components

**What:** `OutcomeLearner`, `DecompositionEngine`, and `RateLimitRetryScheduler` are passed as optional parameters through `dispatchIssue()`, matching the existing pattern for `SubIssueCache`, `governance`, and `githubContext`.

**Why:** This maintains backward compatibility. Existing tests and `forgectl run` command don't need these components — they just work without them. The daemon initializes them when the features are enabled in config.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Spawning Docker Containers for Worktree Sub-Tasks

**What:** Using full Docker containers for each parallel sub-task in a decomposition plan.

**Why it's wrong:** Docker startup overhead (~2-5s per container) defeats the purpose of parallel decomposition for sub-tasks that take 30-60 seconds each. Plus, container-per-sub-task requires managing N container lifecycles, networks, and credential mounts simultaneously.

**Do this instead:** Docker for decomposition analysis (full isolation, codebase access). Node.js child process in git worktree for sub-task execution (trusted context, 500ms startup).

### Anti-Pattern 2: Building a New DAG Engine for Decomposition Plans

**What:** Creating a parallel task DAG executor separate from the existing `src/pipeline/` infrastructure.

**Why it's wrong:** The pipeline module already has `topologicalSort()`, `validateDAG()`, `PipelineNode` types, and parallel slot management. Building a parallel implementation doubles maintenance.

**Do this instead:** Decomposition produces `PipelineNode[]`. WorktreeRuntime uses the existing `topologicalSort()` and runs nodes in layers. The pipeline module's executor isn't reused directly (it's Docker-based), but its DAG logic is.

### Anti-Pattern 3: Persisting Full Prompt/Response in Outcome Lessons

**What:** Storing the full agent prompt and response in the `outcome_lessons` table for "rich context."

**Why it's wrong:** Full agent responses are 10-100KB each. Storing them for every run balloons the SQLite database. The signal-to-noise ratio is low: 95% of the response is code changes that are irrelevant to the lesson.

**Do this instead:** Store only structured signals: validation step outcomes, file patterns touched, and a LLM-generated 1-3 sentence lesson summary (extracted by the lesson classifier, not the full response).

### Anti-Pattern 4: Rate Limit Retries Count Against max_retries

**What:** Incrementing `retryAttempts` when a run is rate-limited.

**Why it's wrong:** Rate limits are infrastructure limits, not agent failures. Burning the agent's retry budget on rate limit recoveries prevents it from retrying actual errors (logic bugs, missing dependencies).

**Do this instead:** Maintain a separate `rateLimitAttempts` counter. Rate limit retries only count against a separate `max_rate_limit_retries` config (default: 5). Max retries remain for agent-caused failures.

### Anti-Pattern 5: Outcome Lessons as Global Knowledge

**What:** Injecting lessons from ANY previous run on any repo, not scoping to the current repo.

**Why it's wrong:** A lesson from a Python Django codebase is noise in a TypeScript project. Global lessons generate false confidence and increase prompt size with irrelevant hints.

**Do this instead:** Scope lessons by `repo` (owner/repo string) and secondarily by `issueLabels` overlap. Query: "lessons from THIS repo with at least 1 matching label." Repo-scoped lessons are far more likely to be actionable.

---

## Build Order (Dependency Graph)

The four features are mostly independent but share two dependency layers: storage schema extensions and worker integration. This gives a natural build order:

```
Phase 1: Storage Schema Extensions
  • Add decomposition_plans, rate_limit_retries, outcome_lessons tables
  • New repositories: decomposition.ts, rate-limits.ts, lessons.ts
  • No behavior change — just schema and repository functions
  • Dependency: NONE (foundation for all v5.0 features)

Phase 2: Rate Limit Retry Scheduler          [LOW complexity]
  • src/rate-limit/detector.ts + scheduler.ts
  • Modify: worker.ts (detect), dispatcher.ts (route), retry.ts (schedule)
  • Startup recovery: restore pending rate-limit timers from DB
  • Dependency: Phase 1 (rate_limit_retries table)
  • WHY FIRST: Lowest complexity, immediate user value (fewer failed runs),
    and tests the storage extension pattern before harder features

Phase 3: Outcome Learner                     [MEDIUM complexity]
  • src/learning/: learner.ts, classifier.ts, formatter.ts
  • Modify: dispatcher.ts (record after completion), prompt.ts (inject lessons)
  • Dependency: Phase 1 (outcome_lessons table)
  • WHY THIRD: Additive subscriber pattern, low coupling.
    Lessons accumulate over time; earlier it's built, more runs it captures.
    Can parallelize with Phase 2.

Phase 4: Worktree Runtime                    [MEDIUM-HIGH complexity]
  • src/worktree/: manager.ts, executor.ts, merger.ts, scheduler.ts
  • Modify: worker.ts (route to worktree when plan approved)
  • git worktree lifecycle, process spawn, merge-tree conflict detection
  • Dependency: Phase 1, workspace manager (existing)
  • Produces sub-tasks as independent runnable units

Phase 5: Decomposition Engine                [HIGH complexity]
  • src/decomposition/: engine.ts, prompt.ts, validator.ts, approval.ts
  • Modify: worker.ts (detect decomposable, invoke engine)
  • LLM call inside Docker container → Zod-validated DAG JSON → approval gate
  • Dependency: Phase 1, Phase 4 (Worktree Runtime for parallel execution)
  • WHY LAST: Highest complexity, requires Phase 4 to execute approved plans
```

**Parallelization opportunity:** Phase 2 (Rate Limit Retry) and Phase 3 (Outcome Learner) can be built concurrently — they touch different code paths. Phase 4 and 5 must be sequential (5 depends on 4).

---

## Integration Points Summary

| Where | What Changes | How |
|-------|-------------|-----|
| `src/orchestrator/worker.ts` | Entry point for decompose detection and rate limit classification | New pre-agent steps: decompose check, RateLimitDetector call |
| `src/orchestrator/dispatcher.ts` | Route rate limit outcomes and record lessons | New branch after worker result; OutcomeLearner.record() fire-and-forget |
| `src/orchestrator/retry.ts` | Rate limit retry scheduling | Extend scheduleRetry() or delegate to RateLimitRetryScheduler |
| `src/context/prompt.ts` | Inject outcome lessons | OutcomeLearner.query() result appended as prompt section |
| `src/storage/schema.ts` | Three new tables | Additive only — no existing column changes |
| `src/daemon/server.ts` | Initialize new components on startup | Instantiate OutcomeLearner, RateLimitRetryScheduler, load pending timers |
| `src/pipeline/dag.ts` | Reused (not modified) | topologicalSort() and validateDAG() used by Worktree scheduler |
| `src/tracker/sub-issue-dag.ts` | Reused (not modified) | detectIssueCycles() used by DecompositionEngine validator |
| `src/governance/approval.ts` | Reused (not modified) | enterPendingApproval() used by DecompositionEngine approval gate |
| `src/config/schema.ts` | New config sections | decomposition, worktree, learning config blocks |
| `src/workflow/types.ts` | New WORKFLOW.md fields | `decompose: boolean`, `learning: { enabled: boolean }` |

---

## Scalability Considerations

| Concern | Current (v3.0) | v5.0 Impact | Mitigation |
|---------|---------------|-------------|-----------|
| Worktree disk usage | N/A | Each worktree ~50-200MB per sub-task | Aggressive cleanup (remove worktree after merge regardless of success/fail) |
| Decomposition LLM cost | N/A | 1 extra LLM call per decomposable issue | Use cheaper model for decomposition (claude-haiku or similar); configurable model override |
| Lesson table size | N/A | 1 row per run, ~500 bytes each | Trivial: 10K runs = 5MB. No concern for single-machine |
| Rate limit retry timers | N/A | N timers in memory for rate-limited issues | Bounded by max_concurrent_slots × runs; at most ~20 pending timers |
| Parallel worktree processes | N/A | N Node.js processes per decomposition | Slot-weighted: same max_concurrent_slots cap. Each worktree process = 1 slot |
| git merge-tree concurrency | N/A | Sequential per merge (git is single-writer) | Merge operations are fast (<1s); don't parallelize merges, parallelize agent work |

---

## Sources

- [ComposioHQ agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — Planner/Executor dual-layer decomposition, worktree-per-task pattern, HIGH confidence
- [git worktrees for parallel AI agents (Upsun)](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — Worktree isolation rationale and limitations (shared .git, race conditions on shared state), MEDIUM confidence
- [How we built parallel agents with git worktrees (DEV)](https://dev.to/getpochi/how-we-built-true-parallel-agents-with-git-worktrees-2580) — Branch-per-task cleanup patterns, MEDIUM confidence
- [Clash: conflict detection for worktrees](https://github.com/clash-sh/clash) — git merge-tree dry-run for early conflict surfacing, HIGH confidence (official git docs confirm)
- [git-merge-tree documentation](https://git-scm.com/docs/git-merge-tree) — Three-way merge simulation without side effects, HIGH confidence
- [greyhaven-ai/autocontext](https://github.com/greyhaven-ai/autocontext) — Closed-loop outcome learning: lesson persistence, validation gating, curator-based quality filter, MEDIUM confidence
- [LLM tool-calling rate limits in production (Medium)](https://medium.com/@komalbaparmar007/llm-tool-calling-in-production-rate-limits-retries-and-the-infinite-loop-failure-mode-you-must-2a1e2a1e84c8) — 429 detection patterns, Retry-After header, workspace preservation on rate limit, MEDIUM confidence
- [TDAG: Dynamic Task Decomposition and Agent Generation (arXiv)](https://arxiv.org/abs/2402.10178) — DAG-based task decomposition with per-node subagent generation, HIGH confidence (peer-reviewed)
- [Task decomposition for coding agents (atoms.dev)](https://atoms.dev/insights/task-decomposition-for-coding-agents-architectures-advancements-and-future-directions/a95f933f2c6541fc9e1fb352b429da15) — Hierarchical fallback mechanisms for decomposition failure, MEDIUM confidence
- [Mastering retry logic agents 2025 (sparkco.ai)](https://sparkco.ai/blog/mastering-retry-logic-agents-a-deep-dive-into-2025-best-practices) — Exponential backoff with jitter, adaptive error handling patterns, MEDIUM confidence
- [forgectl v3.0 source: src/tracker/sub-issue-dag.ts] — Existing DFS cycle detection, reusable for decomposition DAG validation, HIGH confidence (own codebase)
- [forgectl v3.0 source: src/pipeline/dag.ts] — Existing topologicalSort() and validateDAG(), reusable for worktree scheduling, HIGH confidence (own codebase)

---

*Architecture research for: forgectl v5.0 Intelligent Decomposition*
*Researched: 2026-03-14*
