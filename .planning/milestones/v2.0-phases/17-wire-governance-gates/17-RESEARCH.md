# Phase 17: Wire Governance Gates - Research

**Researched:** 2026-03-11
**Domain:** Governance gate wiring (integration/plumbing, not new modules)
**Confidence:** HIGH

## Summary

Phase 17 is a pure wiring phase. All governance modules exist from Phase 13 (autonomy.ts, approval.ts, rules.ts, types.ts). All governance logic is already implemented in dispatcher.ts (pre-gate, lines 207-232) and single.ts (post-gate, lines 240-265). The gap is that no caller actually passes GovernanceOpts to dispatchIssue() or runRepo to DurabilityDeps in server.ts, so governance gates never fire.

There are exactly five integration points to wire: (1) scheduler tick passes GovernanceOpts to dispatchIssue(), (2) Orchestrator.dispatchIssue() passes GovernanceOpts, (3) server.ts RunQueue passes runRepo in DurabilityDeps, (4) Orchestrator gains optional runRepo via OrchestratorOptions, and (5) resolveRunPlan() carries autonomy/auto_approve from WorkflowDefinition into RunPlan. Additionally, mapFrontMatterToConfig() needs to forward autonomy and auto_approve fields from WORKFLOW.md front matter.

**Primary recommendation:** Wire existing governance code into the execution paths with minimal changes -- extend interfaces, pass parameters, verify with unit tests.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Scheduler tick reads autonomy/auto_approve from the already-merged ForgectlConfig and constructs GovernanceOpts before calling dispatchIssue()
- GovernanceOpts includes runRepo when available (daemon context); without runRepo, existing warn-and-proceed fallback applies
- Add optional runRepo field to TickDeps interface; Orchestrator passes it from daemon context
- Dispatcher creates a run record in runRepo (status: 'queued') before evaluating pre-gate, giving a real runId for pending_approval
- Add runRepo to the DurabilityDeps object passed to executeRun() in RunQueue callback (DurabilityDeps already has optional runRepo field -- just set it in server.ts)
- Post-gate reads autonomy/auto_approve from plan.workflow (already wired in single.ts:241-252)
- RunQueue does NOT override pending_output_approval status -- approve/reject REST endpoints handle final transition
- Empty labels array in post-gate auto-approve evaluation is acceptable for now
- GitHub webhook-triggered dispatch gets the same governance as polling
- Orchestrator builds GovernanceOpts internally from its config (single source of truth)
- Verify wiring compiles and imports resolve; no full E2E integration test in this phase
- Orchestrator class gains optional runRepo field via OrchestratorOptions
- Keep existing warn-and-proceed when runRepo unavailable
- CLI runs through RunQueue also respect governance gates (if workflow config has autonomy != full, post-gate applies)
- When CLI run enters pending_output_approval, print actionable approve instruction
- Wire governance config into workflow resolver (resolveRunPlan) so plan.workflow carries autonomy/auto_approve fields

### Claude's Discretion
- Exact run record fields when creating 'queued' status in dispatcher
- How Orchestrator constructor receives and stores runRepo
- Whether to update OrchestratorOptions type or use a separate setter
- Test structure for wiring verification

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GOVN-01 | Configurable autonomy levels per workflow (full/semi/interactive/supervised) in WORKFLOW.md | WorkflowSchema already has `autonomy` field with default "full". WorkflowFileConfig has `autonomy` field. mapFrontMatterToConfig() needs to forward it. resolveRunPlan() must carry it into RunPlan.workflow. |
| GOVN-02 | Approval state machine (pending -> approved/rejected/revision_requested) | Fully implemented in approval.ts. enterPendingApproval/enterPendingOutputApproval called by dispatcher.ts and single.ts. approveRun/rejectRun/requestRevision available via REST endpoints. Gap: no runRepo/runId reach these call sites. |
| GOVN-03 | Auto-approve rules (cost < $X, files < N, specific label, workflow pattern) | evaluateAutoApprove() fully implemented in rules.ts. Already called in dispatcher.ts:215 (pre-gate) and single.ts:252 (post-gate). Gap: GovernanceOpts never passed to dispatcher, so pre-gate auto-approve unreachable. |
</phase_requirements>

