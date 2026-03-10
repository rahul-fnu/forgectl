# Requirements: forgectl v2.0 Durable Runtime

**Defined:** 2026-03-09
**Core Value:** Continuously pull work from issue trackers, dispatch AI agents, validate, report back -- zero human intervention, now with durable execution, governance, and GitHub App interaction.

## v2.0 Requirements

Requirements for v2.0 release. Each maps to roadmap phases.

### Storage

- [x] **STOR-01**: Daemon uses SQLite database with Drizzle ORM for persistent state
- [x] **STOR-02**: Database schema auto-migrates on daemon startup
- [x] **STOR-03**: All database access uses typed repository pattern (query/mutation functions per entity)

### Audit

- [x] **AUDT-01**: Append-only event log records all run actions (prompts, tool calls, validation, retries, costs)
- [x] **AUDT-02**: Rich write-back: structured GitHub comments with changes, validation results, cost breakdown
- [x] **AUDT-03**: CLI: `forgectl run inspect <id>` shows full audit trail
- [x] **AUDT-04**: State snapshots captured at each step boundary

### Durability

- [x] **DURA-01**: Interrupted runs resume or fail cleanly on daemon restart
- [x] **DURA-02**: Checkpoint/resume at step boundaries with idempotent replay
- [x] **DURA-03**: Agent can pause into `waiting_for_input` state, persist context, resume on human reply
- [x] **DURA-04**: Atomic execution locks per issue/workspace via SQLite transactions

### Governance

- [x] **GOVN-01**: Configurable autonomy levels per workflow (full/semi/interactive/supervised) in WORKFLOW.md
- [x] **GOVN-02**: Approval state machine (pending -> approved/rejected/revision_requested)
- [x] **GOVN-03**: Auto-approve rules (cost < $X, files < N, specific label, workflow pattern)

### GitHub App

- [x] **GHAP-01**: GitHub App with webhook receiver, HMAC-SHA256 verification, bot identity
- [ ] **GHAP-02**: Label-based and event-based triggers for dispatching runs
- [ ] **GHAP-03**: Structured bot comments on issues/PRs with run status, results, cost summary
- [ ] **GHAP-04**: Slash commands: /forgectl run, rerun, stop, status, approve, reject, help
- [ ] **GHAP-05**: Permission checks: only repo collaborators can issue commands
- [ ] **GHAP-06**: Conversational clarification: agent asks question mid-run, pauses, resumes on reply
- [ ] **GHAP-07**: Reactions as approvals (thumbs-up=approve, thumbs-down=reject, rocket=trigger, arrows=rerun)
- [ ] **GHAP-08**: Check runs on PRs (pending -> in_progress -> success/failure)
- [ ] **GHAP-09**: Auto-generated PR descriptions with changes, validation, cost, linked issue

### Browser-Use

- [ ] **BROW-01**: Browser-use agent adapter implementing AgentSession interface
- [ ] **BROW-02**: Self-hosted Python sidecar in Docker container with HTTP bridge
- [ ] **BROW-03**: Research/web workflow template for competitive analysis, data gathering

## v2.1 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Notion App

- **NOTN-01**: Notion integration with database trigger polling
- **NOTN-02**: Rich content write-back to Notion pages (headings, bullets, tables)
- **NOTN-03**: Linked Runs database with cost/status per attempt
- **NOTN-04**: Property-based and comment-based commands

### Task Model

- **TASK-01**: Unified internal task model mirrored from GitHub/Notion
- **TASK-02**: Parent/child task hierarchy for decomposition
- **TASK-03**: Cross-tracker linking (metadata only)

### Multi-Agent Delegation

- **DELG-01**: Manager agents create sub-tasks and assign to reports
- **DELG-02**: Org chart hierarchy with reportsTo driving work assignment
- **DELG-03**: Bounded delegation rules (max depth, max fan-out)

### Dashboard v2

- **DASH-01**: Run explorer with audit trail viewer
- **DASH-02**: Cost dashboard with per-agent breakdown
- **DASH-03**: Approval queue and active session monitor

### Budget Enforcement

- **BUDG-01**: Pre-flight cost estimation before run start
- **BUDG-02**: Auto-pause on budget exhaustion
- **BUDG-03**: Budget periods with auto-reset (monthly, weekly)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Distributed multi-worker execution | Single machine first |
| Full CQRS / event replay for state | Events are audit trail, not source of truth |
| PostgreSQL support | SQLite sufficient for single-machine v2.0 |
| RBAC / multi-approver workflows | Single-user for now, collaborator checks only |
| Per-tool budget granularity | Budget per run and per agent/period is enough |
| Slack/Discord bot | Get GitHub App right first, same architecture extends later |
| Your own mobile app | GitHub and Notion apps are the UI |
| Temporal/BullMQ external dependencies | App-level checkpointing on SQLite, no external servers |
| Large WORKFLOW.md DSL | Keep it small: autonomy + triggers + validation + budget_cap |
| Probot framework | Conflicts with Fastify; use @octokit/app directly |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STOR-01 | Phase 10 | Complete |
| STOR-02 | Phase 10 | Complete |
| STOR-03 | Phase 10 | Complete |
| AUDT-01 | Phase 11 | Complete |
| AUDT-02 | Phase 11 | Complete |
| AUDT-03 | Phase 11 | Complete |
| AUDT-04 | Phase 11 | Complete |
| DURA-01 | Phase 12 | Complete |
| DURA-02 | Phase 12 | Complete |
| DURA-03 | Phase 12 | Complete |
| DURA-04 | Phase 12 | Complete |
| GOVN-01 | Phase 13 | Complete |
| GOVN-02 | Phase 13 | Complete |
| GOVN-03 | Phase 13 | Complete |
| GHAP-01 | Phase 14 | Complete |
| GHAP-02 | Phase 14 | Pending |
| GHAP-03 | Phase 14 | Pending |
| GHAP-04 | Phase 14 | Pending |
| GHAP-05 | Phase 14 | Pending |
| GHAP-06 | Phase 14 | Pending |
| GHAP-07 | Phase 14 | Pending |
| GHAP-08 | Phase 14 | Pending |
| GHAP-09 | Phase 14 | Pending |
| BROW-01 | Phase 15 | Pending |
| BROW-02 | Phase 15 | Pending |
| BROW-03 | Phase 15 | Pending |

**Coverage:**
- v2.0 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after roadmap creation*
