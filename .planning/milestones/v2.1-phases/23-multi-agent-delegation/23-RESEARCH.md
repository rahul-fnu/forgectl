# Phase 23: Multi-Agent Delegation - Research

**Researched:** 2026-03-13
**Domain:** Orchestrator extension — delegation manifest parsing, two-tier slot pool, child worker lifecycle, failure/retry, synthesis write-back
**Confidence:** HIGH (all findings from direct codebase inspection; no external dependencies required)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Delegation manifest format**
- JSON array inside sentinel-delimited stdout block: `---DELEGATE---` / `---END-DELEGATE---`
- Required fields per subtask: `id` (unique within manifest) and `task` (instruction text)
- Optional fields: `workflow` (defaults to parent's workflow), `agent` (defaults to parent's agent)
- If lead agent outputs multiple manifest blocks, only the first is parsed — subsequent blocks are ignored
- Lead's non-manifest stdout is not extracted separately — already captured in RunLog JSON for debugging

**Two-tier slot pool**
- Reserved child budget: split `max_concurrent_agents` into top-level slots + child slots
- New config field `orchestrator.child_slots` in forgectl.yaml — top-level slots = max_concurrent_agents - child_slots
- When `child_slots` is 0 or omitted: delegation is disabled — manifest blocks are logged as warnings and ignored
- Both global `child_slots` and per-parent `maxChildren` (from WORKFLOW.md) are enforced simultaneously
- Per-parent `maxChildren` caps how many children one delegation can have in-flight; global `child_slots` caps total child concurrency across all parents

**Child failure retry behavior**
- Lead rewrites the failed subtask: lead agent is re-invoked with original issue + child failure output + "rewrite this subtask only"
- Rewrite scope is the failed subtask only — completed children are untouched, lead outputs a single-item manifest with the same id
- Maximum 1 retry per child (3 agent invocations max per subtask: original + lead rewrite + retry)
- Retries happen immediately — no waiting for other children to complete first; retry runs concurrently with remaining work
- If retry also fails, child is marked permanently failed

**Synthesis and write-back**
- After all children complete (or permanently fail), re-invoke the lead agent with original issue + all child results
- Lead produces a structured markdown summary: header with overall status, per-child section with status badge + key output, lead-written synthesis paragraph
- Child outputs (branches, PRs) are separate artifacts — no auto-merge; synthesis comment references them
- Synthesis always runs regardless of child outcomes — partial results are valuable, user gets full picture

### Claude's Discretion
- Exact DelegationManager class structure and method signatures
- How child workspace isolation works (reuse parent workspace vs fresh clone)
- Sentinel parsing implementation details (regex vs streaming)
- How the synthesis prompt is structured beyond the required content
- Governance inheritance model for child runs
- Dry-run behavior for delegation nodes

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DELEG-01 | Lead agent decomposes a complex issue into structured subtask specs (id, task, workflow, agent) | Manifest parsing extracts Zod-validated subtask array from sentinel-delimited stdout block |
| DELEG-02 | Orchestrator dispatches child workers concurrently from subtask specs (via SyntheticIssue adapter) | `executeWorker` reused with SyntheticIssue shim; concurrent dispatch via Promise.all pattern |
| DELEG-03 | Per-issue `maxChildren` budget enforced from WORKFLOW.md config | `runs.maxChildren` column exists; WORKFLOW.md front matter needs `delegation.max_children` field |
| DELEG-04 | Delegation depth hard-capped at 2 (lead + workers, no further nesting) | `runs.depth` column exists; DelegationManager checks depth before parsing manifest |
| DELEG-05 | Parent/child run relationships persisted in SQLite (parentRunId, survives daemon restart) | `delegations` table fully provisioned; `runs.parentRunId` column exists; reconciler extension needed |
| DELEG-06 | Two-tier slot pool prevents child agents from starving top-level work | `SlotManager` class exists; extend to `TwoTierSlotManager` with topLevel + child maps |
| DELEG-07 | Child results collected and aggregated after all children complete | `DelegationRepository.findByParentRunId()` + `countByParentAndStatus()` provide the needed queries |
| DELEG-08 | On child failure, lead re-issues subtask with updated instructions incorporating failure context | DelegationManager watches child completion, triggers lead re-invocation with failure stdout |
| DELEG-09 | Lead agent synthesizes all child results into one coherent summary for write-back | `tracker.postComment()` + `buildResultComment()` pattern; extend for aggregate synthesis shape |
</phase_requirements>

