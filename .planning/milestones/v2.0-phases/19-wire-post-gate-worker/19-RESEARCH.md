# Phase 19: Wire Post-Gate in Orchestrator Worker - Research

**Researched:** 2026-03-12
**Domain:** Governance approval gate wiring in orchestrator worker path
**Confidence:** HIGH

## Summary

Phase 19 closes the last integration gap identified in the v2.0 milestone audit: the post-execution approval gate (`needsPostApproval` / `enterPendingOutputApproval`) is wired in `src/orchestration/single.ts` (CLI/RunQueue path) but NOT in `src/orchestrator/worker.ts` (orchestrator/webhook dispatch path). This means "interactive" and "supervised" autonomy levels only work for `forgectl run` CLI invocations, not for webhook-triggered runs via the orchestrator dispatcher.

The fix is straightforward: replicate the post-gate logic from `single.ts:241-265` into `worker.ts` after output collection (step 9, around line 338), and ensure `GovernanceOpts` flows from `dispatcher.ts` through to `executeWorker`. The governance module (`needsPostApproval`, `enterPendingOutputApproval`, `evaluateAutoApprove`) is fully implemented and tested; only the call site in worker.ts is missing.

**Primary recommendation:** Add governance parameters to `executeWorker`, insert post-gate check after output collection (before final comment/cleanup), and add unit tests verifying both the gate-triggered and auto-approve-bypass paths.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GOVN-01 | Configurable autonomy levels per workflow (full/semi/interactive/supervised) in WORKFLOW.md | Worker must read autonomy from governance config and check `needsPostApproval` after agent execution |
| GOVN-02 | Approval state machine (pending -> approved/rejected/revision_requested) | Worker must call `enterPendingOutputApproval` to transition run to `pending_output_approval` state when post-approval is required |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Purpose | Why Relevant |
|---------|---------|--------------|
| `src/governance/autonomy.ts` | `needsPostApproval(autonomy)` | Already implemented, returns true for "interactive" and "supervised" |
| `src/governance/approval.ts` | `enterPendingOutputApproval(runRepo, runId)` | Already implemented, transitions run to `pending_output_approval` |
| `src/governance/rules.ts` | `evaluateAutoApprove(rules, context)` | Already implemented, checks auto-approve bypass conditions |
| vitest | Testing | Existing test infrastructure for unit tests |

### No New Dependencies
This phase requires zero new dependencies. All governance logic is already implemented in `src/governance/`. This is purely a wiring task.

## Architecture Patterns

### Current State: Two Execution Paths

```
CLI path (forgectl run):
  server.ts -> RunQueue -> resolveRunPlan -> executeRun -> executeSingleAgent (single.ts)
    -> Post-gate at line 241-265  [WORKS]

Orchestrator path (webhook dispatch):
  webhooks.ts -> Orchestrator.dispatchIssue -> dispatcher.ts -> executeWorker (worker.ts)
    -> No post-gate  [GAP]
```

### Reference Implementation in single.ts (lines 241-265)

The existing post-gate logic in `executeSingleAgent` follows this exact pattern:

```typescript
// After output collection, before returning success
const autonomy = plan.workflow.autonomy ?? "full";
if (needsPostApproval(autonomy) && runRepo) {
  // Check auto-approve bypass (with actual cost from token usage)
  const actualCost = agentResult.tokenUsage
    ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
    : undefined;
  const autoApproveCtx = {
    labels: [] as string[],
    workflowName: plan.workflow.name,
    actualCost,
  };
  if (plan.workflow.auto_approve && evaluateAutoApprove(plan.workflow.auto_approve, autoApproveCtx)) {
    logger.info("governance", `Auto-approved post-gate for run ${plan.runId}`);
  } else {
    enterPendingOutputApproval(runRepo, plan.runId);
    logger.info("governance", `Run ${plan.runId} requires output approval (autonomy=${autonomy})`);
    return { success, output, validation, durationMs };
  }
}
```

### Pattern: How to Wire into worker.ts

The worker path needs:

1. **GovernanceOpts parameter on `executeWorker`** -- The dispatcher already has `GovernanceOpts` (autonomy, autoApprove, runRepo). Pass these through to `executeWorker`.

2. **Post-gate check after output collection** -- Insert between step 9 (collectGitOutput, line 338) and step 10 (session.close, line 355). The key decision from Phase 13 is: "Post-gate collects output BEFORE entering pending_output_approval (container cleanup safe)".

