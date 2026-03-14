# Pitfalls Research

**Domain:** Adding multi-agent delegation, conditional/loop pipeline nodes, and pipeline self-correction to an existing TypeScript orchestrator (forgectl v2.1)
**Researched:** 2026-03-12
**Confidence:** HIGH (code-verified against existing src/, supplemented by current ecosystem research)

---

## Context: What Already Exists

forgectl v2.0 ships with:
- `OrchestratorState` with in-memory `claimed`/`running`/`retryAttempts` maps, `SlotManager` for slot-based concurrency
- `PipelineExecutor` with static DAG (`validateDAG`, `topologicalSort`), `maxParallel` cap, `inFlight` map, checkpoint hydration
- `runValidationLoop` in `src/validation/runner.ts` — reruns ALL steps from top on any failure, single container only
- `executionLocks` table in SQLite (unique per `lockType`+`lockKey`), `runs` and `pipelineRuns` tables
- `GovernanceOpts` with `autonomy` levels, pre- and post-execution approval gates
- `dispatchIssue` is fire-and-forget (`void executeWorkerAndHandle(...)`) — no return value, no child tracking

All pitfalls below are grounded in this specific code.

---

## Critical Pitfalls

### Pitfall 1: Slot Budget Exhaustion — Children Eat Parent's Slots

**What goes wrong:**
A lead agent dispatches 8 child workers for subtasks. Each child claims a slot from the same global `SlotManager`. The orchestrator's `maxConcurrent` is set to 5. The lead itself holds 1 slot. Three more unrelated issues are waiting. The 5 child dispatches saturate all slots. The lead is blocked waiting for children who are themselves waiting because slots are full, creating a deadlock where the system is "full" but doing nothing useful.

The existing `dispatchIssue` is fire-and-forget — it calls `claimIssue(state, issue.id)` and immediately fires `void executeWorkerAndHandle(...)`. There is no concept of a parent slot that children should be charged against.

**Why it happens:**
Developers model the slot as "one worker = one slot" without accounting for the tree structure. The lead's maxChildren budget (e.g., 3) is defined but never translated into a slot reservation at the time the lead is dispatched. Children are dispatched like top-level issues — they contend for the same global pool.

**How to avoid:**
- Introduce a two-tier slot system: "lead slots" (for issues directly from the tracker) and "child slots" (for delegated subtasks, reserved at lead dispatch time)
- When a lead is dispatched with `maxChildren: N`, pre-reserve `N` slots from a child-slot pool before firing any workers
- Children should only claim from the reserved child pool, not from the global `SlotManager`
- Implement a `ChildSlotBudget` type on `WorkerInfo` that tracks `maxChildren`, `dispatched`, and `completed` counts
- Enforce depth limit (max 2) at dispatch time in `dispatchIssue`: if the dispatching agent is itself a child, reject further delegation

**Warning signs:**
- `state.running.size` equals `slotManager.getMax()` but no progress (all slots held by leads waiting for unavailable child slots)
- Logs showing "child dispatch attempted, no slots available" repeated indefinitely
- `maxChildren` config property added to schema but `dispatchIssue` reads it without routing children to a separate pool

**Phase to address:** Phase introducing multi-agent delegation (child dispatch wiring)

---

### Pitfall 2: OrchestratorState Is In-Memory — Child Relationships Vanish on Restart

**What goes wrong:**
A lead agent dispatches 3 child workers. The daemon restarts (or crashes). `OrchestratorState` is rebuilt from scratch — `claimed`, `running`, `retryAttempts` are all empty Maps. The existing v2.0 crash recovery in `src/durability/recovery.ts` resumes individual runs from SQLite, but it has no concept of parent/child relationships. On restart, the lead and its children resume as independent, unrelated runs. The `maxChildren` budget is lost. A new lead picks up the same issue and dispatches 3 more children, doubling the work.

The existing `runs` schema has no `parentRunId` or `childOf` column. `pipelineRuns` has no relation to orchestrator-level delegation.

**Why it happens:**
The v2.0 durability model was designed for single-worker runs (`executeWorker` → one run per issue). Multi-agent delegation introduces a tree of runs that must survive restarts as a unit, not as individual orphaned runs.

