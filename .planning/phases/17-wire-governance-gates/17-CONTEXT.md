# Phase 17: Wire Governance Gates - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Make governance gates actually fire during execution. GovernanceOpts flows from workflow config to dispatcher (pre-gate), and runRepo is available in DurabilityDeps for post-gate checks. All governance modules exist from Phase 13 — this phase is pure wiring.

</domain>

<decisions>
## Implementation Decisions

### Config flow path
- Scheduler tick reads autonomy/auto_approve from the already-merged ForgectlConfig and constructs GovernanceOpts before calling dispatchIssue()
- GovernanceOpts includes runRepo when available (daemon context); without runRepo, existing warn-and-proceed fallback applies
- Add optional runRepo field to TickDeps interface; Orchestrator passes it from daemon context
- Dispatcher creates a run record in runRepo (status: 'queued') before evaluating pre-gate, giving a real runId for pending_approval

### RunQueue post-gate wiring
- Add runRepo to the DurabilityDeps object passed to executeRun() in RunQueue callback (DurabilityDeps already has optional runRepo field — just set it in server.ts)
- Post-gate reads autonomy/auto_approve from plan.workflow (already wired in single.ts:241-252)
- RunQueue does NOT override pending_output_approval status — approve/reject REST endpoints handle final transition
- Empty labels array in post-gate auto-approve evaluation is acceptable for now (cost threshold and workflow pattern are primary post-gate conditions)

### Webhook dispatch path
- GitHub webhook-triggered dispatch gets the same governance as polling — consistent behavior across all dispatch paths
- Orchestrator builds GovernanceOpts internally from its config (single source of truth — all dispatch paths get governance)
- Verify wiring compiles and imports resolve; no full E2E integration test in this phase
- Orchestrator class gains optional runRepo field via OrchestratorOptions; uses it for both dispatchIssue() GovernanceOpts and TickDeps

### Graceful fallback behavior
- Keep existing warn-and-proceed when runRepo unavailable (Phase 13 decision preserved)
- CLI runs through RunQueue also respect governance gates (if workflow config has autonomy != full, post-gate applies)
- When CLI run enters pending_output_approval, print actionable approve instruction (e.g., curl command to approve endpoint)
- Wire governance config into workflow resolver (resolveRunPlan) so plan.workflow carries autonomy/auto_approve fields

### Claude's Discretion
- Exact run record fields when creating 'queued' status in dispatcher
- How Orchestrator constructor receives and stores runRepo
- Whether to update OrchestratorOptions type or use a separate setter
- Test structure for wiring verification

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/governance/types.ts`: AutonomyLevel, AutoApproveRule, AutoApproveContext types — ready to use
- `src/governance/autonomy.ts`: needsPreApproval(), needsPostApproval() — already imported in dispatcher.ts and single.ts
- `src/governance/approval.ts`: enterPendingApproval(), enterPendingOutputApproval() — already imported
- `src/governance/rules.ts`: evaluateAutoApprove() — already imported
- `src/orchestrator/dispatcher.ts`: GovernanceOpts interface already defined (line 18-23), pre-gate logic already implemented (lines 208-232)
- `src/orchestration/single.ts`: Post-gate logic already implemented (lines 241-265), DurabilityDeps has optional runRepo field

### Established Patterns
- TickDeps interface for scheduler dependencies — extend with runRepo
- DurabilityDeps interface for execution dependencies — runRepo field exists but unused
- OrchestratorOptions for constructor injection — extend with runRepo
- 4-layer config merge: defaults < yaml < WORKFLOW.md < CLI flags — autonomy/auto_approve already in merged config
- Fire-and-forget dispatch: `void executeWorkerAndHandle()` — pre-gate inserted before this

### Integration Points
- `src/orchestrator/scheduler.ts:70`: dispatchIssue() call — add GovernanceOpts parameter
- `src/orchestrator/index.ts:201`: dispatchIssueImpl() call — add GovernanceOpts from internal config
- `src/daemon/server.ts:75`: executeRun() call — add runRepo to DurabilityDeps
- `src/daemon/server.ts:115`: Orchestrator construction — pass runRepo
- `src/workflow/resolver.ts`: resolveRunPlan() — ensure plan.workflow carries autonomy/auto_approve

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 17-wire-governance-gates*
*Context gathered: 2026-03-11*
