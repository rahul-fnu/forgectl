# Phase 13: Governance & Approvals - Research

**Researched:** 2026-03-10
**Domain:** Workflow governance, approval state machines, auto-approve rule evaluation
**Confidence:** HIGH

## Summary

Phase 13 adds configurable autonomy levels to workflows and an approval state machine that gates run execution and output landing. The implementation is primarily internal state management -- no new external dependencies are needed. The codebase already has strong patterns for run status transitions (pause/resume from Phase 12), REST API endpoints, WORKFLOW.md front-matter parsing, and zod schema validation that this phase extends.

The core challenge is inserting approval gates at two points in the execution flow: pre-execution (in the dispatcher before `executeWorkerAndHandle`) and post-execution (in `executeSingleAgent` after validation passes, before output collection). Auto-approve rules provide a bypass mechanism evaluated against run metadata (labels, workflow name, cost).

**Primary recommendation:** Build the approval module as `src/governance/` with a state machine, rule evaluator, and approval repository, following the same patterns as `src/durability/` (pure functions operating on repositories).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Four autonomy levels: full, interactive, semi, supervised
- full = no gates (current behavior, backward compatible default)
- interactive = post-gate only (output approval)
- semi = pre-gate only (dispatch approval)
- supervised = both pre-gate and post-gate
- Pre-execution gate: new `pending_approval` run status
- Post-execution gate: new `pending_output_approval` run status
- Three approval actions: approve, reject, revision_requested
- Revision sends run back with feedback for agent re-execution
- REST API endpoints: POST /api/v1/runs/:id/approve and POST /api/v1/runs/:id/reject
- Auto-approve rules in WORKFLOW.md only (co-located with workflow policy)
- AND logic for multiple conditions (all must pass)
- Condition types: label match, workflow name pattern, cost threshold
- Cost threshold evaluated post-execution using actual cost (not estimates)
- No file count threshold

### Claude's Discretion
- Approval state machine implementation details (table schema, transition functions)
- How revision_requested re-dispatches (prompt construction with feedback)
- WORKFLOW.md YAML syntax for autonomy and auto_approve fields
- How auto-approve evaluation integrates with the dispatcher flow

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GOVN-01 | Configurable autonomy levels per workflow (full/semi/interactive/supervised) in WORKFLOW.md | Extend WorkflowSchema with autonomy enum, WorkflowFileConfig with autonomy field, map-front-matter passthrough |
| GOVN-02 | Approval state machine (pending -> approved/rejected/revision_requested) | New run statuses, transition functions, REST endpoints, event emission |
| GOVN-03 | Auto-approve rules (cost < $X, specific label, workflow pattern) | Rule schema in zod, evaluator function, integration at gate points |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | existing | Schema validation for autonomy enum, auto-approve rules | Already used for all config validation |
| drizzle-orm | existing | Run status persistence, potential approvals table | Already used for all database access |
| fastify | existing | REST API endpoints for approve/reject | Already used for daemon API |
| picomatch | existing | Workflow name pattern matching in auto-approve rules | Already a dependency, used for glob matching |

### Supporting
No new dependencies required. This phase uses existing infrastructure exclusively.

## Architecture Patterns

### Recommended Project Structure
```
src/
  governance/
    autonomy.ts         # AutonomyLevel type, gate-checking helpers
    approval.ts         # Approval state machine (transition functions)
    rules.ts            # Auto-approve rule evaluator
    types.ts            # Shared types (ApprovalAction, AutoApproveRule, etc.)
```

### Pattern 1: Autonomy Level as Workflow Property
**What:** Add `autonomy` field to WorkflowSchema and WorkflowFileConfig
**When to use:** Always -- this is the core configuration mechanism

The autonomy enum goes in `src/config/schema.ts`:
```typescript
export const AutonomyLevel = z.enum(["full", "interactive", "semi", "supervised"]);
```

Added to WorkflowSchema:
```typescript
export const WorkflowSchema = z.object({
  // ... existing fields
  autonomy: AutonomyLevel.default("full"),
});
```