3. **Early return with pending status** -- When post-approval is needed and auto-approve does not pass, the worker should still return a `WorkerResult` but signal that the run is now pending approval (not completed).

### Data Flow

```
Orchestrator.dispatchIssue()
  -> builds GovernanceOpts { autonomy, autoApprove, runRepo }
  -> dispatcher.dispatchIssue(..., governance)
    -> executeWorkerAndHandle(..., governance)
      -> executeWorker(..., governance)   <-- NEW: pass governance
        -> after output collection:
           needsPostApproval(governance.autonomy) && governance.runRepo
           -> enterPendingOutputApproval(governance.runRepo, runId)
```

### Key Design Decision: Where the runId Comes From

In worker.ts, the `runId` is generated inside `buildOrchestratedRunPlan` (line 108: `crypto.randomUUID()`). The governance `runId` from `GovernanceOpts` might differ from the plan's `runId`. For the post-gate, use `plan.runId` (same as in single.ts) since that's what gets registered in the RunRepository.

However, looking at the dispatcher code, `governance.runId` is currently only used for the pre-gate (`enterPendingApproval`). The worker generates its own `plan.runId` via `buildOrchestratedRunPlan`. For the post-gate, the run must exist in the RunRepository first. This means either:
- The run is inserted into RunRepository before `executeWorker` (in `executeWorkerAndHandle`), OR
- The worker inserts it, OR
- We use `githubDeps?.runId` which is set to `issue.identifier` in the dispatcher

Looking at `single.ts`, `runRepo` is passed as part of `DurabilityDeps` and the run is expected to already exist (inserted by the RunQueue). In the orchestrator path, the `RunQueue` is NOT used -- `executeWorkerAndHandle` calls `executeWorker` directly. The `runRepo` on `GovernanceOpts` may not have a run entry for the worker's `plan.runId`.

**Critical finding:** For the post-gate to work (`enterPendingOutputApproval` calls `runRepo.findById(runId)` and throws if not found), the run must be registered in the RunRepository before the post-gate check. The dispatcher may need to insert a run record, OR the worker needs to do it, OR we need to use an ID that already exists.

Looking at the CLI path: `RunQueue.enqueue` inserts the run into the DB. In the orchestrator path, there is no equivalent insertion. The `githubDeps.runId` is set to `issue.identifier` -- this is NOT a UUID and may not be in the RunRepository.

**Resolution options:**
1. Insert a run record in `executeWorkerAndHandle` before calling `executeWorker` (cleanest, mirrors RunQueue.enqueue)
2. Insert a run record at the start of `executeWorker` when governance opts are provided
3. Guard the post-gate with a check for whether the run exists in the repo

Option 1 or 2 is correct. The run record needs to exist for the approval state machine to work. This aligns with how the pre-gate works: it calls `enterPendingApproval(governance.runRepo, governance.runId)` which also requires the run to exist.

**Wait** -- looking more carefully at the pre-gate in dispatcher.ts line 229: `enterPendingApproval(governance.runRepo, governance.runId)`. The `governance.runId` is set... but looking at `Orchestrator.dispatchIssue()` (index.ts line 222-228), it does NOT set `runId` on the GovernanceOpts:
```typescript
const governance: GovernanceOpts | undefined = this.runRepo
  ? { autonomy: this.autonomy ?? "full", autoApprove: this.autoApprove, runRepo: this.runRepo }
  : undefined;
```

And in the scheduler (scheduler.ts line 74-75):
```typescript
const governance: GovernanceOpts | undefined = deps.runRepo
  ? { autonomy: deps.autonomy ?? "full", autoApprove: deps.autoApprove, runRepo: deps.runRepo }
  : undefined;
```

Neither sets `governance.runId`. So the pre-gate's `enterPendingApproval(governance.runRepo, governance.runId!)` would fail if `governance.runId` is undefined. This means the pre-gate currently only works when the condition at line 229 passes: `governance?.runRepo && governance?.runId` -- since `runId` is always undefined in the orchestrator path, the pre-gate silently falls through to the warn log on line 241.

This means: **the pre-gate was never fully wired for the orchestrator path either**. It falls through to the "no runRepo available, proceeding" warning. This is by design per decision: "Pre-gate proceeds without gating when runRepo unavailable (graceful fallback) (13-02)".

For the post-gate in worker.ts, we need to either:
- Accept the same graceful fallback (skip post-gate when no run record exists), OR
- Create a run record in the dispatcher before calling executeWorker