---

## Summary

Phase 23 is an orchestrator-layer extension. Every primitive it needs already exists in the codebase — the schema (delegations table, runs.parentRunId, runs.depth, runs.maxChildren), the repository (DelegationRepository with all required queries), the worker lifecycle (executeWorker), and the comment infrastructure (buildResultComment, tracker.postComment). The work is wiring these pieces together through a new DelegationManager class that intercepts agent stdout, drives child dispatch, tracks outcomes, and invokes lead synthesis.

The primary design tension is the two-tier slot pool. The current `SlotManager` is a single counter. Phase 23 must extend it (or replace it with `TwoTierSlotManager`) so that top-level issues and child workers draw from separate pools, enforced in the scheduler tick and in the DelegationManager. When `child_slots` is 0 or absent in forgectl.yaml, delegation is entirely disabled — manifest blocks become logged warnings.

The WORKFLOW.md front matter does not currently have a `delegation` section. Both `delegation.max_children` and the `orchestrator.child_slots` field in forgectl.yaml must be added, with Zod validation and schema migration for the latter (config schema extension, no DB migration needed since schema columns are already present from Phase 20).

**Primary recommendation:** Implement DelegationManager as a standalone module (`src/orchestrator/delegation.ts`) that is called from executeWorkerAndHandle after the agent completes. This keeps the existing dispatcher/worker untouched except for the post-completion hook and the slot manager upgrade.

---

## Standard Stack

### Core (all already in-project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | in use | Manifest schema validation | Project standard for all runtime validation |
| drizzle-orm | in use | SQLite queries via DelegationRepository | Project standard ORM |
| vitest | in use | Unit tests | Project standard test runner |

### No New Dependencies
All delegation functionality uses existing project dependencies. No new npm packages are needed.

---

## Architecture Patterns

### Recommended Project Structure
```
src/orchestrator/
├── delegation.ts         # NEW: DelegationManager — manifest parse, child dispatch, retry, synthesis
├── state.ts              # EXTEND: TwoTierSlotManager replacing SlotManager
├── dispatcher.ts         # EXTEND: pass DelegationManager into executeWorkerAndHandle
├── scheduler.ts          # EXTEND: use TwoTierSlotManager for top-level slot checks
└── reconciler.ts         # EXTEND: recover in-flight delegations on daemon restart

src/config/schema.ts      # EXTEND: add child_slots to OrchestratorConfigSchema
src/workflow/types.ts     # EXTEND: add delegation.max_children to WorkflowFileConfig
src/workflow/workflow-file.ts  # EXTEND: add delegation field to WorkflowFrontMatterSchema

test/unit/
├── delegation-manifest.test.ts    # NEW: parseDelegationManifest, Zod schema
├── delegation-manager.test.ts     # NEW: DelegationManager full lifecycle
├── orchestrator-slots-two-tier.test.ts  # NEW: TwoTierSlotManager
```

### Pattern 1: DelegationManager — core class

**What:** A new module responsible for the full delegation lifecycle after a lead agent completes.

**When to use:** Called from executeWorkerAndHandle after `executeWorker` resolves, when agentResult.stdout contains the sentinel block.

```typescript
// src/orchestrator/delegation.ts
export interface DelegationManager {
  /** Parse and validate sentinel block from agent stdout. Returns null if absent or disabled. */
  parseDelegationManifest(stdout: string, runId: string): SubtaskSpec[] | null;

  /** Dispatch all subtask specs as child workers, return when all finish or permanently fail. */
  runDelegation(
    parentRunId: string,
    parentIssue: TrackerIssue,
    specs: SubtaskSpec[],
    depth: number,
    maxChildren: number,
  ): Promise<DelegationOutcome>;

  /** Re-invoke lead with failure context for a single failed subtask, returns updated spec. */
  rewriteFailedSubtask(
    parentIssue: TrackerIssue,
    failedSpec: SubtaskSpec,
    failureOutput: string,
  ): Promise<SubtaskSpec | null>;

  /** Re-invoke lead with all child results for synthesis; returns synthesis comment text. */
  synthesize(
    parentIssue: TrackerIssue,
    outcomes: ChildOutcome[],
  ): Promise<string>;
}
```

### Pattern 2: SyntheticIssue — TrackerIssue shim for child workers

**What:** A plain object that implements `TrackerIssue` for a subtask spec. Child workers call executeWorker with this shim, and tracker calls (postComment, updateState, updateLabels) are no-ops or routed to the parent.