Added to WorkflowFileConfig in `src/workflow/types.ts`:
```typescript
export interface WorkflowFileConfig {
  // ... existing fields
  autonomy?: "full" | "interactive" | "semi" | "supervised";
  auto_approve?: AutoApproveRuleConfig;
}
```

**Key detail:** Default is `full` for backward compatibility -- existing workflows with no autonomy field behave identically to today.

### Pattern 2: Gate Functions (Pure, Repository-Backed)
**What:** Pure functions that check whether a gate applies and manage transitions
**When to use:** Follow the `src/durability/pause.ts` pattern exactly

Pre-gate check (before dispatch):
```typescript
export function needsPreApproval(autonomy: AutonomyLevel): boolean {
  return autonomy === "semi" || autonomy === "supervised";
}

export function enterPendingApproval(
  runRepo: RunRepository,
  runId: string,
): void {
  // Transition: queued -> pending_approval
  runRepo.updateStatus(runId, { status: "pending_approval" });
}
```

Post-gate check (after validation, before output):
```typescript
export function needsPostApproval(autonomy: AutonomyLevel): boolean {
  return autonomy === "interactive" || autonomy === "supervised";
}

export function enterPendingOutputApproval(
  runRepo: RunRepository,
  runId: string,
): void {
  // Transition: running -> pending_output_approval
  runRepo.updateStatus(runId, { status: "pending_output_approval" });
}
```

### Pattern 3: Approval Actions as Status Transitions
**What:** approve/reject/revision_requested map to status transitions
**When to use:** REST endpoint handlers call these

Valid transitions:
- `pending_approval` -> `approved` (via approve) -> `running` (dispatcher resumes)
- `pending_approval` -> `rejected` (terminal)
- `pending_approval` -> `revision_requested` -> `running` (re-dispatch with feedback)
- `pending_output_approval` -> `approved` -> `completed` (output lands)
- `pending_output_approval` -> `rejected` (output discarded, terminal)
- `pending_output_approval` -> `revision_requested` -> `running` (re-execute with feedback)

The approve action for `pending_approval` should transition to `running` and trigger the actual worker dispatch. The approve action for `pending_output_approval` should trigger output collection/landing.

### Pattern 4: Auto-Approve Rule Evaluation
**What:** Rules evaluated at gate entry; if all pass, gate is skipped
**When to use:** At both pre-gate and post-gate entry points

WORKFLOW.md YAML syntax:
```yaml
autonomy: semi
auto_approve:
  label: safe
  workflow_pattern: "docs-*"
  max_cost: 0.50
```

Zod schema:
```typescript
export const AutoApproveRuleSchema = z.object({
  label: z.string().optional(),
  workflow_pattern: z.string().optional(),
  max_cost: z.number().positive().optional(),
}).optional();
```

Rule evaluation context differs by gate:
- **Pre-gate:** label match and workflow pattern are available (issue metadata known at dispatch time)
- **Post-gate:** cost threshold is available (actual cost computed after execution)
- AND logic: all specified conditions must pass

### Pattern 5: Revision Re-Dispatch
**What:** When revision_requested, the agent re-executes with feedback incorporated
**When to use:** Both pre-gate and post-gate revision

For revision, store the reviewer's feedback in the run record (similar to pauseContext):
```typescript
export interface ApprovalContext {
  action: "revision_requested";
  feedback: string;
  requestedAt: string;
  requestedBy?: string;
}
```

The re-dispatch should prepend the feedback to the agent prompt:
```
REVISION REQUESTED: {feedback}

Original task: {original task}
```

### Anti-Patterns to Avoid
- **Separate approvals table:** Unnecessary complexity -- the run status field already tracks state. Store approval metadata (feedback, timestamps) in the existing pauseContext/pauseReason columns or a new approvalContext column.
- **Polling for approval:** Do not poll. The REST endpoint directly triggers the state transition and resumes execution.
- **Auto-approve as middleware:** Do not implement as Fastify middleware. It is part of the governance logic called explicitly at gate entry points.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Glob pattern matching | Custom regex for workflow patterns | picomatch (existing dep) | Already used in the codebase, handles edge cases |
| Cost calculation | New cost calculator | Existing `costEstimate` from RichCommentData / $3/$15 per MTok formula | Already implemented in Phase 11 comment builder |