## Standard Stack

### Core
No new libraries. This phase uses existing modules only:

| Module | Path | Purpose | Status |
|--------|------|---------|--------|
| governance/types.ts | src/governance/types.ts | AutonomyLevel, AutoApproveRule, AutoApproveContext | Complete |
| governance/autonomy.ts | src/governance/autonomy.ts | needsPreApproval(), needsPostApproval() | Complete |
| governance/approval.ts | src/governance/approval.ts | enterPendingApproval(), enterPendingOutputApproval() | Complete |
| governance/rules.ts | src/governance/rules.ts | evaluateAutoApprove() | Complete |
| orchestrator/dispatcher.ts | src/orchestrator/dispatcher.ts | GovernanceOpts interface, pre-gate logic | Complete, needs callers |
| orchestration/single.ts | src/orchestration/single.ts | DurabilityDeps, post-gate logic | Complete, needs runRepo |

## Architecture Patterns

### Current Wiring Gaps (Exact Locations)

```
Gap 1: scheduler.ts:70
  dispatchIssue(issue, state, tracker, config, ..., logger, metrics)
  MISSING: governance parameter (9th arg)
  FIX: Build GovernanceOpts from config + deps.runRepo, pass as 9th arg

Gap 2: orchestrator/index.ts:201-210
  dispatchIssueImpl(issue, state, tracker, config, ..., logger, metrics)
  MISSING: governance parameter
  FIX: Build GovernanceOpts from this.config + this.runRepo

Gap 3: daemon/server.ts:75
  executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid })
  MISSING: runRepo in DurabilityDeps
  FIX: Add runRepo field: { snapshotRepo, lockRepo, daemonPid: currentPid, runRepo }

Gap 4: OrchestratorOptions (index.ts:13-19)
  MISSING: runRepo field
  FIX: Add optional runRepo?: RunRepository

Gap 5: Orchestrator constructor (index.ts:39-45)
  Does not store runRepo
  FIX: Store as private field, use in dispatchIssue() and deps

Gap 6: server.ts:115
  new Orchestrator({ tracker, workspaceManager, config, promptTemplate, logger })
  MISSING: runRepo in constructor
  FIX: Add runRepo to options

Gap 7: resolveRunPlan() (resolver.ts:113-174)
  RunPlan.workflow = workflow (WorkflowDefinition)
  WorkflowDefinition already has autonomy/auto_approve fields (schema.ts:71-72)
  WORKS: plan.workflow.autonomy and plan.workflow.auto_approve are already populated
  NOTE: No gap here -- WorkflowDefinition includes these fields via WorkflowSchema

Gap 8: mapFrontMatterToConfig() (map-front-matter.ts)
  MISSING: Does not forward autonomy or auto_approve from front matter
  FIX: Map fm.autonomy and fm.auto_approve to result -- but these are workflow-level
  ACTUALLY: These are on WorkflowDefinition, not ForgectlConfig. The resolver uses
  getWorkflow() which returns WorkflowDefinition (already has autonomy/auto_approve).
  For WORKFLOW.md front matter overrides to work, they go through WorkflowFileConfig
  which already has autonomy/auto_approve fields -- but the override path for these
  fields does NOT go through mapFrontMatterToConfig (which maps to ForgectlConfig).
  The WORKFLOW.md prompt template and validation override the built-in workflow's values
  but autonomy/auto_approve from WORKFLOW.md front matter are NOT applied to the
  WorkflowDefinition used by the resolver.
```

### Gap 8 Analysis: WORKFLOW.md autonomy override path

The current flow for WORKFLOW.md config:
1. `loadWorkflowFile()` parses front matter into `WorkflowFileConfig` (has autonomy/auto_approve)
2. `mapFrontMatterToConfig()` maps WorkflowFileConfig to Partial<ForgectlConfig> (does NOT map autonomy/auto_approve)
3. `mergeWorkflowConfig()` merges into ForgectlConfig
4. `resolveRunPlan()` calls `getWorkflow(workflowName)` which returns a built-in WorkflowDefinition

