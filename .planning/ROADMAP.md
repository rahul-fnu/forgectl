# Roadmap: forgectl

## Milestones

- ✅ **v1.0 Core Orchestrator** — Phases 1-9 (shipped 2026-03-09)
- ✅ **v2.0 Durable Runtime** — Phases 10-19 (shipped 2026-03-12)
- 🚧 **v2.1 Autonomous Factory** — Phases 20-24 (in progress)

## Phases

<details>
<summary>✅ v1.0 Core Orchestrator (Phases 1-9) — SHIPPED 2026-03-09</summary>

- [x] Phase 1: Tracker Adapter Interface + GitHub Issues + Notion (4/4 plans)
- [x] Phase 2: Workspace Management (2/2 plans)
- [x] Phase 3: WORKFLOW.md Contract (2/2 plans)
- [x] Phase 4: Agent Session Abstraction (3/3 plans)
- [x] Phase 5: Orchestration State Machine (4/4 plans)
- [x] Phase 6: Observability + API Extensions (3/3 plans)
- [x] Phase 7: End-to-End Integration + Demo (3/3 plans)
- [x] Phase 8: Wire Workflow Runtime Integration (2/2 plans)
- [x] Phase 9: Fix GitHub Adapter ID/Identifier Mismatch (1/1 plan)

Full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

<details>
<summary>✅ v2.0 Durable Runtime (Phases 10-19) — SHIPPED 2026-03-12</summary>

- [x] Phase 10: Persistent Storage Layer (2/2 plans) — completed 2026-03-09
- [x] Phase 11: Flight Recorder (2/2 plans) — completed 2026-03-10
- [x] Phase 12: Durable Execution (3/3 plans) — completed 2026-03-10
- [x] Phase 13: Governance & Approvals (2/2 plans) — completed 2026-03-10
- [x] Phase 14: GitHub App (5/5 plans) — completed 2026-03-10
- [x] Phase 15: Browser-Use Integration (2/2 plans) — completed 2026-03-10
- [x] Phase 16: Wire Flight Recorder (1/1 plan) — completed 2026-03-11
- [x] Phase 17: Wire Governance Gates (1/1 plan) — completed 2026-03-11
- [x] Phase 18: Wire GitHub App Utilities (3/3 plans) — completed 2026-03-12
- [x] Phase 19: Wire Post-Gate Worker (1/1 plan) — completed 2026-03-12

Full details: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

</details>

### v2.1 Autonomous Factory (In Progress)

**Milestone Goal:** Enable forgectl to autonomously decompose complex issues into subtasks, delegate to child agents, and self-correct through conditional/loop pipeline nodes.

- [x] **Phase 20: Schema Foundation** — SQLite migration and PipelineNode type extensions that all v2.1 features depend on
- [x] **Phase 21: Conditional Pipeline Nodes** — if/else branch routing with safe expression evaluation and executor ready-queue refactor (completed 2026-03-13)
- [x] **Phase 22: Loop Pipeline Nodes** — loop-until iteration with max_iterations cap, per-iteration checkpoints, and crash recovery (completed 2026-03-13)
- [x] **Phase 23: Multi-Agent Delegation** — lead agent decomposes issues, dispatches concurrent child workers with slot budgeting and workspace isolation (completed 2026-03-13)
- [ ] **Phase 24: Self-Correction Integration** — test-fail/fix/retest pattern composing loop nodes with progressive context and no-progress detection

## Phase Details

### Phase 20: Schema Foundation
**Goal**: All v2.1 features have the schema and types they depend on — no behavioral change visible to users, pure foundation
**Depends on**: Nothing (v2.0 shipped)
**Requirements**: None (foundation phase — enables all v2.1 requirements but delivers no user-observable behavior itself)
**Success Criteria** (what must be TRUE):
  1. Drizzle migration runs cleanly on a v2.0 database and adds `parentRunId`, `role`, `depth`, `maxChildren`, `childrenDispatched` columns to the `runs` table
  2. A new `delegations` table exists in the schema with a typed Drizzle repository and working CRUD operations
  3. `PipelineNode` interface and Zod schema accept `node_type`, `condition`, and `loop` fields without breaking any existing pipeline YAML
  4. `filtrex` ^3.1.0 is installed, importable from TypeScript with full type declarations, and lint/typecheck pass cleanly
  5. All 1,021 existing tests still pass after the schema and type changes