**Key insight:** This phase is pure internal state management. No external services, APIs, or complex algorithms needed. The hardest part is inserting gates at the right points in the execution flow without breaking existing behavior.

## Common Pitfalls

### Pitfall 1: Breaking Backward Compatibility
**What goes wrong:** Existing workflows without `autonomy` field fail or change behavior
**Why it happens:** Not defaulting to `full`
**How to avoid:** Default autonomy to `full` in both WorkflowSchema (.default("full")) and WorkflowFileConfig (undefined means full). Test that existing workflow YAML without autonomy field parses correctly.
**Warning signs:** Any existing test that runs a workflow starts failing

### Pitfall 2: Race Between Approval and Execution
**What goes wrong:** Pre-gate approval comes in but worker already started (or vice versa)
**Why it happens:** Fire-and-forget dispatch pattern in dispatcher.ts
**How to avoid:** The gate check must happen BEFORE `void executeWorkerAndHandle()`. The run should be created with `pending_approval` status and NOT dispatched until approved. On approval, the REST handler triggers dispatch.
**Warning signs:** Runs executing without approval in semi/supervised mode

### Pitfall 3: Post-Gate Output Not Landing
**What goes wrong:** Output is collected but never written to host because approval is pending
**Why it happens:** Current flow: validate -> collect output -> done. With post-gate: validate -> hold -> approve -> land output
**How to avoid:** In `executeSingleAgent`, after validation passes, check if post-approval is needed. If yes, persist the output location/data and set status to `pending_output_approval`. On approve, a separate function lands the output.
**Warning signs:** Output disappears because container is cleaned up before approval

### Pitfall 4: Container Cleanup Before Post-Approval
**What goes wrong:** Container is destroyed in the `finally` block of executeSingleAgent, but output still needs to be collected after approval
**Why it happens:** Current cleanup is automatic in finally block
**How to avoid:** For `interactive`/`supervised` modes, collect output to a staging area BEFORE entering pending_output_approval. The approval then copies/moves from staging to final destination. This way the container can be cleaned up immediately.
**Warning signs:** "Container not found" errors when trying to land output after approval

### Pitfall 5: Revision Infinite Loop
**What goes wrong:** Reviewer keeps requesting revisions, agent keeps retrying forever
**Why it happens:** No revision limit
**How to avoid:** Either: (a) count revisions and cap at a reasonable max (e.g., 3), or (b) leave unlimited but log/event each revision for visibility. Given this is human-driven, unlimited is likely fine -- the human will stop requesting revisions.
**Warning signs:** Run stuck in revision loop

### Pitfall 6: Auto-Approve Cost Threshold at Pre-Gate
**What goes wrong:** Cost threshold specified but evaluated at pre-gate where cost is unknown
**Why it happens:** Cost is only available post-execution
**How to avoid:** At pre-gate, only evaluate label and workflow_pattern conditions. Skip cost threshold condition entirely -- it only applies at post-gate. Document this clearly.
**Warning signs:** Auto-approve never triggers at pre-gate because cost is null

## Code Examples

### Pre-Gate Integration in Dispatcher
```typescript
// In dispatcher.ts, dispatchIssue():
export function dispatchIssue(issue, state, tracker, config, wsManager, promptTemplate, logger, metrics): void {
  if (!claimIssue(state, issue.id)) return;

  // Check if workflow requires pre-approval
  const autonomy = resolveAutonomy(config); // from workflow config
  if (needsPreApproval(autonomy)) {
    // Create run in pending_approval status
    // Do NOT dispatch worker
    enterPendingApproval(runRepo, runId);
    emitRunEvent({ runId, type: "approval_required", ... });
    return; // Wait for REST API approval
  }

  // Current flow: fire-and-forget
  void executeWorkerAndHandle(...);
}
```