The autonomy/auto_approve fields live on WorkflowDefinition (schema.ts:71-72), NOT on ForgectlConfig. So the 4-layer merge for ForgectlConfig does not affect them. The built-in workflow definitions will have `autonomy: "full"` (the default) and no auto_approve.

For GOVN-01 to work end-to-end, the WORKFLOW.md front matter `autonomy` and `auto_approve` must override the built-in workflow's values. This could be done by:
- Having the merged ForgectlConfig carry governance fields and having single.ts read from config instead of plan.workflow
- OR having resolveRunPlan spread autonomy/auto_approve from the loaded WorkflowFileConfig onto the WorkflowDefinition in the RunPlan

The second approach is cleaner since single.ts already reads `plan.workflow.autonomy` (line 241). The resolver should override `workflow.autonomy` and `workflow.auto_approve` from the loaded WorkflowFileConfig when available.

For orchestrator path: the Orchestrator holds `mergedConfig` which could carry these fields if we add them to ForgectlConfig or pass them separately. But the orchestrator calls dispatcher.ts which takes GovernanceOpts directly. The orchestrator can read autonomy/auto_approve from the WorkflowFileConfig that was loaded.

**Resolution:** For the scheduler/orchestrator path, build GovernanceOpts from the WorkflowFileConfig loaded in server.ts. For the CLI/RunQueue path, resolveRunPlan should carry governance fields on plan.workflow (which it already does via WorkflowDefinition schema defaults, but WORKFLOW.md overrides are lost).

### Pattern: Building GovernanceOpts

```typescript
// In scheduler tick or Orchestrator.dispatchIssue()
const governance: GovernanceOpts = {
  autonomy: config.workflow?.autonomy ?? "full",  // Need to determine source
  autoApprove: config.workflow?.auto_approve,
  runRepo: deps.runRepo,
  // runId: created by dispatcher before pre-gate evaluation
};
```

### Pattern: Creating run record in dispatcher

```typescript
// In executeWorkerAndHandle(), before pre-gate check
let runId = governance?.runId;
if (governance?.runRepo && !runId) {
  // Create a run record with 'queued' status
  const created = governance.runRepo.create({
    task: issue.title,
    workflow: promptTemplate,
    status: "queued",
    options: {},  // minimal
  });
  runId = created.id;
}
```

### Pattern: Extending OrchestratorOptions