**When to use:** Every child dispatch.

```typescript
// Inside delegation.ts
function toSyntheticIssue(spec: SubtaskSpec, parentIssue: TrackerIssue): TrackerIssue {
  return {
    id: `${parentIssue.id}:${spec.id}`,
    identifier: `${parentIssue.identifier}/${spec.id}`,
    title: spec.task,
    description: spec.task,
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: parentIssue.url,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    blocked_by: [],
    metadata: { parentIssueId: parentIssue.id, delegationId: spec.id },
  };
}
```

### Pattern 3: TwoTierSlotManager — extends SlotManager

**What:** Replaces the single-counter `SlotManager` with a two-pool variant. Top-level and child workers draw from separate Maps. The existing `SlotManager` interface is preserved so all callers that only care about top-level capacity continue to work unchanged.

**When to use:** Orchestrator startup; `tick()` scheduler; DelegationManager child dispatch.

```typescript
// src/orchestrator/state.ts (additions)
export class TwoTierSlotManager {
  private topLevelMax: number;  // max_concurrent_agents - child_slots
  private childMax: number;     // child_slots
  private topLevelRunning: Map<string, WorkerInfo> = new Map();
  private childRunning: Map<string, WorkerInfo> = new Map();

  hasTopLevelSlot(): boolean { return this.topLevelRunning.size < this.topLevelMax; }
  hasChildSlot(): boolean { return this.childRunning.size < this.childMax; }
  isDelegationEnabled(): boolean { return this.childMax > 0; }
  // ... register/release methods
}
```

### Pattern 4: Manifest Parsing

**What:** Regex-based extraction of the sentinel block from agent stdout. Zod validates the extracted JSON.

```typescript
const SENTINEL_RE = /---DELEGATE---\s*([\s\S]*?)\s*---END-DELEGATE---/;

const SubtaskSpecSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  workflow: z.string().optional(),
  agent: z.string().optional(),
});
const DelegationManifestSchema = z.array(SubtaskSpecSchema).min(1);

export function parseDelegationManifest(stdout: string): SubtaskSpec[] | null {
  const match = SENTINEL_RE.exec(stdout);
  if (!match) return null;
  const raw = JSON.parse(match[1]);
  return DelegationManifestSchema.parse(raw);  // throws ZodError on malformed
}
```

**Only the first sentinel block is used** — the regex returns the first match by default.

### Pattern 5: Daemon Restart Recovery

**What:** On daemon restart, `reconciler.ts` or orchestrator `startupRecovery()` must query `delegations` table for in-flight rows (status = 'pending' | 'running') and re-dispatch or mark as failed.

**Existing hook:** `Orchestrator.startupRecovery()` already runs at `start()`. Extend it to call `DelegationRepository.list()`, filter for non-terminal statuses by parentRunId, and re-enqueue outstanding children.

### Anti-Patterns to Avoid

- **Don't re-parse manifest on every tick.** Manifest parsing happens once — immediately after the lead agent completes. The parsed specs are persisted to the delegations table before any dispatch.
- **Don't pass child issues through the tracker poll loop.** Child workers are dispatched directly by DelegationManager, never via `fetchCandidateIssues()`. Routing them through the normal scheduler would break the slot model and duplicate tracking.
- **Don't let child workers post individual result comments.** The WorkerResult.comment from each child is collected internally; only the synthesis comment is posted to the tracker.
- **Don't block the lead until all children finish before synthesis.** The lead re-invocation for synthesis happens in DelegationManager after collecting all outcomes — it's not a live blocking call during child execution.
- **Don't mutate the existing SlotManager constructor signature.** The Orchestrator creates SlotManager with a single integer. Add a factory that reads both config fields and returns TwoTierSlotManager; the scheduler receives it via the TickDeps interface.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Child worker execution | Custom agent invoker | `executeWorker()` in `src/orchestrator/worker.ts` | Full lifecycle: container, validation, git output, cleanup. 490 lines covering every edge case. |
| Delegation persistence | Custom state file | `DelegationRepository` from `src/storage/repositories/delegations.ts` | Already implements all needed queries: findByParentRunId, countByParentAndStatus, updateStatus with auto-completedAt. |
| Synthesis comment format | Custom markdown generator | Extend `buildResultComment()` pattern from `src/github/comments.ts` | Matches existing GitHub comment style users already see. |
| JSON manifest validation | Manual key checking | Zod schema (project standard) | ZodError gives actionable messages; consistent with all other config validation in project. |
| Concurrent child execution | Manual Promise tracking | `Promise.allSettled()` | Built-in, no rejected-promise leaks, captures all outcomes regardless of individual failures. |