Given this is a gap closure phase and the goal is "interactive/supervised autonomy levels work for webhook-triggered runs", we should create the run record. But that's a bigger change. The pragmatic approach for this phase:

1. Pass GovernanceOpts to executeWorker
2. Insert a run record in executeWorkerAndHandle (using plan.runId) before calling executeWorker
3. Add post-gate check in executeWorker after output collection

Let me verify what RunRepository.insert expects.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Post-approval check | Custom autonomy checks | `needsPostApproval()` from governance/autonomy.ts | Already handles all 4 levels correctly |
| State transition | Direct DB update | `enterPendingOutputApproval()` from governance/approval.ts | Handles event emission, status validation |
| Auto-approve bypass | Custom rule evaluation | `evaluateAutoApprove()` from governance/rules.ts | Handles AND logic, cost/label/pattern matching |
| Cost calculation | Custom formula | `(input * 3 + output * 15) / 1_000_000` | Same formula used in single.ts and toRunResult |

## Common Pitfalls

### Pitfall 1: Run Record Must Exist Before Approval Transition
**What goes wrong:** `enterPendingOutputApproval` calls `runRepo.findById(runId)` and throws if the run doesn't exist. In the orchestrator path, unlike the CLI path (where RunQueue inserts the record), no run record is created.
**Why it happens:** The orchestrator dispatch path bypasses RunQueue entirely -- it calls `executeWorker` directly.
**How to avoid:** Insert a run record in `executeWorkerAndHandle` before calling `executeWorker`, using the plan's runId.
**Warning signs:** "Run {id} not found" error in approval.ts.

### Pitfall 2: RunId Mismatch Between Governance and Worker Plan
**What goes wrong:** GovernanceOpts has one runId, the worker's plan has a different one (generated by `buildOrchestratedRunPlan`).
**How to avoid:** Use `plan.runId` consistently. If inserting a run record in the dispatcher, either pass the generated runId back or generate it before building the plan.

### Pitfall 3: Worker Must Return Early But Not Skip Cleanup
**What goes wrong:** When entering `pending_output_approval`, the worker returns a result but skips container cleanup, leaking resources.
**How to avoid:** Follow single.ts pattern -- output is collected BEFORE entering pending state. Container cleanup and session close should still happen. The "early return" is about the run status, not about skipping lifecycle steps.

### Pitfall 4: Labels Not Available in Worker Context
**What goes wrong:** Auto-approve rules may check labels, but the worker doesn't have access to issue labels through GovernanceOpts.
**How to avoid:** Pass issue labels through governance opts or extract from the issue parameter already available in executeWorker.

### Pitfall 5: buildOrchestratedRunPlan Hardcodes autonomy to "full"
**What goes wrong:** The plan's `workflow.autonomy` is hardcoded to `"full"` in `buildOrchestratedRunPlan` (line 137). The post-gate check in single.ts reads `plan.workflow.autonomy`. If worker.ts copies that pattern, it will always see "full" and never trigger the gate.
**How to avoid:** Either (a) pass autonomy from GovernanceOpts to `buildOrchestratedRunPlan` so the plan reflects the actual level, or (b) read autonomy from GovernanceOpts directly in the post-gate check (not from the plan). Option (b) is simpler and avoids modifying the plan builder signature.

## Code Examples

### Post-gate check to add in worker.ts (after output collection, before session.close)

```typescript
// Source: Adapted from src/orchestration/single.ts:241-265
import { needsPostApproval } from "../governance/autonomy.js";
import { enterPendingOutputApproval } from "../governance/approval.js";
import { evaluateAutoApprove } from "../governance/rules.js";

// Inside executeWorker, after collectGitOutput (step 9) and before session.close (step 10):
if (governance?.autonomy && needsPostApproval(governance.autonomy) && governance.runRepo && governance.runId) {
  const actualCost = agentResult.tokenUsage
    ? (agentResult.tokenUsage.input * 3 + agentResult.tokenUsage.output * 15) / 1_000_000
    : undefined;
  const autoApproveCtx = {
    labels: issue.labels,
    workflowName: plan.workflow.name,
    actualCost,
  };
  if (governance.autoApprove && evaluateAutoApprove(governance.autoApprove, autoApproveCtx)) {
    logger.info("governance", `Auto-approved post-gate for run ${plan.runId}`);
  } else {
    enterPendingOutputApproval(governance.runRepo, governance.runId);
    logger.info("governance", `Run ${governance.runId} requires output approval (autonomy=${governance.autonomy})`);
    // Continue to session.close and cleanup -- output is already collected
  }
}
```