```typescript
export interface OrchestratorOptions {
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  runRepo?: RunRepository;  // NEW: optional, set in daemon context
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Approval state transitions | Custom state checks | approval.ts functions | Already handles all transitions, events, validation |
| Pre/post gate evaluation | Inline autonomy checks | autonomy.ts needsPre/PostApproval | Centralized, tested |
| Auto-approve logic | Custom rule matching | rules.ts evaluateAutoApprove | Handles AND logic, picomatch globs, cost thresholds |
| Run record creation | Manual SQL inserts | runRepo.create() | Typed repository pattern, handles JSON serialization |

## Common Pitfalls

### Pitfall 1: Missing runId for pending_approval
**What goes wrong:** Dispatcher calls enterPendingApproval() but has no runId because no run record was created yet.
**Why it happens:** The current dispatcher pre-gate (line 217) checks `governance?.runRepo && governance?.runId` -- both must be present.
**How to avoid:** Create a run record with 'queued' status BEFORE evaluating the pre-gate. Use the returned id for enterPendingApproval().
**Warning signs:** Pre-gate falls through to warn-and-proceed even when runRepo is available.

### Pitfall 2: Governance opts not reaching webhook dispatch
**What goes wrong:** Webhook-triggered orchestrator.dispatchIssue() skips governance because the method doesn't build GovernanceOpts.
**Why it happens:** Orchestrator.dispatchIssue() (index.ts:196-211) calls dispatchIssueImpl without governance parameter.
**How to avoid:** Build GovernanceOpts inside Orchestrator.dispatchIssue() from this.config and this.runRepo, same as scheduler path.

### Pitfall 3: WorkflowDefinition autonomy not overridden from WORKFLOW.md
**What goes wrong:** User sets `autonomy: semi` in WORKFLOW.md front matter, but plan.workflow.autonomy is still "full".
**Why it happens:** mapFrontMatterToConfig maps to ForgectlConfig, but autonomy lives on WorkflowDefinition (different type). The built-in workflow from getWorkflow() always has default "full".
**How to avoid:** In resolveRunPlan(), after getting the built-in workflow, check the loaded WorkflowFileConfig for autonomy/auto_approve overrides and spread them onto the workflow object before building RunPlan.

### Pitfall 4: RunQueue DurabilityDeps missing runRepo
**What goes wrong:** Post-gate in single.ts checks `runRepo` from DurabilityDeps but it's undefined, so post-gate silently skips.
**Why it happens:** server.ts line 75 constructs DurabilityDeps without runRepo even though runRepo is created on line 48.
**How to avoid:** Add `runRepo` to the DurabilityDeps object on line 75 of server.ts.

### Pitfall 5: RunRepository.create() signature mismatch
**What goes wrong:** Dispatcher tries to create a run record but the create() method expects different fields.
**How to avoid:** Check the actual RunRepository.create() signature before implementing.

## Code Examples

### Integration Point 1: scheduler.ts -- Pass GovernanceOpts

```typescript
// scheduler.ts tick() function, line 69-71
// BEFORE:
for (const issue of sorted.slice(0, available)) {
  dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics);
}

// AFTER:
const governance: GovernanceOpts | undefined = deps.runRepo
  ? {
      autonomy: (config as any).workflow?.autonomy ?? "full",  // needs proper typing
      autoApprove: (config as any).workflow?.auto_approve,
      runRepo: deps.runRepo,
    }
  : undefined;

for (const issue of sorted.slice(0, available)) {
  dispatchIssue(issue, state, tracker, config, workspaceManager, promptTemplate, logger, metrics, governance);
}
```

### Integration Point 2: server.ts -- Wire runRepo into RunQueue

```typescript
// server.ts line 71-76
// BEFORE:
const queue = new RunQueue(runRepo, async (run: QueuedRun) => {
  const runConfig = loadConfig();
  const plan = resolveRunPlan(runConfig, run.options);
  const logger = new Logger(false);
  return executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid });
});

// AFTER:
const queue = new RunQueue(runRepo, async (run: QueuedRun) => {
  const runConfig = loadConfig();
  const plan = resolveRunPlan(runConfig, run.options);
  const logger = new Logger(false);
  return executeRun(plan, logger, false, { snapshotRepo, lockRepo, daemonPid: currentPid, runRepo });
});
```

### Integration Point 3: OrchestratorOptions + constructor

```typescript
// orchestrator/index.ts
export interface OrchestratorOptions {
  tracker: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  config: ForgectlConfig;
  promptTemplate: string;
  logger: Logger;
  runRepo?: RunRepository;  // NEW
}