---

## Common Pitfalls

### Pitfall 1: childRunId not set before dispatch, blocking restart recovery
**What goes wrong:** DelegationRow is inserted with `childRunId = null` initially, but if the daemon restarts before the child run ID is assigned, recovery can't correlate the delegation to a new run.
**Why it happens:** There's a window between `repo.insert(params)` and child worker startup where `childRunId` is null.
**How to avoid:** Assign the child's runId synchronously before `executeWorker` starts (use `crypto.randomUUID()` at dispatch time), store it in the delegation row immediately, and pass it to `buildOrchestratedRunPlan` as the runId.
**Warning signs:** Delegation rows with `status='running'` and `childRunId=null` after restart.

### Pitfall 2: child_slots=0 leaks manifests silently through if not guarded early
**What goes wrong:** DelegationManager.parseDelegationManifest() returns specs but they are never dispatched; the lead's work is silently swallowed.
**How to avoid:** Check `TwoTierSlotManager.isDelegationEnabled()` before parsing. If disabled, log a `warn` with the parent run ID and return immediately — do not parse, do not insert delegation rows.

### Pitfall 3: Per-parent maxChildren is read from the wrong source
**What goes wrong:** `maxChildren` must come from the WORKFLOW.md front matter (per-issue config), not from the global forgectl.yaml. Confusing the two means all delegations share the same budget.
**How to avoid:** Read `workflowFile.config.delegation?.max_children` when building the lead's RunPlan; pass it as a parameter to DelegationManager. Fall back to a sensible default (e.g., 5) when absent.

### Pitfall 4: Depth check using runs table depth may be wrong at child dispatch time
**What goes wrong:** The lead's `runs.depth` field may not be set if the dispatcher didn't insert a run record.
**How to avoid:** DelegationManager receives the parent's depth as a parameter (not read from DB at dispatch time). If parentRun.depth >= 1, all manifest blocks are silently ignored (depth-2 cap). Log a `warn` for transparency.

### Pitfall 5: Synthesis invoked before all children settle
**What goes wrong:** Using `Promise.all` instead of `Promise.allSettled` for child dispatch means a single child failure rejects the entire batch before other children complete.
**How to avoid:** Always use `Promise.allSettled(childPromises)` so all children run to completion (success, permanent failure, or retry exhaustion) before synthesis is triggered.

### Pitfall 6: WorkflowFrontMatterSchema uses .strict() — new fields will throw parse errors
**What goes wrong:** Adding `delegation.max_children` to WORKFLOW.md without adding it to `WorkflowFrontMatterSchema` causes `z.strict()` to throw on any WORKFLOW.md that includes it.
**How to avoid:** Add `delegation: z.object({ max_children: z.number().int().positive() }).optional()` to the schema before any other phase work tries to use it. This is a Wave 0 task.

### Pitfall 7: Child worker posts comments to the parent issue tracker
**What goes wrong:** `executeWorker` calls `buildGHResultComment` and may call `tracker.postComment` for child issues, producing N+1 comments on the parent issue instead of the single synthesis.
**How to avoid:** Either (a) use a no-op TrackerAdapter shim for child dispatch, or (b) pass a flag to executeWorker that suppresses the final comment posting. The DelegationManager collects `WorkerResult.comment` directly and uses it only for synthesis context.

---

## Code Examples

### Zod manifest schema
```typescript
// Source: project convention — all existing config validation uses this shape
import { z } from "zod";

export const SubtaskSpecSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  workflow: z.string().optional(),
  agent: z.string().optional(),
});
export type SubtaskSpec = z.infer<typeof SubtaskSpecSchema>;

export const DelegationManifestSchema = z.array(SubtaskSpecSchema).min(1);
```

### Sentinel extraction (regex, first match only)
```typescript
// Source: design decision from CONTEXT.md — first block only
const SENTINEL_RE = /---DELEGATE---\s*([\s\S]*?)\s*---END-DELEGATE---/;

export function parseDelegationManifest(stdout: string): SubtaskSpec[] | null {
  const match = SENTINEL_RE.exec(stdout);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;  // Malformed JSON — treat as no manifest
  }
  const result = DelegationManifestSchema.safeParse(raw);
  return result.success ? result.data : null;
}
```