**How to avoid:**
- Add `parentRunId` and `depth` columns to the `runs` table schema (Drizzle migration required)
- Add `maxChildren` and `childrenDispatched` integer columns to `runs` for budget enforcement across restarts
- The `DelegationRepository` should provide atomic `claimChildSlot(parentRunId): boolean` that checks and decrements in a single `UPDATE` with `WHERE children_dispatched < max_children`
- Recovery code must query for "runs with a parentRunId that were in-flight" and restore the parent's `WorkerInfo` with the correct child count before resuming children
- Test the restart scenario explicitly: dispatch lead + 2 children, SIGKILL daemon, restart, verify no duplicate dispatch

**Warning signs:**
- `runs` table missing `parentRunId` column after "delegation is implemented"
- Recovery tests only covering single-run restart, not lead+children restart
- Log showing parent issue re-dispatched while children are still running after restart

**Phase to address:** Phase introducing multi-agent delegation (schema + recovery wiring)

---

### Pitfall 3: Shared Workspace Contamination Between Lead and Children

**What goes wrong:**
A lead agent and its child workers all share the same workspace directory (the issue's `workspacePath` from `WorkspaceManager`). Child agent A writes to `src/feature-a.ts`. Child agent B reads the workspace to understand context — but picks up A's incomplete, mid-write files. Child B then generates code that depends on A's API before A has committed. The lead reads the final workspace and sees a broken intermediate state.

The existing `WorkspaceManager.ensureWorkspace(issue.identifier)` returns the same path for all workers on the same issue. There is no per-child isolation.

**Why it happens:**
The workspace model was designed for one agent per issue. The path is keyed by `issue.identifier`, so all children of the same issue naturally share the same directory. Git branches provide some isolation for output, but the working directory files are shared during execution.

**How to avoid:**
- Each child worker must get its own isolated workspace subdirectory: `{issueWorkspace}/children/{childId}/`
- Alternatively, use Git worktrees: the existing repo is the parent workspace, each child gets `git worktree add {path} -b {childBranch}` — this is the pattern that Cursor and other parallel agent tools use in 2025
- The lead reads child outputs only through their completed checkpoints (which the pipeline executor already does for DAG nodes via `resolveNodeInput`) — never from the live working directory
- Children should not write directly to the parent workspace; they write to their own isolated area, and the lead merges on completion
- The existing fan-in logic in `PipelineExecutor.prepareFanInBranch` is the right model — adapt it for orchestrator-level delegation

**Warning signs:**
- `WorkspaceManager.ensureWorkspace` called with same `identifier` for both lead and children
- No `children/{childId}` or `worktree/` directory structure in workspace paths
- Child agents writing directly to `{issueWorkspace}/src/` instead of an isolated area

**Phase to address:** Phase introducing multi-agent delegation (workspace isolation)

---

### Pitfall 4: Conditional Branch Evaluation Breaks Static DAG Assumptions

**What goes wrong:**
The existing `PipelineExecutor` validates the entire DAG at construction time (`validateDAG`, `topologicalSort`, `collectAncestors`). These functions assume the node graph is fixed. When conditional nodes (`if/else`) are added, the actual execution path is only known at runtime — but the executor has already pre-computed topological order over all nodes, including branches that should be skipped.

Concretely: the executor iterates `order` (a pre-computed topological sort of ALL nodes). A conditional `if`-branch node whose condition is false still appears in `order`. The executor checks `selection.executeNodes.has(nodeId)` to skip it, but this set is also pre-computed at construction time, not evaluated dynamically. Runtime condition evaluation can't change which nodes appear in `inFlight` scheduling.

**Why it happens:**
Kahn's algorithm and DFS topological sort naturally handle static DAGs. Conditional branching requires a fundamentally different execution model: the graph shape is not known until parent nodes complete and their outputs are evaluated. Developers try to bolt conditions onto the existing static executor without changing the core scheduling loop.

**How to avoid:**
- The execution loop in `PipelineExecutor.execute()` must move from pre-computed `order` to a ready-queue model: nodes become eligible only when all their dependencies complete AND any conditional guard evaluates true
- Introduce a `ConditionEvaluator` that accepts node output and returns `{ branch: 'then' | 'else' | 'skip' }` before downstream nodes are scheduled
- The `NodeExecution.status` already has `"skipped"` — extend the `skipReason` to distinguish "skipped by condition" from "skipped by rerun selection"
- Checkpoint hydration must skip nodes that were conditionally skipped (not just those that were ancestors of `fromNode`)
- The `validateDAG` static check must still verify structural validity (no cycles, all deps exist) but should not validate condition reachability — conditions are runtime, not static

**Warning signs:**
- `topologicalSort` called once at the start of `execute()` and never revisited as conditions evaluate
- Condition evaluation happens inside `executeNode` after the node has already been scheduled in `inFlight`
- Tests only cover the "condition is always true" case, not "condition evaluates false at runtime"

**Phase to address:** Phase introducing conditional pipeline nodes

---

### Pitfall 5: Loop Nodes Create Implied Cycles — DAG Invariant Is Violated

**What goes wrong:**
The `validateDAG` function explicitly detects cycles as errors. A `loop-until-condition` node conceptually creates a back-edge (re-run the same node or subgraph until a condition is met). Developers implement this by adding a loop node that lists its own upstream nodes in `depends_on` to re-trigger them — immediately failing the cycle detector. Alternative: the developer adds a synthetic "retry" edge from downstream back to upstream, also a cycle.

Even if the loop is modeled as a counter (run node N up to K times), the current executor has no mechanism to re-schedule a node that has already moved to `"completed"` or `"failed"` status.

**Why it happens:**
DAGs by definition are acyclic. Loops require cycles. The tension is architectural: you cannot add true cycles to a DAG executor without breaking its core invariant. Teams either break the DAG invariant (causing infinite loops or crashes in cycle detection), or they try to "unroll" the loop at definition time (losing the ability to decide iteration count at runtime).

**How to avoid:**
- Model loops as a special node type (`LoopNode`) that the executor handles as a meta-node, not as multiple graph nodes. The loop node owns its own internal mini-executor that runs its body subgraph K times (or until condition), then reports a single `"completed"` status to the outer DAG
- The outer DAG sees: `body-start → loop-node → downstream`, where `loop-node` is opaque to the DAG's topological sort
- Maximum iteration count (`maxIterations`) must be a hard limit, not a soft suggestion — the executor enforces it before the condition evaluator is even called
- Each iteration must create a new checkpoint with its iteration index, so crash recovery can resume from the last completed iteration, not from iteration 1
- Validate that loop body subgraphs have no back-edges to nodes outside the loop — enforce loop scope

**Warning signs:**
- `validateDAG` is disabled or modified to "allow cycles in loop nodes" instead of modeling loops differently
- Loop iteration count is unbounded or only bounded by a timeout (not a hard iteration cap)
- Loop body completion uses the existing node `"completed"` status, causing the next-ready-node logic to never re-schedule it

**Phase to address:** Phase introducing conditional/loop pipeline nodes

---

### Pitfall 6: Self-Correction Loop Has No Convergence Guarantee — "Loop of Death"

**What goes wrong:**
The self-correction pattern is: run tests → if fail, invoke fix agent → rerun tests → repeat. The existing `runValidationLoop` already implements this for single-container runs (lines 47-100 in `src/validation/runner.ts`). The problem is extending this to pipeline-level self-correction, where the fix agent is a separate pipeline node with its own container lifecycle.

Without a convergence guard, the system enters what practitioners call the "loop of death": the fix agent produces a change, the test node re-runs, the same test fails (or a different test breaks due to the fix), the fix agent runs again, ad infinitum. Each iteration spawns a full container, invokes an LLM, and writes to the workspace — burning cost and time with no progress.

The existing validation loop uses `maxRetries = Math.max(...steps.map(s => s.retries))` — this is per-step, not cumulative. A self-correction pipeline loop with no analogous hard cap will iterate indefinitely.

**Why it happens:**
Self-correction is appealing because it mirrors human debugging. Teams model it as "retry until success" without specifying what "success" looks like in finite terms, or what "failure to converge" looks like. The fix agent is trusted to make progress — but LLMs can regress, reintroduce the same bugs, or loop through a cycle of fixes that cancel each other out.

**How to avoid:**
- Enforce a `maxIterations` hard cap on every self-correction loop — no exceptions. The existing `runValidationLoop` pattern of `while (attempt <= maxRetries)` is correct; replicate it at pipeline level
- Track the "best score" across iterations (e.g., number of passing tests), not just the most recent result. If the latest iteration is worse than a previous one, surface the best result rather than the most recent
- Implement a "no-progress" detector: if two consecutive fix attempts produce identical test output (same failing tests, same error messages), abort the loop — the agent is stuck
- Assign a cumulative token/cost budget to the self-correction loop, not just the individual iterations. If the loop's total spend exceeds the budget, abort and report the last-best result
- Write the "loop aborted: max iterations reached" event to the flight recorder with full iteration history so the human can understand what was tried

**Warning signs:**
- Self-correction loop node has no `maxIterations` configuration field in its schema
- Pipeline runs table shows the same pipeline run ID with growing `nodeStates` but no `completedAt` for hours
- No "best result tracking" — the self-correction loop only stores the final result, not intermediate scores
- Token cost growing linearly per-iteration with no budget enforcement on the loop as a whole

**Phase to address:** Phase introducing pipeline self-correction

---

### Pitfall 7: Fix Agent Overwrites Test Agent's Output — Shared Git Branch Contamination

**What goes wrong:**
The self-correction pattern uses multiple pipeline nodes: a `test-runner` node and a `fix-agent` node. Both are git-mode (`output.mode: "git"`) nodes, each creating their own branch. The fix agent reads the workspace from the test node's branch. After fixing, it commits to its own branch. The `PipelineExecutor.mergeOutputBranchIntoHostRepo` then merges the fix branch back. On the next iteration of the loop, the test node starts fresh from the host repo's main branch — not from the cumulative state of all previous fix iterations.

Worse: if both the fix node and the test node operate on the same workspace bind-mount (the default orchestrator worker path), the fix agent's intermediate uncommitted changes are visible to the test runner before the fix is committed.

**Why it happens:**
The existing pipeline executor's fan-in model was designed for non-looping DAGs. Each node's output is merged once, linearly. A loop introduces a recursive merge requirement: fix-iteration-2 must see the workspace state after fix-iteration-1's merge, not the initial state. The existing `mergeOutputBranchIntoHostRepo` is called once per node completion — not per loop iteration.

**How to avoid:**
- Each self-correction loop iteration must explicitly build on the previous iteration's committed output — the "carry forward" must be explicit, not assumed
- Use Git worktrees or isolated per-iteration workspaces so test-runner and fix-agent operate on snapshotted state, not live working directories
- After each fix iteration, the fix agent's branch must be merged (not just accessible) before the next test-runner iteration begins
- The loop node's internal executor should maintain its own `currentBase` branch that advances after each successful fix commit, so the test runner always sees the cumulative state

**Warning signs:**
- Loop iteration N+1's test runner is launched without waiting for loop iteration N's fix agent to commit and merge
- Git log on the repo shows fix branches from multiple iterations but only the final one merged to main
- Test failures in iteration 3 that were fixed in iteration 1 reappear (indicating the workspace reverted)

**Phase to address:** Phase introducing pipeline self-correction

---

### Pitfall 8: SQLite Write Contention When Many Children Write Simultaneously

**What goes wrong:**
A lead spawns 5 child workers. Each child runs concurrently (`void executeWorkerAndHandle(...)`). Each child writes to SQLite at the end: `runs` table update, `run_events` appends, `run_snapshots` insert, `execution_locks` release. With WAL mode, concurrent reads are fine, but concurrent writes are serialized by SQLite's writer lock. If all 5 children complete within a narrow window and each holds a `BEGIN IMMEDIATE` transaction for their batch of writes, they queue behind each other. Any writer held for >5 seconds hits the `busy_timeout` and throws "database is locked".

The existing `better-sqlite3` setup has `busy_timeout` configured (from v2.0), but child workers completing simultaneously create burst write patterns that didn't exist with single-worker runs.

**Why it happens:**
Single-worker orchestration never produced simultaneous writers — runs are dispatched one-by-one against `SlotManager`, and each run's database writes happen at completion, spaced by execution time. Multi-agent delegation creates synchronized completion windows: all 5 children launched by a lead for the same subtask batch may complete within seconds of each other.

**How to avoid:**
- Keep SQLite write transactions as short as possible — batch all end-of-run writes into a single synchronous `db.transaction()` call rather than multiple separate inserts
- Add jitter to child completion reporting: introduce a random 0-500ms delay before the final SQLite writes in `executeWorkerAndHandle` to desynchronize burst completions
- Monitor `SQLITE_BUSY` errors per-run in the flight recorder — if they appear, the busy_timeout is too low or transactions are too long
- The `execution_locks` table already uses `unique` constraint for `lockType + lockKey` — ensure lock release is in a short transaction, not holding other locks simultaneously

**Warning signs:**
- "database is locked" errors appearing only when child count exceeds 3
- `execution_locks` lock release happening inside the same transaction as event appends and snapshot saves
- No jitter in child completion timing — all children spawned at the same time will complete at approximately the same time

**Phase to address:** Phase introducing multi-agent delegation (child dispatch wiring)

---

### Pitfall 9: Governance Gate Applied Inconsistently to Children

**What goes wrong:**
The existing `GovernanceOpts` with `autonomy` levels (`full`/`semi`/`interactive`/`supervised`) applies a pre-approval gate and post-approval gate in `dispatchIssue` and `executeWorker`. When delegation is added, each child worker goes through `dispatchIssue` with the same governance opts as the lead. Under `supervised` autonomy, each child generates an approval request. A lead with 5 children and `supervised` autonomy generates 5 separate approval requests — one per child — before any work is done. The human receives 5 approval comment threads for what appears to be one task.

Alternatively: governance is wired to the lead only, and children inherit `full` autonomy regardless of the lead's setting, allowing children to bypass oversight gates that the lead was subject to.

**Why it happens:**
`GovernanceOpts` was designed for top-level issue dispatch. Child workers are dispatched via the same `dispatchIssue` pathway, inheriting the same governance opts. The design didn't account for whether governance should apply per-child or once per-delegation-tree.

**How to avoid:**
- Define a clear governance inheritance policy: the lead's pre-approval gate fires once for the entire delegation tree. Children inherit `autonomy: "full"` by default (they're executing on behalf of an already-approved lead)
- The post-approval gate (output review) fires once on the lead's aggregate output, not on each child's output separately
- Optionally: allow per-child governance override via a `childAutonomy` field in the delegation plan, but default to no per-child gates
- Implement the inheritance by passing a `parentApprovalId` on the `GovernanceOpts` for children, which the approval state machine uses to skip pre-approval when a parent approval already exists