// In constructor:
private readonly runRepo?: RunRepository;
constructor(opts: OrchestratorOptions) {
  // ... existing ...
  this.runRepo = opts.runRepo;
}
```

### Integration Point 4: Orchestrator.dispatchIssue with governance

```typescript
// orchestrator/index.ts dispatchIssue method
dispatchIssue(issue: TrackerIssue): void {
  if (!this.running) {
    this.logger.warn("orchestrator", `dispatchIssue called but orchestrator not running`);
    return;
  }

  const governance: GovernanceOpts | undefined = this.runRepo
    ? {
        autonomy: this.config.workflow?.autonomy ?? "full",  // needs proper source
        autoApprove: this.config.workflow?.auto_approve,
        runRepo: this.runRepo,
      }
    : undefined;

  dispatchIssueImpl(
    issue, this.state, this.tracker, this.config,
    this.workspaceManager, this.promptTemplate,
    this.logger, this.metrics, governance,
  );
}
```

## State of the Art

| Component | Status | What Exists | What's Missing |
|-----------|--------|-------------|----------------|
| GovernanceOpts interface | Complete | dispatcher.ts:18-23 | No callers pass it |
| Pre-gate logic | Complete | dispatcher.ts:207-232 | Not reachable |
| Post-gate logic | Complete | single.ts:240-265 | No runRepo in deps |
| Auto-approve evaluation | Complete | rules.ts | Not reachable |
| Approval state machine | Complete | approval.ts | Works, just unreachable |
| REST approve/reject | Complete | governance routes | Works independently |
| WorkflowDefinition schema | Complete | schema.ts:71-72 | Has autonomy/auto_approve |
| WORKFLOW.md parsing | Complete | WorkflowFileConfig | Has autonomy/auto_approve fields |
| mapFrontMatterToConfig | Incomplete | map-front-matter.ts | Does NOT map autonomy/auto_approve |

## Open Questions

1. **How does the orchestrator determine autonomy level?**
   - What we know: ForgectlConfig does not have a top-level autonomy field. WorkflowDefinition does.
   - What's unclear: The 4-layer merged config is a ForgectlConfig, which doesn't carry autonomy. The orchestrator holds mergedConfig (ForgectlConfig) and promptTemplate (string), not a WorkflowFileConfig.
   - Recommendation: The Orchestrator should extract autonomy/auto_approve from the WorkflowFileConfig during setup and store them. Or, use the WorkflowDefinition loaded via getWorkflow(). The simplest approach: store autonomy/auto_approve as fields on Orchestrator, read from the loaded WorkflowFileConfig in server.ts, and pass to OrchestratorOptions.

2. **Run record creation in dispatcher**
   - What we know: RunRepository.create() exists. Dispatcher needs a runId before calling enterPendingApproval().
   - What's unclear: Exact create() method signature and required fields.
   - Recommendation: Check RunRepository.create() signature during implementation. Create with minimal fields (task, status: 'queued', workflow name).

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
| GOVN-01 | GovernanceOpts built from config and passed to dispatchIssue | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | Wave 0 |
| GOVN-01 | resolveRunPlan carries autonomy/auto_approve on plan.workflow | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/resolver.test.ts -x` | Existing (may need new cases) |
| GOVN-02 | RunQueue passes runRepo in DurabilityDeps to executeRun | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | Wave 0 |
| GOVN-02 | Orchestrator.dispatchIssue includes governance opts | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | Wave 0 |
| GOVN-03 | evaluateAutoApprove reachable through normal execution path | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-rules.test.ts -x` | Existing |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before /gsd:verify-work

### Wave 0 Gaps
- [ ] `test/unit/governance-wiring.test.ts` -- covers GOVN-01, GOVN-02, GOVN-03 wiring verification
- Existing governance tests (autonomy, approval, rules, routes) should continue to pass unchanged

## Sources

### Primary (HIGH confidence)
- Direct source code analysis of all integration points
- src/orchestrator/dispatcher.ts -- GovernanceOpts interface, pre-gate implementation
- src/orchestration/single.ts -- DurabilityDeps, post-gate implementation
- src/daemon/server.ts -- RunQueue callback, Orchestrator construction
- src/orchestrator/scheduler.ts -- TickDeps, dispatchIssue call
- src/orchestrator/index.ts -- OrchestratorOptions, Orchestrator class
- src/workflow/resolver.ts -- resolveRunPlan
- src/config/schema.ts -- WorkflowSchema (autonomy, auto_approve)
- src/workflow/map-front-matter.ts -- missing autonomy/auto_approve forwarding

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all modules exist and are complete
- Architecture: HIGH - all integration points identified with exact line numbers
- Pitfalls: HIGH - identified from actual code gaps, not hypothetical

**Research date:** 2026-03-11
**Valid until:** 2026-04-11 (stable -- internal wiring, no external dependencies)