### DelegationRepository usage (existing, no changes needed)
```typescript
// Source: src/storage/repositories/delegations.ts
const row = delegationRepo.insert({
  parentRunId: parentRunId,
  childRunId: childRunId,  // assign before dispatch
  taskSpec: spec,
  status: "pending",
  createdAt: new Date().toISOString(),
});

// After child completes:
delegationRepo.updateStatus(row.id, "completed", {
  agentStatus: result.agentResult.status,
  branch: result.branch,
  stdout: result.agentResult.stdout,
});

// Check all complete:
const pending = delegationRepo.countByParentAndStatus(parentRunId, "pending");
const running = delegationRepo.countByParentAndStatus(parentRunId, "running");
const allDone = pending === 0 && running === 0;
```

### TwoTierSlotManager construction
```typescript
// Source: design decision — extends SlotManager pattern from src/orchestrator/state.ts
export function createTwoTierSlotManager(config: OrchestratorConfig): TwoTierSlotManager {
  const childSlots = config.child_slots ?? 0;
  const topLevelSlots = Math.max(1, config.max_concurrent_agents - childSlots);
  return new TwoTierSlotManager(topLevelSlots, childSlots);
}
```

### Scheduler tick extension for two-tier slots
```typescript
// Extension point: src/orchestrator/scheduler.ts tick()
// Top-level dispatch uses topLevel slots only:
const available = slotManager.availableTopLevelSlots();
// Child dispatch in DelegationManager uses child slots:
const childAvailable = slotManager.availableChildSlots();
```

### OrchestratorConfigSchema extension
```typescript
// Source: src/config/schema.ts — add to OrchestratorConfigSchema
export const OrchestratorConfigSchema = z.object({
  // ... existing fields ...
  child_slots: z.number().int().min(0).default(0),
  // When 0: delegation disabled
});
```

### WorkflowFrontMatterSchema extension
```typescript
// Source: src/workflow/workflow-file.ts — add delegation field before .strict()
delegation: z
  .object({
    max_children: z.number().int().positive().optional(),
  })
  .optional(),
```

### Synthesis prompt construction
```typescript
// Source: pattern from src/workflow/template.ts + design decisions in CONTEXT.md
function buildSynthesisPrompt(
  parentIssue: TrackerIssue,
  outcomes: ChildOutcome[],
): string {
  const childSummaries = outcomes.map((o) => {
    const status = o.failed ? "FAILED" : "COMPLETED";
    return `### Subtask ${o.spec.id} — ${status}\n${o.stdout ?? o.errorMessage ?? "(no output)"}`;
  }).join("\n\n");

  return [
    `You previously decomposed issue "${parentIssue.title}" into subtasks.`,
    `All subtasks have now completed. Here are the results:\n\n${childSummaries}`,
    "",
    "Produce a structured markdown summary with:",
    "1. An overall status header (all passed / partial failure / all failed)",
    "2. A one-line status badge per subtask",
    "3. A synthesis paragraph summarizing what was accomplished and what (if anything) needs follow-up",
  ].join("\n");
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single-tier SlotManager | Two-tier (top-level + child) | Phase 23 | Prevents child agents from consuming all slots, starving top-level work |
| No delegation support | Sentinel-based manifest dispatch | Phase 23 | Lead agents can decompose work autonomously |
| Per-child tracker comments | Single synthesis comment | Phase 23 | Clean issue comment thread; one signal per delegation round |

---

## Open Questions