**Plans:** 1/1 plans complete

Plans:
- [x] 20-01: Schema migration, PipelineNode type extensions, and filtrex installation (2026-03-13)

### Phase 21: Conditional Pipeline Nodes
**Goal**: Pipeline YAML supports if/else branch routing — the executor evaluates conditions at runtime, skips false-branch nodes, surfaces skip status in the API, and treats condition errors as fatal
**Depends on**: Phase 20
**Requirements**: COND-01, COND-02, COND-03, COND-04, COND-05, COND-06, COND-07
**Success Criteria** (what must be TRUE):
  1. A pipeline with a `condition` field on a node executes that node only when the expression evaluates true, and routes to `else_node` when the expression is false
  2. A node configured with `if_failed` or `if_passed` shorthand behaves identically to its equivalent `condition` expression — the shorthand is sugar, not a separate code path
  3. Skipped nodes appear with `"status": "skipped"` in `GET /api/v1/pipeline/:id/status` and in the dashboard, distinct from nodes that were not-yet-run
  4. A malformed or unresolvable condition expression causes the pipeline run to fail immediately with a clear error message — the node is never silently skipped
  5. `forgectl pipeline run --dry-run` prints which nodes would be skipped given the current pipeline node states, without executing any nodes
**Plans:** 2/2 plans complete

Plans:
- [x] 21-01-PLAN.md — Condition evaluator (condition.ts), shorthand expansion, DAG else_node validation
- [x] 21-02-PLAN.md — Executor ready-queue refactor, skip propagation, dry-run condition annotations

### Phase 22: Loop Pipeline Nodes
**Goal**: Pipeline YAML supports loop-until iteration — loops execute up to a hard safety cap, each iteration is checkpointed for crash recovery, and loop progress is visible in the API
**Depends on**: Phase 21
**Requirements**: LOOP-01, LOOP-02, LOOP-03, LOOP-04, LOOP-05
**Success Criteria** (what must be TRUE):
  1. A pipeline with a `loop` node iterates until its `until` expression evaluates true or `max_iterations` is reached — whichever comes first — without requiring any manual intervention
  2. The global `max_iterations` safety cap is enforced in code before evaluating the `until` expression — no YAML value can bypass it
  3. After a daemon crash and restart mid-loop, pipeline execution resumes from the last completed iteration rather than restarting the entire loop from iteration 0
  4. `GET /api/v1/pipeline/:id/status` reports the current iteration count and `loop-iterating` status for any active loop node
  5. When a loop exhausts `max_iterations` without the `until` expression ever becoming true, the run fails with a message that names the loop node and reports the iteration count
**Plans:** 2/2 plans complete

Plans:
- [ ] 22-01-PLAN.md — LoopState types, loop checkpoint functions, comprehensive test scaffolding
- [ ] 22-02-PLAN.md — executeLoopNode() implementation, processNode wiring, dry-run annotation, crash recovery

### Phase 23: Multi-Agent Delegation
**Goal**: A lead agent can decompose a complex issue into subtasks, dispatch child workers concurrently within configured slot budgets, retry failed children with updated context, and synthesize a final summary for write-back
**Depends on**: Phase 20
**Requirements**: DELEG-01, DELEG-02, DELEG-03, DELEG-04, DELEG-05, DELEG-06, DELEG-07, DELEG-08, DELEG-09
**Success Criteria** (what must be TRUE):
  1. A lead agent whose stdout contains a sentinel-delimited delegation manifest (`---DELEGATE--- ... ---END-DELEGATE---`) causes the orchestrator to dispatch child workers concurrently without any manual trigger
  2. Child workers never exceed the `maxChildren` budget from WORKFLOW.md, and child slot consumption never starves top-level work (two-tier slot pool enforced)
  3. Delegation depth is hard-capped at 2 in code — a child worker that outputs a delegation manifest has it ignored, not dispatched
  4. After a daemon restart mid-delegation, parent/child run relationships are recovered from SQLite and in-flight children resume or are re-dispatched correctly
  5. When a child worker fails, the lead agent is re-invoked with instructions that incorporate the child's failure output — and the re-issued child gets the updated task
  6. After all children complete, a single aggregate summary comment is written to the parent issue in the tracker (not one comment per child)
**Plans**: 3 plans