**Warning signs:**
- 5 separate approval comment threads created for one delegated task
- Children dispatched with governance opts directly copied from the lead without a "child mode" flag
- Post-approval gate fires on each child's output separately, requiring N human approvals for N children

**Phase to address:** Phase introducing multi-agent delegation (governance integration)

---

### Pitfall 10: Conditional Node Schema Added but Executor Ignores Unknown Node Types

**What goes wrong:**
A `condition` field is added to `PipelineNode` in `src/pipeline/types.ts`. The YAML parser accepts it. But `PipelineExecutor.executeNode` calls `resolveRunPlan` and `executeRun` — neither of which knows about conditions. The conditional node executes as a normal agent node, ignoring the condition field entirely. No error is thrown. Users write pipelines with `if/else` branches expecting conditional behavior, but all branches always execute. The bug is invisible unless tests explicitly verify that the false-branch is skipped.

**Why it happens:**
TypeScript's type system won't catch this at runtime. The `PipelineNode` interface has `condition?: string` — the field exists in the type but `executeNode` doesn't check it because the node execution path (`resolveRunPlan → executeRun`) was written before conditionals existed and only knows about agent tasks.

**How to avoid:**
- Add a node `type` discriminant to `PipelineNode`: `type: "task" | "condition" | "loop"` — this makes the type system enforce handling of each variant
- The executor's node dispatch must switch on `node.type` before calling `resolveRunPlan`. A `"condition"` node evaluates its expression without spawning an agent
- Write a test that asserts: given a pipeline with `condition: "false"`, the false-branch node status is `"skipped"`, not `"completed"`
- The YAML parser must validate that `type: "condition"` nodes have a `condition` field and no `task` field (Zod schema validation)