1. **Child workspace isolation: reuse parent workspace vs. fresh subdirectory**
   - What we know: `WorkspaceManager.ensureWorkspace(identifier)` creates per-identifier directories; synthetic issue identifier is `parentIdentifier/subtaskId`
   - What's unclear: Whether child workers should share the parent's git workspace or get a fresh clone at a subdirectory
   - Recommendation (Claude's discretion): Use a fresh subdirectory under the parent workspace path for simplicity — avoids git lock contention between concurrent children touching the same repo. Path: `wsInfo.path + '/children/' + spec.id`.

2. **Governance inheritance for child runs**
   - What we know: `GovernanceOpts` is passed to `executeWorkerAndHandle`; children call `executeWorker` with the same config
   - What's unclear: Whether child runs should inherit the parent's autonomy level or run as `full` autonomy
   - Recommendation (Claude's discretion): Inherit parent autonomy level unless the subtask spec contains an explicit override. This is the safest default — escalation (asking for approval) is better than skipping governance for child work.

3. **Dry-run behavior for delegation nodes**
   - What we know: Phase 21 added dry-run annotation for pipeline nodes; orchestrator has no dry-run mode today
   - What's unclear: Whether the orchestrator should support `--dry-run` that shows delegation manifest without dispatching children
   - Recommendation (Claude's discretion): Log manifest contents at INFO level and return without dispatching. No new CLI flag needed for Phase 23 — the dry-run is a future concern.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (in use) |
| Config file | `/home/claude/forgectl-dev/vitest.config.ts` |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation*.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DELEG-01 | parseDelegationManifest extracts and validates subtask specs | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation-manifest.test.ts` | Wave 0 |
| DELEG-01 | parseDelegationManifest returns null when sentinel absent | unit | same | Wave 0 |
| DELEG-01 | parseDelegationManifest uses first block only (multiple blocks) | unit | same | Wave 0 |
| DELEG-02 | DelegationManager dispatches children concurrently | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation-manager.test.ts` | Wave 0 |
| DELEG-03 | maxChildren cap respected — excess subtasks are not dispatched | unit | same | Wave 0 |
| DELEG-04 | Manifest ignored when parent depth >= 1 | unit | same | Wave 0 |
| DELEG-05 | Delegation rows inserted with childRunId before dispatch | unit | same | Wave 0 |
| DELEG-06 | TwoTierSlotManager enforces separate top-level and child pools | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-slots-two-tier.test.ts` | Wave 0 |
| DELEG-06 | Delegation disabled when child_slots=0 | unit | same | Wave 0 |
| DELEG-07 | Synthesis triggered after all children settle | unit | delegation-manager.test.ts | Wave 0 |
| DELEG-08 | Lead re-invoked with failure context when child fails | unit | delegation-manager.test.ts | Wave 0 |
| DELEG-08 | Retry child dispatched with updated spec | unit | delegation-manager.test.ts | Wave 0 |
| DELEG-08 | Permanently failed after 1 retry | unit | delegation-manager.test.ts | Wave 0 |
| DELEG-09 | Synthesis comment posted to tracker (not per-child) | unit | delegation-manager.test.ts | Wave 0 |
| DELEG-09 | Synthesis runs even when some children permanently failed | unit | delegation-manager.test.ts | Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation*.test.ts test/unit/orchestrator-slots-two-tier.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/delegation-manifest.test.ts` — covers DELEG-01 (manifest parsing, Zod validation, first-block-only rule)
- [ ] `test/unit/delegation-manager.test.ts` — covers DELEG-02, DELEG-03, DELEG-04, DELEG-05, DELEG-07, DELEG-08, DELEG-09
- [ ] `test/unit/orchestrator-slots-two-tier.test.ts` — covers DELEG-06 (TwoTierSlotManager, disabled when child_slots=0)

---

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection — `src/orchestrator/state.ts`, `dispatcher.ts`, `worker.ts`, `scheduler.ts`, `reconciler.ts`, `index.ts`
- Direct codebase inspection — `src/storage/repositories/delegations.ts`, `runs.ts`
- Direct codebase inspection — `src/storage/schema.ts` (delegations table, runs columns)
- Direct codebase inspection — `src/config/schema.ts` (OrchestratorConfigSchema, WorkflowSchema)
- Direct codebase inspection — `src/workflow/workflow-file.ts`, `types.ts` (WorkflowFrontMatterSchema, .strict() constraint)
- Direct codebase inspection — `src/github/comments.ts` (buildResultComment, progress comment patterns)
- Direct codebase inspection — `src/tracker/types.ts` (TrackerIssue, TrackerAdapter interfaces)
- Direct codebase inspection — existing tests in `test/unit/orchestrator-*.test.ts` (mock patterns, makeIssue helpers)

### Secondary (MEDIUM confidence)
- `.planning/phases/23-multi-agent-delegation/23-CONTEXT.md` — all design decisions confirmed by direct author

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all existing in-project, no unknowns
- Architecture: HIGH — all integration points identified from source code; patterns follow established project conventions
- Pitfalls: HIGH — identified from direct code inspection of WorkflowFrontMatterSchema.strict(), SlotManager interface, existing executeWorker behavior

**Research date:** 2026-03-13
**Valid until:** 2026-04-12 (stable codebase, no external dependencies)