### REST API Endpoints
```typescript
// POST /api/v1/runs/:id/approve
app.post("/api/v1/runs/:id/approve", async (request, reply) => {
  const { id } = request.params;
  const run = runRepo.findById(id);
  if (!run) { reply.code(404); return { error: { code: "NOT_FOUND", message: "Run not found" } }; }

  if (run.status === "pending_approval") {
    runRepo.updateStatus(id, { status: "running" });
    // Trigger actual dispatch
    emitRunEvent({ runId: id, type: "approved", ... });
    return { status: "approved", runId: id };
  }

  if (run.status === "pending_output_approval") {
    // Land the staged output
    runRepo.updateStatus(id, { status: "completed" });
    emitRunEvent({ runId: id, type: "output_approved", ... });
    return { status: "approved", runId: id };
  }

  reply.code(409);
  return { error: { code: "CONFLICT", message: `Run is ${run.status}, not pending approval` } };
});

// POST /api/v1/runs/:id/reject
app.post("/api/v1/runs/:id/reject", async (request, reply) => {
  const { id } = request.params;
  const body = request.body as { reason?: string } | null;
  // Validate status is pending_approval or pending_output_approval
  runRepo.updateStatus(id, { status: "rejected", error: body?.reason });
  return { status: "rejected", runId: id };
});
```