**Warning signs:**
- `PipelineNode` has optional `condition` field but no `type` discriminant
- `executeNode` has no `switch` or `if` on node type — treats all nodes as agent tasks
- All pipeline tests have `condition: "true"` or omit the condition field entirely

**Phase to address:** Phase introducing conditional pipeline nodes

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Re-use `dispatchIssue` for child workers with same GovernanceOpts | No new dispatch logic | Per-child approval gates, slot exhaustion, no budget inheritance | Never — children need a distinct dispatch path |
| Model loop-until as repeated manual pipeline runs | No executor changes needed | No crash recovery for mid-loop state, no iteration history, manual re-trigger required | Only for prototyping, never production |
| Track parent/child relationships in memory only (OrchestratorState) | No schema change | Relationship lost on restart, children re-dispatched, budget overrun | Never — must be persisted to SQLite |
| Skip workspace isolation, let all children share the lead's workspace | No WorkspaceManager changes | File contamination, non-deterministic agent behavior, race conditions on shared files | Never for parallel children |
| Implement self-correction as "try again forever" with only timeout as stop condition | Simpler initial implementation | Silent cost overrun, loop of death, no progress detection | Never — always add maxIterations hard cap |
| Skip conditional node type discriminant, use optional `condition` field | Backward compatible schema | Executor silently ignores conditions, tests pass incorrectly | Never — type discriminant required from the start |
| Evaluate loop condition inside the fix agent's prompt instead of code | No ConditionEvaluator needed | Agent can hallucinate convergence, condition not machine-verifiable | Never for correctness-critical loops |

