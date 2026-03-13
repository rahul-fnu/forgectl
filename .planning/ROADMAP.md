# Roadmap: forgectl

## Milestones

- ✅ **v1.0 Core Orchestrator** — Phases 1-9 (shipped 2026-03-09)
- ✅ **v2.0 Durable Runtime** — Phases 10-19 (shipped 2026-03-12)
- 📋 **v3.0 E2E GitHub Integration** — Phases 25-28 (planned)

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

### v3.0 E2E GitHub Integration (Planned)

**Milestone Goal:** Add GitHub sub-issue DAG ordering, skill/config bind-mounting, and Claude Code agent teams to the existing orchestrator — extending existing patterns with zero new npm dependencies.

- [ ] **Phase 25: Sub-Issue DAG Dependencies** - Fetch GitHub sub-issues, populate blocked_by, enable dependency-aware dispatch
- [ ] **Phase 26: Skill / Config Bind-Mounting** - Mount CLAUDE.md, skills, agents directories into containers safely
- [ ] **Phase 27: Agent Teams** - Enable Claude Code multi-agent teams with resource scaling and checkpoint exclusion
- [ ] **Phase 28: Sub-Issue Advanced Features** - Progress rollup on parent issues, auto-close parent on completion

## Phase Details

### Phase 25: Sub-Issue DAG Dependencies
**Goal**: The orchestrator reads GitHub sub-issue hierarchy and dispatches work in dependency order automatically
**Depends on**: Phase 19 (v2.0 complete)
**Requirements**: SUBISSUE-01, SUBISSUE-02, SUBISSUE-03, SUBISSUE-04
**Success Criteria** (what must be TRUE):
  1. When a GitHub issue has sub-issues, the orchestrator does not dispatch the parent until all sub-issues reach a terminal state
  2. Sub-issue relationships appear in TrackerIssue as populated `blocked_by` entries, not an empty set
  3. If a sub-issue DAG contains a cycle (from manual overrides), the orchestrator posts a GitHub comment identifying the cycle and skips dispatch rather than hanging
  4. The GitHub internal resource ID for each issue is stored in metadata and survives across polling cycles
**Plans:** 1/2 plans executed
Plans:
- [ ] 25-01-PLAN.md — SubIssueCache and cycle detection modules (new standalone files + tests)
- [ ] 25-02-PLAN.md — Wire into GitHub adapter, scheduler, and webhooks

### Phase 26: Skill / Config Bind-Mounting
**Goal**: Agents inside containers can discover and use personal skills, project skills, and CLAUDE.md files without credential exposure
**Depends on**: Phase 25
**Requirements**: SKILL-01, SKILL-02, SKILL-03, SKILL-04, SKILL-05
**Success Criteria** (what must be TRUE):
  1. A container run can read files from `~/.claude/skills/` and `~/.claude/agents/` via read-only bind mounts
  2. Running `forgectl run` with a workflow that has a `skills:` section mounts only the listed skill directories, not the entire `~/.claude/` tree
  3. Credential files (`.credentials.json`, token files) are never present inside the container filesystem
  4. Claude Code inside the container discovers mounted skills via `--add-dir` flag and can invoke them
**Plans**: TBD

### Phase 27: Agent Teams
**Goal**: Claude Code agent teams run inside containers on complex tasks, with container resources and slot weights automatically scaled to team size
**Depends on**: Phase 26
**Requirements**: TEAM-01, TEAM-02, TEAM-03, TEAM-04, TEAM-05
**Success Criteria** (what must be TRUE):
  1. A workflow with `team: { size: 3 }` launches a Claude Code session that spawns two teammates inside the container, producing coordinated output
  2. Container memory limit increases by 1GB per teammate beyond the lead agent (e.g., a 3-person team gets base + 2GB)
  3. The slot manager counts a 3-person team run as occupying 3 slots, not 1, preventing OOM from concurrent team runs
  4. Team runs have checkpoint/resume disabled; on failure, the run restarts from scratch rather than resuming mid-team
**Plans**: TBD

### Phase 28: Sub-Issue Advanced Features
**Goal**: Parent issues receive live progress updates as their sub-issues complete, and close automatically when all children finish
**Depends on**: Phase 25
**Requirements**: SUBISSUE-05, SUBISSUE-06
**Success Criteria** (what must be TRUE):
  1. When a sub-issue completes, the parent issue receives a GitHub comment listing completed vs. remaining sub-issues
  2. When the last sub-issue reaches a terminal state, the parent issue is automatically closed with a summary comment
  3. Progress comments are updated in-place (edited, not appended) to avoid comment spam on parent issues
**Plans**: TBD

## Progress

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
| 25. Sub-Issue DAG | 1/2 | In Progress|  | - |
| 26. Skill Mounting | v3.0 | 0/TBD | Not started | - |
| 27. Agent Teams | v3.0 | 0/TBD | Not started | - |
| 28. Sub-Issue Advanced | v3.0 | 0/TBD | Not started | - |
