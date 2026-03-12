---
phase: 17-wire-governance-gates
verified: 2026-03-11T05:35:00Z
status: passed
score: 6/6 must-haves verified
---

# Phase 17: Wire Governance Gates Verification Report

**Phase Goal:** Governance gates actually fire during execution -- GovernanceOpts flows from workflow config to dispatcher, and runRepo is available for post-gate checks
**Verified:** 2026-03-11T05:35:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | GovernanceOpts flows from scheduler tick to dispatchIssue() | VERIFIED | scheduler.ts:74-76 builds GovernanceOpts from deps.runRepo/autonomy/autoApprove; line 80 passes as 9th arg. Test confirms in governance-wiring.test.ts. |
| 2 | Orchestrator.dispatchIssue() builds GovernanceOpts from internal config and runRepo | VERIFIED | index.ts:215-221 builds GovernanceOpts when this.runRepo present; line 231 passes as 9th arg. Test confirms. |
| 3 | RunQueue in server.ts passes runRepo in DurabilityDeps so post-gate can fire | VERIFIED | server.ts:75 passes `{ snapshotRepo, lockRepo, daemonPid: currentPid, runRepo }` to executeRun. single.ts:179 destructures runRepo from deps; line 242 uses it for post-gate. |
| 4 | Orchestrator receives runRepo via OrchestratorOptions | VERIFIED | index.ts:21 declares `runRepo?: RunRepository` on OrchestratorOptions; constructor stores at line 53. server.ts:117 passes runRepo to Orchestrator constructor. |
| 5 | resolveRunPlan() carries WORKFLOW.MD autonomy/auto_approve overrides onto plan.workflow | VERIFIED | resolver.ts:10-13 defines WorkflowOverrides interface; line 93-106 accepts optional parameter and spreads onto workflow. Test confirms autonomy override to "semi" works. |
| 6 | evaluateAutoApprove is reachable through the normal execution path | VERIFIED | Pre-gate: dispatcher.ts:215 calls evaluateAutoApprove when governance?.autoApprove present. Post-gate: single.ts:252 calls evaluateAutoApprove when plan.workflow.auto_approve present and runRepo available. Both paths are now wired. |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/orchestrator/index.ts` | OrchestratorOptions with runRepo, dispatchIssue with governance | VERIFIED | runRepo/autonomy/autoApprove on interface (lines 21-23), stored in constructor (53-55), GovernanceOpts built and passed (215-232) |
| `src/orchestrator/scheduler.ts` | TickDeps with runRepo, governance opts passed to dispatch | VERIFIED | runRepo/autonomy/autoApprove on TickDeps (25-27), GovernanceOpts built at lines 74-76, passed at line 80 |
| `src/daemon/server.ts` | runRepo wired into DurabilityDeps and OrchestratorOptions | VERIFIED | DurabilityDeps includes runRepo at line 75; Orchestrator constructor at lines 115-120 passes runRepo, autonomy, autoApprove |
| `src/workflow/resolver.ts` | WORKFLOW.MD autonomy/auto_approve override in RunPlan | VERIFIED | WorkflowOverrides interface at lines 10-13; resolveRunPlan accepts optional 3rd parameter at line 96; spreads onto workflow at lines 100-106 |
| `test/unit/governance-wiring.test.ts` | Wiring verification tests (min 40 lines) | VERIFIED | 221 lines, 7 test cases all passing: scheduler with/without governance, orchestrator with/without governance, resolver overrides (autonomy, auto_approve, default) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/daemon/server.ts` | `src/orchestrator/index.ts` | OrchestratorOptions.runRepo | WIRED | server.ts:117 passes `runRepo` in Orchestrator constructor options |
| `src/orchestrator/scheduler.ts` | `src/orchestrator/dispatcher.ts` | GovernanceOpts parameter | WIRED | scheduler.ts:80 passes `governance` as 9th argument to dispatchIssue() |
| `src/daemon/server.ts` | `src/orchestration/single.ts` | DurabilityDeps.runRepo | WIRED | server.ts:75 includes runRepo in DurabilityDeps; single.ts:179 destructures it; single.ts:242 uses it in post-gate |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| GOVN-01 | 17-01 | Configurable autonomy levels per workflow in WORKFLOW.MD | SATISFIED | autonomy field flows from WorkflowOverrides through resolveRunPlan (resolver.ts:100-106), from server.ts WORKFLOW.MD config (server.ts:118) through Orchestrator to dispatcher GovernanceOpts (index.ts:217), and through TickDeps to scheduler tick (scheduler.ts:75) |
| GOVN-02 | 17-01 | Approval state machine (pending -> approved/rejected/revision_requested) | SATISFIED | Pre-gate in dispatcher.ts and post-gate in single.ts are now reachable through wired GovernanceOpts and runRepo respectively; enterPendingOutputApproval called at single.ts:256 |
| GOVN-03 | 17-01 | Auto-approve rules bypass approval gate when conditions met | SATISFIED | evaluateAutoApprove reachable at dispatcher.ts:215 (pre-gate) and single.ts:252 (post-gate); both paths now have GovernanceOpts/runRepo wired in |

No orphaned requirements found -- REQUIREMENTS.MD maps GOVN-01, GOVN-02, GOVN-03 to Phase 17, matching plan claims.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | -- | -- | -- | No anti-patterns detected in modified files |

### Human Verification Required

### 1. End-to-end governance gate with real WORKFLOW.MD

**Test:** Configure a WORKFLOW.MD with `autonomy: semi`, start daemon with orchestrator enabled, trigger a run via GitHub webhook or tracker issue.
**Expected:** Pre-gate in dispatcher should evaluate autonomy level and block the run pending approval (not auto-execute).
**Why human:** Requires running daemon with real tracker config and observing runtime behavior.

### 2. Post-gate approval flow with runRepo

**Test:** Execute a run with `autonomy: supervised` through the daemon RunQueue path, verify the output enters pending_output_approval state.
**Expected:** After agent completes work, single.ts post-gate should call enterPendingOutputApproval and the run status should be waiting for approval.
**Why human:** Requires database state inspection after a full run lifecycle.

---

_Verified: 2026-03-11T05:35:00Z_
_Verifier: Claude (gsd-verifier)_