---

## Integration Gotchas

Common mistakes when connecting the new features to existing v2.0 subsystems.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Delegation + SlotManager | Children contend for global slots, deadlocking the lead | Two-tier slot pool: global for leads, reserved child pool per lead |
| Delegation + executionLocks | Lead holds lock on issue workspace while children need it | Children get their own lock keys (`issue/{id}/child/{childId}`) |
| Delegation + RunRepository | No `parentRunId` column, runs are unrelated after restart | Schema migration: add `parentRunId`, `depth`, `maxChildren`, `childrenDispatched` |
| Delegation + GovernanceOpts | Children inherit supervised autonomy, generate N approval requests | Children default to `full` autonomy; gate fires once at lead dispatch |
| Conditional nodes + topologicalSort | Pre-computed order schedules all nodes including false branches | Move to ready-queue model; schedule nodes when dependencies complete AND condition true |
| Loop nodes + validateDAG | Back-edges cause cycle detection failure | Model loops as opaque meta-nodes; outer DAG sees single loop node |
| Self-correction + PipelineCheckpoint | No per-iteration checkpoints, restart resumes from iteration 1 | Save checkpoint with `iterationIndex` after each fix commit |
| Self-correction + mergeOutputBranch | Fix iterations don't carry forward — each iteration starts from initial state | Maintain `currentBase` branch that advances after each fix commit |
| Child workspaces + WorkspaceManager | `ensureWorkspace(issue.identifier)` returns same path for all children | Add `ensureChildWorkspace(issueId, childId)` returning isolated subdirectory |
| SQLite + concurrent child completions | Burst writes cause `SQLITE_BUSY` even with WAL mode | Jitter child completion writes; batch all end-of-run writes in single transaction |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Topological sort over full DAG including conditional branches | All branches evaluated even when most are skipped; CPU spike at pipeline start | Ready-queue model evaluates only ready nodes | >20 nodes with heavy branching |
| Lead waits synchronously for all children to complete before proceeding | Lead's slot is held idle while children run; reduces effective concurrency | Lead's slot should be released after delegation, reclaimed when children report back | Leads with >3 children and long-running children |
| No-progress detection absent in self-correction loop | Same fix attempted 20 times at $0.50/iteration = $10 wasted per stuck issue | Compare test output hash between iterations; abort if identical | First time a fix agent gets stuck on the same error |
| Checkpoint saved after every loop iteration including failed ones | SQLite grows rapidly with partial iteration state | Checkpoint only after successful fix commits, not after failed iterations | >10 iterations per loop, >5 concurrent pipelines |
| Fan-in merge on shared host repo within self-correction loop | Git lock contention between loop iterations running on same repo | Per-iteration worktrees; merge only at loop completion | >2 concurrent self-correction pipelines on same repo |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Child agents inherit parent's BYOK credentials without scope reduction | Compromised child (via prompt injection in its task) has full API access | Children receive scoped credentials; lead specifies which tools/APIs each child may use |
| No maxChildren budget enforcement — lead can spawn unlimited agents | Runaway delegation tree exhausts Docker resources, API rate limits, and token budget | Enforce `maxChildren` at `dispatchIssue` time with atomic SQLite decrement |
| Depth limit enforced only in lead prompt, not in code | Agent ignores the instruction and spawns depth-3 children anyway | Enforce depth check in `dispatchIssue` code path: `if (parentDepth >= 2) throw` |
| Self-correction loop exposed to prompt injection via test output | Failing test output is fed back to the fix agent; attacker crafts output that redirects the agent | Sanitize test output before injecting into fix agent prompt; enforce container isolation |
| Conditional evaluation using `eval()` or agent-generated code strings | Arbitrary code execution in the orchestrator process | Conditions must be a restricted expression language (JSON Path, simple comparisons) or enum predicates only |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| One GitHub comment per child worker | 8 children = 8 comments per issue; notification flood | Aggregate child results into a single summary comment on the parent issue |
| Self-correction loop silent until complete | User has no idea how many iterations are running or their cost | Update progress comment after each iteration: "Fix attempt 2/5 — 3 tests still failing" |
| Loop aborted with no explanation | User sees "pipeline failed" with no indication of what was tried | Write an iteration summary to the comment: "Aborted after 5 attempts. Best result: 7/10 tests passing. Final error: [...]" |
| Conditional skip not surfaced in pipeline status | User expects a node to run; it was silently skipped by condition | Mark conditionally-skipped nodes explicitly in the pipeline run view with the condition that evaluated false |
| Delegation tree invisible to user | Lead dispatches 5 children; user sees only the parent issue progress | Show child task list in parent issue comment: "Delegating to 3 subtasks: [list with status badges]" |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Child slot management:** `dispatchIssue` for children uses a separate slot pool, not the global `SlotManager` — verify `state.running.size` never blocks due to children holding parent slots
- [ ] **Parent/child persistence:** `runs` table has `parentRunId`, `depth`, `maxChildren`, `childrenDispatched` — verify restart + recovery still knows which runs are children of which lead
- [ ] **Workspace isolation:** Children write to `{issueWorkspace}/children/{childId}/` or a Git worktree, never directly to `{issueWorkspace}/` — verify with a two-child test writing to the same file path
- [ ] **Depth enforcement:** `dispatchIssue` has a code-level depth check — verify a depth-3 dispatch attempt throws without reaching the agent
- [ ] **Conditional execution:** Pipeline executor moves to ready-queue model — verify a pipeline with `condition: false` shows that branch node as `skipped` in `nodeStates`
- [ ] **Loop hard cap:** Every loop node has a required `maxIterations` field that the executor enforces before evaluating the condition — verify the loop halts at `maxIterations` even when the condition would continue
- [ ] **Convergence detection:** Self-correction loop compares test output between iterations — verify loop aborts when two consecutive iterations produce identical test failure output
- [ ] **Per-iteration checkpoints:** Loop nodes save a checkpoint with `iterationIndex` after each successful fix commit — verify crash recovery resumes from the last completed iteration, not from iteration 1
- [ ] **Fix branch carry-forward:** Self-correction loop's test runner in iteration N+1 sees the committed state from iteration N's fix — verify with a test where fix agent's change is visible to the next test run
- [ ] **Governance inheritance:** Child workers are dispatched with `autonomy: "full"` regardless of lead's governance setting — verify no per-child approval comments are created
- [ ] **Aggregate comment:** All child results are aggregated into a single parent issue comment — verify no N separate result comments for N children

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Slot deadlock (children blocking leads) | MEDIUM | Kill stalled child workers; add two-tier slot pool; re-dispatch leads |
| Parent/child relationships lost on restart | HIGH | Query SQLite for orphaned runs with matching workspace paths; manually re-associate; add `parentRunId` migration |
| Workspace contamination between children | MEDIUM | Identify conflicting files from git log; revert to last clean commit; re-run with isolated workspaces |
| Loop of death (no convergence cap) | LOW | Kill the pipeline run; set `maxIterations` in config; re-dispatch |
| Conditional branch always executing | MEDIUM | Audit pipeline run `nodeStates` for unexpected `completed` statuses; add type discriminant; re-run with fixed executor |
| SQLite BUSY under concurrent child writes | LOW | Increase `busy_timeout`; add jitter to child completion writes; re-run (writes are idempotent) |
| Governance gate fires N times for N children | LOW | Approve once and close the other N-1 approval comments; fix governance inheritance; re-dispatch |
| Fix branch not carried forward, iterations repeat same fix | MEDIUM | Manually merge fix branches in order; add `currentBase` tracking to loop node; re-run from last good iteration |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Slot budget exhaustion (children eat parent slots) | Multi-agent delegation: slot design | Test: lead with maxChildren=5 and global slots=5 does not deadlock |
| Parent/child relationships lost on restart | Multi-agent delegation: schema + recovery | Test: SIGKILL daemon after child dispatch, restart, verify no duplicate dispatch |
| Workspace contamination between children | Multi-agent delegation: workspace isolation | Test: two children write to same relative path; verify no cross-contamination |
| Governance gate applied N times to N children | Multi-agent delegation: governance wiring | Test: supervised lead with 3 children generates exactly 1 approval request |
| Conditional branches break static DAG assumptions | Conditional pipeline nodes: executor refactor | Test: condition=false pipeline shows branch as skipped, not completed |
| Loop nodes violate DAG acyclicity invariant | Conditional/loop nodes: loop node model | Test: loop node does not trigger validateDAG cycle error; runs exactly maxIterations times |
| Self-correction loop of death | Self-correction: convergence guard | Test: fix agent that never fixes causes loop to abort at maxIterations |
| Fix branch not carried forward between iterations | Self-correction: carry-forward model | Test: fix in iteration 1 is visible to test runner in iteration 2 |
| Concurrent child SQLite write contention | Multi-agent delegation: SQLite wiring | Load test: 5 children complete simultaneously; no SQLITE_BUSY errors |
| Conditional node field ignored by executor | Conditional nodes: type discriminant | Test: pipeline with conditional node, condition=false, false-branch status is "skipped" |

