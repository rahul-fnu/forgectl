# Requirements: forgectl

**Defined:** 2026-03-12
**Core Value:** Continuously pull work from issue trackers, dispatch AI agents, validate, report back — zero human intervention.

## v2.1 Requirements

Requirements for v2.1 Autonomous Factory milestone. Each maps to roadmap phases.

### Delegation

- [ ] **DELEG-01**: Lead agent decomposes a complex issue into structured subtask specs (id, task, workflow, agent)
- [ ] **DELEG-02**: Orchestrator dispatches child workers concurrently from subtask specs (via SyntheticIssue adapter)
- [ ] **DELEG-03**: Per-issue `maxChildren` budget enforced from WORKFLOW.md config
- [ ] **DELEG-04**: Delegation depth hard-capped at 2 (lead + workers, no further nesting)
- [ ] **DELEG-05**: Parent/child run relationships persisted in SQLite (parentRunId, survives daemon restart)
- [ ] **DELEG-06**: Two-tier slot pool prevents child agents from starving top-level work
- [ ] **DELEG-07**: Child results collected and aggregated after all children complete
- [ ] **DELEG-08**: On child failure, lead re-issues subtask with updated instructions incorporating failure context
- [ ] **DELEG-09**: Lead agent synthesizes all child results into one coherent summary for write-back

### Conditional Pipelines

- [x] **COND-01**: PipelineNode supports `condition` field with safe expression evaluation (filtrex)
- [x] **COND-02**: Executor refactored from static topological sort to ready-queue model for runtime branching
- [x] **COND-03**: `else_node` field routes execution to alternate branch when condition is false
- [x] **COND-04**: `if_failed` / `if_passed` YAML shorthand resolves to condition expressions
- [x] **COND-05**: Skipped nodes marked as `skipped` status (visible in pipeline status and API)
- [x] **COND-06**: Condition evaluation errors are fatal (no silent skipping)
- [x] **COND-07**: `--dry-run` shows which nodes would be skipped given hypothetical conditions

### Loop Pipelines

- [x] **LOOP-01**: PipelineNode supports `loop` field with `until` expression and `max_iterations`
- [x] **LOOP-02**: Loops modeled as opaque meta-nodes (no DAG back-edges, compatible with cycle detector)
- [x] **LOOP-03**: Global max_iterations safety cap enforced regardless of YAML value
- [x] **LOOP-04**: Loop iteration counter tracked in NodeExecution and exposed via REST API
- [x] **LOOP-05**: Per-iteration checkpoint for crash recovery mid-loop

### Self-Correction

- [ ] **CORR-01**: Test-fail → fix → retest pipeline pattern using loop nodes with failure output as context
- [ ] **CORR-02**: Fix agent excluded from modifying test files via WORKFLOW.md exclude list
- [ ] **CORR-03**: Each fix iteration includes history of all previous attempts (progressive context)
- [ ] **CORR-04**: Coverage self-correction: loop until coverage >= threshold with structured output parsing
- [ ] **CORR-05**: Clean exhaustion failure when max_iterations reached ("self-correction exhausted after N iterations")

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Delegation

- **DELEG-F01**: Lead agent creates sub-issues in tracker for each subtask (requires TrackerAdapter.createIssue)
- **DELEG-F02**: Per-child autonomy level override (inherited from lead, overridable per subtask spec)

### Self-Correction

- **CORR-F01**: Governance approval gate per loop iteration (approval required before each fix attempt)
- **CORR-F02**: Multi-trigger self-correction (lint + test + coverage as one composite loop)

### Pipeline

- **PIPE-F01**: Nested conditional subgraphs (if inside loop, depth > 2)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unlimited delegation depth | Each level multiplies agents, API calls, and cost. Depth=2 sufficient for v2.1. |
| Turing-complete condition expressions | Security and debuggability risk. Safe expression subset only. |
| Runtime pipeline modification (adding nodes dynamically) | Makes checkpoint/resume fragile. All nodes declared statically in YAML. |
| Parallel alternative fix attempts | Merge conflicts from parallel fixes touching same files. Sequential only. |
| Agents weakening tests | Fix agents must be excluded from test file modifications. |
| External API calls in conditions | Non-deterministic, hard to checkpoint. Conditions reference node results only. |
| Distributed multi-worker (BullMQ/Redis) | Single-machine SQLite sufficient. Revisit when distributed execution is in scope. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DELEG-01 | Phase 23 | Pending |
| DELEG-02 | Phase 23 | Pending |
| DELEG-03 | Phase 23 | Pending |
| DELEG-04 | Phase 23 | Pending |
| DELEG-05 | Phase 23 | Pending |
| DELEG-06 | Phase 23 | Pending |
| DELEG-07 | Phase 23 | Pending |
| DELEG-08 | Phase 23 | Pending |
| DELEG-09 | Phase 23 | Pending |
| COND-01 | Phase 21 | Complete |
| COND-02 | Phase 21 | Complete |
| COND-03 | Phase 21 | Complete |
| COND-04 | Phase 21 | Complete |
| COND-05 | Phase 21 | Complete |
| COND-06 | Phase 21 | Complete |
| COND-07 | Phase 21 | Complete |
| LOOP-01 | Phase 22 | Complete |
| LOOP-02 | Phase 22 | Complete |
| LOOP-03 | Phase 22 | Complete |
| LOOP-04 | Phase 22 | Complete |
| LOOP-05 | Phase 22 | Complete |
| CORR-01 | Phase 24 | Pending |
| CORR-02 | Phase 24 | Pending |
| CORR-03 | Phase 24 | Pending |
| CORR-04 | Phase 24 | Pending |
| CORR-05 | Phase 24 | Pending |

**Coverage:**
- v2.1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-12*
*Last updated: 2026-03-12 after roadmap creation — all 26 requirements mapped*