### Auto-Approve Evaluation
```typescript
import picomatch from "picomatch";

export interface AutoApproveContext {
  labels: string[];           // Issue labels
  workflowName: string;       // Current workflow name
  actualCost?: number;        // Post-execution cost in dollars (null at pre-gate)
}

export function evaluateAutoApprove(
  rules: AutoApproveRule,
  context: AutoApproveContext,
): boolean {
  // AND logic: all specified conditions must pass
  if (rules.label !== undefined) {
    if (!context.labels.includes(rules.label)) return false;
  }
  if (rules.workflow_pattern !== undefined) {
    if (!picomatch.isMatch(context.workflowName, rules.workflow_pattern)) return false;
  }
  if (rules.max_cost !== undefined) {
    if (context.actualCost === undefined) return false; // Cost unknown, can't auto-approve
    if (context.actualCost >= rules.max_cost) return false;
  }
  return true; // All specified conditions passed (or no conditions specified)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All runs execute immediately | Autonomy levels gate execution | Phase 13 | Runs can require human approval |
| No output review | Post-execution approval gate | Phase 13 | Output can be reviewed before landing |
| Manual approval only | Auto-approve rules | Phase 13 | Trusted workflows bypass gates |

## Open Questions

1. **Approval context storage**
   - What we know: The runs table has `pauseContext` for pause/resume. Approval context (feedback for revisions) needs similar storage.
   - What's unclear: Reuse `pauseContext`/`pauseReason` columns or add new `approvalContext`/`approvalAction` columns
   - Recommendation: Add dedicated `approvalContext` and `approvalAction` columns to the runs table. This keeps pause and approval semantics separate and avoids confusion. The migration is trivial (two ALTER TABLE ADD COLUMN statements via Drizzle).

2. **How post-gate holds output**
   - What we know: Container cleanup happens in the finally block. Output must survive until approval.
   - What's unclear: Best staging mechanism
   - Recommendation: Collect output normally (git branch created, files written to hostDir) but mark the run as `pending_output_approval` instead of `completed`. On approval, simply update status to `completed`. On rejection, clean up the output (delete branch/files). The output is already on the host at this point -- the container can be cleaned up.

3. **How pre-gate approval triggers execution**
   - What we know: Current dispatch is fire-and-forget in the orchestrator. CLI runs go through RunQueue.
   - What's unclear: How the approve endpoint triggers the actual execution
   - Recommendation: The approve handler should directly call the execution function (similar to how resume triggers re-execution). For orchestrator runs, it dispatches the worker. For CLI/daemon runs, it updates the queue entry status and processes it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GOVN-01 | Autonomy enum in WorkflowSchema accepts 4 levels, defaults to full | unit | `npx vitest run test/unit/governance-autonomy.test.ts -x` | No - Wave 0 |
| GOVN-01 | WorkflowFileConfig parses autonomy from YAML | unit | `npx vitest run test/unit/governance-autonomy.test.ts -x` | No - Wave 0 |
| GOVN-01 | Existing workflows without autonomy field default to full | unit | `npx vitest run test/unit/governance-autonomy.test.ts -x` | No - Wave 0 |
| GOVN-02 | Pre-gate: needsPreApproval returns true for semi/supervised | unit | `npx vitest run test/unit/governance-approval.test.ts -x` | No - Wave 0 |
| GOVN-02 | Post-gate: needsPostApproval returns true for interactive/supervised | unit | `npx vitest run test/unit/governance-approval.test.ts -x` | No - Wave 0 |
| GOVN-02 | Approve transitions pending_approval to running | unit | `npx vitest run test/unit/governance-approval.test.ts -x` | No - Wave 0 |
| GOVN-02 | Reject transitions pending_approval to rejected | unit | `npx vitest run test/unit/governance-approval.test.ts -x` | No - Wave 0 |
| GOVN-02 | Revision stores feedback and transitions to running | unit | `npx vitest run test/unit/governance-approval.test.ts -x` | No - Wave 0 |
| GOVN-02 | REST endpoints return proper error codes (404, 409) | unit | `npx vitest run test/unit/governance-routes.test.ts -x` | No - Wave 0 |
| GOVN-03 | Label match auto-approve | unit | `npx vitest run test/unit/governance-rules.test.ts -x` | No - Wave 0 |
| GOVN-03 | Workflow pattern auto-approve with picomatch | unit | `npx vitest run test/unit/governance-rules.test.ts -x` | No - Wave 0 |
| GOVN-03 | Cost threshold auto-approve (post-gate only) | unit | `npx vitest run test/unit/governance-rules.test.ts -x` | No - Wave 0 |
| GOVN-03 | AND logic: all conditions must pass | unit | `npx vitest run test/unit/governance-rules.test.ts -x` | No - Wave 0 |
| GOVN-03 | Cost threshold skipped when cost unknown (pre-gate) | unit | `npx vitest run test/unit/governance-rules.test.ts -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance* -x`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/governance-autonomy.test.ts` -- covers GOVN-01
- [ ] `test/unit/governance-approval.test.ts` -- covers GOVN-02
- [ ] `test/unit/governance-rules.test.ts` -- covers GOVN-03
- [ ] `test/unit/governance-routes.test.ts` -- covers GOVN-02 REST API

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all integration points:
  - `src/config/schema.ts` -- WorkflowSchema, zod patterns
  - `src/workflow/types.ts` -- WorkflowFileConfig, RunPlan
  - `src/workflow/map-front-matter.ts` -- front-matter to config mapping
  - `src/orchestrator/dispatcher.ts` -- dispatch flow, fire-and-forget pattern
  - `src/orchestration/single.ts` -- executeSingleAgent flow, gate insertion points
  - `src/durability/pause.ts` -- pattern for status transitions and context persistence
  - `src/daemon/routes.ts` -- REST API patterns, resume endpoint as template
  - `src/storage/schema.ts` -- runs table schema, existing columns
  - `src/storage/repositories/runs.ts` -- RunRepository interface, updateStatus pattern
  - `src/logging/events.ts` -- RunEvent types, emitRunEvent pattern
  - `src/orchestrator/comment.ts` -- RichCommentData with costEstimate

### Secondary (MEDIUM confidence)
- picomatch for workflow pattern matching -- already a project dependency, glob matching semantics well-established

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing infrastructure
- Architecture: HIGH -- follows established patterns (pause/resume, repository, routes)
- Pitfalls: HIGH -- identified through direct code analysis of execution flow

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable -- internal architecture, no external deps)