---

## Sources

- `/home/claude/forgectl-dev/src/pipeline/executor.ts` — Static topological sort, inFlight scheduling, fan-in merge, checkpoint hydration (code analysis, HIGH confidence)
- `/home/claude/forgectl-dev/src/orchestrator/dispatcher.ts` — `dispatchIssue` fire-and-forget pattern, no child tracking, GovernanceOpts inheritance (code analysis, HIGH confidence)
- `/home/claude/forgectl-dev/src/orchestrator/state.ts` — In-memory OrchestratorState, SlotManager slot pool (code analysis, HIGH confidence)
- `/home/claude/forgectl-dev/src/validation/runner.ts` — Existing validation loop with `maxRetries`, restart-all-steps behavior (code analysis, HIGH confidence)
- `/home/claude/forgectl-dev/src/storage/schema.ts` — `runs` table schema missing `parentRunId`/`depth` columns (code analysis, HIGH confidence)
- [Multi-agent coordination strategies — Galileo AI](https://galileo.ai/blog/multi-agent-coordination-strategies) — parent-child topology, slot exhaustion patterns (MEDIUM confidence)
- [The "Loop of Death" — Sattyam Jain, Jan 2026](https://medium.com/@sattyamjain96/the-loop-of-death-why-90-of-autonomous-agents-fail-in-production-and-how-we-solved-it-at-e98451becf5f) — step budgets, convergence failure, retry abuse (MEDIUM confidence)
- [Self-Correcting Multi-Agent AI Systems — Soham Ghosh, Feb 2026](https://medium.com/@sohamghosh_23912/self-correcting-multi-agent-ai-systems-building-pipelines-that-fix-themselves-010786bae2db) — best-score tracking, iteration history (MEDIUM confidence)
- [Git Worktrees for Parallel Agents — DEV Community](https://dev.to/arifszn/git-worktrees-the-power-behind-cursors-parallel-agents-19j1) — workspace isolation pattern, per-agent branches (MEDIUM confidence)
- [I Tried Agent Self-Correction — Nexumo, Feb 2026](https://medium.com/@Nexumo_/i-tried-agent-self-correction-tool-errors-made-it-worse-d6ea76a17c1c) — self-correction backfire, tool error amplification (MEDIUM confidence)
- [Multi-Agent System Reliability — Maxim AI](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/) — coordination failures, retry ambiguity, duplicate actions (MEDIUM confidence)
- [SQLite concurrent writes — Ten Thousand Meters](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) — SQLITE_BUSY under concurrent writers, BEGIN IMMEDIATE pattern (HIGH confidence)

---
*Pitfalls research for: forgectl v2.1 Autonomous Factory (multi-agent delegation, conditional/loop pipelines, self-correction)*
*Researched: 2026-03-12*