Plans:
- [ ] 23-01-PLAN.md — TwoTierSlotManager, config/schema extensions, manifest parsing, and DelegationManager types
- [ ] 23-02-PLAN.md — DelegationManager core logic, child dispatch, failure retry, and dispatcher/orchestrator wiring
- [ ] 23-03-PLAN.md — Lead synthesis, aggregate write-back, and daemon restart delegation recovery

### Phase 24: Self-Correction Integration
**Goal**: Pipelines can autonomously run tests, detect failures, invoke a fix agent with full iteration history, retest, and exhaust cleanly — proving the loop node + context piping composition works end-to-end
**Depends on**: Phase 22
**Requirements**: CORR-01, CORR-02, CORR-03, CORR-04, CORR-05
**Success Criteria** (what must be TRUE):
  1. A pipeline using the test-fail/fix/retest pattern runs a test node, pipes its failure output as context to a fix node, and retests automatically — all within a single loop node with no manual intervention
  2. The fix agent cannot modify test files — the `exclude` list in WORKFLOW.md is enforced by the executor, and an attempt to write an excluded file causes the step to fail
  3. Each fix iteration's prompt includes the output from all previous fix attempts in that loop, not just the most recent failure
  4. A coverage self-correction pipeline runs until actual coverage meets or exceeds the configured threshold, or exhausts `max_iterations` with a message stating "coverage target not met after N iterations"
  5. When two consecutive loop iterations produce identical test output (no-progress), the loop aborts immediately with a "no progress detected" failure rather than running the remaining iterations
**Plans:** 1/2 plans executed

Plans:
- [ ] 24-01-PLAN.md — ValidationResult.lastOutput, extractCoverage utility, and self-correction test scaffold
- [ ] 24-02-PLAN.md — No-progress detection, exclusion enforcement, and coverage injection in executeLoopNode

## Progress

**Execution Order:** 20 → 21 → 22 → 23 (depends only on 20, can follow 22 or run after 20 once 22 is also done) → 24

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Tracker Adapters | v1.0 | 4/4 | Complete | 2026-03-01 |
| 2. Workspace Management | v1.0 | 2/2 | Complete | 2026-03-02 |
| 3. WORKFLOW.md Contract | v1.0 | 2/2 | Complete | 2026-03-03 |
| 4. Agent Sessions | v1.0 | 3/3 | Complete | 2026-03-04 |
| 5. Orchestration | v1.0 | 4/4 | Complete | 2026-03-05 |
| 6. Observability | v1.0 | 3/3 | Complete | 2026-03-06 |
| 7. E2E Integration | v1.0 | 3/3 | Complete | 2026-03-07 |
| 8. Wire Workflow | v1.0 | 2/2 | Complete | 2026-03-08 |
| 9. GitHub Adapter Fix | v1.0 | 1/1 | Complete | 2026-03-09 |
| 10. Persistent Storage | v2.0 | 2/2 | Complete | 2026-03-09 |
| 11. Flight Recorder | v2.0 | 2/2 | Complete | 2026-03-10 |
| 12. Durable Execution | v2.0 | 3/3 | Complete | 2026-03-10 |
| 13. Governance & Approvals | v2.0 | 2/2 | Complete | 2026-03-10 |
| 14. GitHub App | v2.0 | 5/5 | Complete | 2026-03-10 |
| 15. Browser-Use | v2.0 | 2/2 | Complete | 2026-03-10 |
| 16. Wire Flight Recorder | v2.0 | 1/1 | Complete | 2026-03-11 |
| 17. Wire Governance Gates | v2.0 | 1/1 | Complete | 2026-03-11 |
| 18. Wire GitHub App Utils | v2.0 | 3/3 | Complete | 2026-03-12 |
| 19. Wire Post-Gate Worker | v2.0 | 1/1 | Complete | 2026-03-12 |
| 20. Schema Foundation | v2.1 | Complete    | 2026-03-13 | 2026-03-13 |
| 21. Conditional Pipeline Nodes | 2/2 | Complete    | 2026-03-13 | - |
| 22. Loop Pipeline Nodes | 2/2 | Complete    | 2026-03-13 | - |
| 23. Multi-Agent Delegation | 3/3 | Complete    | 2026-03-13 | - |
| 24. Self-Correction Integration | 1/2 | In Progress|  | - |