### GovernanceOpts parameter addition to executeWorker

```typescript
// New optional parameter on executeWorker signature:
export async function executeWorker(
  issue: TrackerIssue,
  config: ForgectlConfig,
  workspaceManager: WorkspaceManager,
  promptTemplate: string,
  attempt: number,
  logger: Logger,
  onActivity?: () => void,
  validationConfig?: { steps: ValidationStep[]; on_failure: string },
  githubDeps?: GitHubDeps,
  governance?: GovernanceOpts,  // NEW
): Promise<WorkerResult>
```

### Run record insertion in dispatcher (executeWorkerAndHandle)

```typescript
// In executeWorkerAndHandle, before calling executeWorker:
if (governance?.runRepo) {
  const runId = issue.identifier; // or generate UUID
  governance.runRepo.insert({
    id: runId,
    status: "running",
    task: promptTemplate,
    options: {},
    createdAt: new Date().toISOString(),
  });
  governance = { ...governance, runId };
}
```

## State of the Art

| Current State | Required State | Impact |
|---------------|---------------|--------|
| Post-gate only in single.ts (CLI) | Post-gate in both single.ts AND worker.ts | Interactive/supervised work for webhook runs |
| GovernanceOpts lacks runId in orchestrator | GovernanceOpts includes runId from run record | Approval state machine can find the run |
| buildOrchestratedRunPlan hardcodes autonomy="full" | Autonomy read from GovernanceOpts | Post-gate evaluates correct level |

## Open Questions

1. **Run record insertion strategy**
   - What we know: RunQueue inserts runs for CLI path; orchestrator path has no equivalent
   - What's unclear: Exact shape of the run record for orchestrator-dispatched runs (what fields are required by `runRepo.insert`)
   - Recommendation: Check RunRepository.insert signature and mirror what RunQueue does

2. **WorkerResult signaling for pending approval**
   - What we know: Worker returns `WorkerResult` to dispatcher; dispatcher posts comment and handles retry logic
   - What's unclear: Should `WorkerResult` include a flag indicating the run is now pending approval (so dispatcher skips completion/retry logic)?
   - Recommendation: Add optional `pendingApproval: boolean` to `WorkerResult`, or check run status in dispatcher after executeWorker returns

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GOVN-01 | Post-gate checks autonomy level in worker path | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts -x` | Needs new tests |
| GOVN-02 | enterPendingOutputApproval called when post-approval needed | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts -x` | Needs new tests |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] New test cases in `test/unit/orchestrator-worker.test.ts` for post-gate in worker
- [ ] Test: executeWorker calls enterPendingOutputApproval when autonomy is "interactive" and runRepo available
- [ ] Test: executeWorker skips post-gate when autonomy is "full"
- [ ] Test: executeWorker auto-approves when evaluateAutoApprove returns true
- [ ] Test: executeWorker still completes cleanup after entering pending approval

## Sources

### Primary (HIGH confidence)
- `src/orchestration/single.ts:241-265` -- Reference post-gate implementation
- `src/orchestrator/worker.ts` -- Current worker without post-gate
- `src/orchestrator/dispatcher.ts` -- Current dispatcher with pre-gate
- `src/governance/autonomy.ts` -- needsPostApproval implementation
- `src/governance/approval.ts` -- enterPendingOutputApproval implementation
- `src/governance/rules.ts` -- evaluateAutoApprove implementation
- `.planning/v2.0-MILESTONE-AUDIT.md` -- Gap identification (POST-GATE-WORKER)

### Secondary (MEDIUM confidence)
- `src/orchestrator/index.ts` -- GovernanceOpts construction in Orchestrator class
- `src/orchestrator/scheduler.ts` -- GovernanceOpts construction in tick
- `test/unit/governance-wiring.test.ts` -- Existing governance wiring test patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all governance modules are in-tree, fully tested, and well-understood
- Architecture: HIGH -- the gap is clearly identified, the reference implementation exists, and the wiring pattern is established
- Pitfalls: HIGH -- the runId/run-record issue was discovered by reading the actual code paths

**Research date:** 2026-03-12
**Valid until:** Stable (internal codebase, no external dependency changes expected)
