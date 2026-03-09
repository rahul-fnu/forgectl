# Roadmap: forgectl

## Milestones

- [x] **v1.0 Core Orchestrator** - Phases 1-9 (shipped 2026-03-09)
- [ ] **v2.0 Durable Runtime** - Phases 10-15 (in progress)

## Phases

<details>
<summary>v1.0 Core Orchestrator (Phases 1-9) - SHIPPED 2026-03-09</summary>

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

### v2.0 Durable Runtime

**Milestone Goal:** Evolve forgectl from a task orchestrator into a trusted, durable runtime for coding agents -- controllable from your phone through a GitHub App with slash commands, reactions, and conversational clarification.

**Phase Numbering:**
- Integer phases (10, 11, 12...): Planned milestone work
- Decimal phases (10.1, 10.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 10: Persistent Storage Layer** - SQLite database with Drizzle ORM, migrations, and repository pattern (completed 2026-03-09)
- [ ] **Phase 11: Flight Recorder** - Append-only event log with audit trail, state snapshots, and rich write-back
- [ ] **Phase 12: Durable Execution** - Crash recovery, checkpoint/resume, pause for human input, execution locks
- [ ] **Phase 13: Governance & Approvals** - Configurable autonomy levels, approval gates, and budget enforcement
- [ ] **Phase 14: GitHub App** - Webhook receiver, slash commands, reactions, conversations, check runs
- [ ] **Phase 15: Browser-Use Integration** - Browser-use agent adapter with Python sidecar and research workflow

## Phase Details

### Phase 10: Persistent Storage Layer
**Goal**: All daemon state persists in SQLite so that restarts, crashes, and inspections work against durable data instead of ephemeral in-memory state
**Depends on**: Nothing (foundation for v2.0)
**Requirements**: STOR-01, STOR-02, STOR-03
**Success Criteria** (what must be TRUE):
  1. Daemon starts with a SQLite database file created at a configurable path
  2. Schema migrations run automatically on daemon startup without manual intervention
  3. All database reads and writes go through typed repository functions (no raw SQL in business logic)
  4. Existing `forgectl run` and `forgectl pipeline` commands still work after storage migration
**Plans**: 2 plans

Plans:
- [x] 10-01-PLAN.md — Database foundation: install deps, schema, database singleton, migrator, config
- [ ] 10-02-PLAN.md — Typed repositories, RunQueue/PipelineRunService integration, daemon wiring

### Phase 11: Flight Recorder
**Goal**: Every run produces a complete, immutable audit trail that can be inspected after the fact and formatted into rich write-back comments
**Depends on**: Phase 10
**Requirements**: AUDT-01, AUDT-02, AUDT-03, AUDT-04
**Success Criteria** (what must be TRUE):
  1. Every run action (prompt, tool call, validation, retry, cost) is recorded as an append-only event in the database
  2. `forgectl run inspect <id>` displays the full chronological audit trail for a run
  3. GitHub issue comments include structured summaries with changes, validation results, and cost breakdown
  4. State snapshots are captured at each step boundary and can be queried for a given run
**Plans**: TBD

Plans:
- [ ] 11-01: TBD
- [ ] 11-02: TBD

### Phase 12: Durable Execution
**Goal**: Runs survive daemon crashes, can be paused for human input, and resume exactly where they left off
**Depends on**: Phase 10, Phase 11
**Requirements**: DURA-01, DURA-02, DURA-03, DURA-04
**Success Criteria** (what must be TRUE):
  1. If the daemon crashes mid-run, restarting the daemon resumes interrupted runs or marks them as failed with explanation
  2. Runs checkpoint at step boundaries and replay idempotently from the last checkpoint on resume
  3. An agent can pause into a `waiting_for_input` state, persist its context, and resume when a human replies
  4. Two runs targeting the same issue/workspace cannot execute simultaneously (atomic locks via SQLite)
**Plans**: TBD

Plans:
- [ ] 12-01: TBD
- [ ] 12-02: TBD
- [ ] 12-03: TBD

### Phase 13: Governance & Approvals
**Goal**: Each workflow has a configurable autonomy level that determines whether runs need human approval, and budgets are enforced before execution begins
**Depends on**: Phase 11
**Requirements**: GOVN-01, GOVN-02, GOVN-03
**Success Criteria** (what must be TRUE):
  1. WORKFLOW.md supports an `autonomy` field with levels (full/semi/interactive/supervised) that controls whether runs auto-execute or wait for approval
  2. Runs requiring approval enter a pending state and transition to approved/rejected/revision_requested based on human action
  3. Auto-approve rules (cost threshold, file count, label match, workflow pattern) bypass the approval gate when conditions are met
**Plans**: TBD

Plans:
- [ ] 13-01: TBD
- [ ] 13-02: TBD

### Phase 14: GitHub App
**Goal**: Users interact with forgectl entirely through GitHub -- triggering runs, approving work, asking questions, and reviewing results without leaving their browser or phone
**Depends on**: Phase 12, Phase 13
**Requirements**: GHAP-01, GHAP-02, GHAP-03, GHAP-04, GHAP-05, GHAP-06, GHAP-07, GHAP-08, GHAP-09
**Success Criteria** (what must be TRUE):
  1. A GitHub App receives webhooks with HMAC-SHA256 verification and dispatches runs based on labels or issue events
  2. Users can issue slash commands (/forgectl run, rerun, stop, status, approve, reject, help) in issue or PR comments
  3. Only repository collaborators can issue commands (permission checks on every interaction)
  4. An agent mid-run can post a clarification question on the issue, pause, and resume when the user replies
  5. PRs created by forgectl include check runs (pending/in_progress/success/failure) and auto-generated descriptions with changes, validation, cost, and linked issue
**Plans**: TBD

Plans:
- [ ] 14-01: TBD
- [ ] 14-02: TBD
- [ ] 14-03: TBD
- [ ] 14-04: TBD
- [ ] 14-05: TBD

### Phase 15: Browser-Use Integration
**Goal**: forgectl can dispatch browser-based agents for research and web tasks using the same workflow system as code agents
**Depends on**: Phase 10
**Requirements**: BROW-01, BROW-02, BROW-03
**Success Criteria** (what must be TRUE):
  1. A BrowserUseSession adapter implements the AgentSession interface and can be selected via workflow config
  2. A self-hosted Python sidecar runs inside a Docker container with an HTTP bridge that the TypeScript adapter calls
  3. A `research` workflow template exists that configures browser-use for competitive analysis and data gathering tasks
**Plans**: TBD

Plans:
- [ ] 15-01: TBD
- [ ] 15-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 10 -> 11 -> 12 -> 13 -> 14 -> 15
(Decimal phases, if inserted, execute between their surrounding integers)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 10. Persistent Storage Layer | 2/2 | Complete    | 2026-03-09 |
| 11. Flight Recorder | 0/2 | Not started | - |
| 12. Durable Execution | 0/3 | Not started | - |
| 13. Governance & Approvals | 0/2 | Not started | - |
| 14. GitHub App | 0/5 | Not started | - |
| 15. Browser-Use Integration | 0/2 | Not started | - |
