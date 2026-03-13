# Requirements: forgectl

**Defined:** 2026-03-13
**Core Value:** Continuously pull work from issue trackers, dispatch AI agents, validate, report back — zero human intervention.

## v3.0 Requirements

Requirements for v3.0 E2E GitHub Integration milestone. Each maps to roadmap phases.

### Sub-Issue Dependencies

- [ ] **SUBISSUE-01**: Orchestrator fetches sub-issues for each candidate via GitHub REST API and populates `blocked_by` with child issue numbers
- [ ] **SUBISSUE-02**: TrackerIssue stores GitHub internal numeric `id` in metadata (required by sub-issues API)
- [ ] **SUBISSUE-03**: Parent issue dispatches only after all sub-issue children reach terminal state
- [ ] **SUBISSUE-04**: Sub-issue fetch results cached to avoid exceeding GitHub API rate limits (5000/hr)
- [ ] **SUBISSUE-05**: Orchestrator posts progress rollup comment on parent issue summarizing child status
- [ ] **SUBISSUE-06**: Parent issue auto-closed (or labeled done) when all sub-issues complete successfully

### Skill & Config Mounting

- [ ] **SKILL-01**: User can bind-mount skill directories (e.g. ~/.claude/skills/, GSD install) into agent containers as read-only
- [ ] **SKILL-02**: CLAUDE.md files (project + global) mounted into containers via `--add-dir` mechanism
- [ ] **SKILL-03**: WORKFLOW.md supports per-workflow `skill_dirs` config specifying which directories to mount
- [ ] **SKILL-04**: Skill mounting uses allowlist — credentials and sensitive files excluded from mounts
- [ ] **SKILL-05**: WORKFLOW.md supports `agents` config for passing `--agents` flag with agent definitions into containers

### Agent Teams

- [ ] **TEAM-01**: WORKFLOW.md supports `agent_team` config block (enabled, team_size, teammate_model, require_plan_approval)
- [ ] **TEAM-02**: Container env includes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` when team mode enabled
- [ ] **TEAM-03**: Container memory/CPU scaled by team-size multiplier when team mode enabled (prevent OOM)
- [ ] **TEAM-04**: Agent prompt includes team instructions (spawn teammates, assign roles) when team mode enabled
- [ ] **TEAM-05**: Budget enforcement applies team-size multiplier to per-run cost limits
- [ ] **TEAM-06**: Timeout scaled by team-size multiplier for team-mode runs
- [ ] **TEAM-07**: Checkpoint/resume explicitly disabled for team-mode runs (incompatible with agent teams)

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Sub-Issue Dependencies

- **SUBISSUE-F01**: GraphQL batch query for sub-issues across all candidates in one call (reduce API pressure)
- **SUBISSUE-F02**: GitHub blocked-by/blocking relationship parsing (separate from sub-issue hierarchy)
- **SUBISSUE-F03**: Sub-issue webhook events for real-time dependency updates (vs polling)

### Skill & Config Mounting

- **SKILL-F01**: Skill marketplace — discover and install community skills into containers
- **SKILL-F02**: Per-teammate skill overrides (different skills for different team roles)

### Agent Teams

- **TEAM-F01**: Agent team metrics — per-teammate token usage breakdown in flight recorder
- **TEAM-F02**: Governance approval gate per team spawn (supervised mode requires approval before creating team)
- **TEAM-F03**: Team result synthesis — structured merge of teammate outputs before write-back

## Out of Scope

| Feature | Reason |
|---------|--------|
| GraphQL client dependency | REST API sufficient for sub-issues; GraphQL adds complexity for marginal gain |
| Mounting full ~/.claude/ directory | Security risk — exposes OAuth tokens and credentials |
| Nested agent teams (teams within teams) | Claude Code limitation — no nested teams supported |
| Session resumption for team runs | Claude Code limitation — agent teams incompatible with /resume |
| Distributed multi-worker for teams | Single-machine model; each container runs its own team |
| Custom team communication protocols | Claude Code handles internal team coordination; forgectl stays out |
| Notion sub-task hierarchy | GitHub-first; Notion adapter can follow later |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SUBISSUE-01 | — | Pending |
| SUBISSUE-02 | — | Pending |
| SUBISSUE-03 | — | Pending |
| SUBISSUE-04 | — | Pending |
| SUBISSUE-05 | — | Pending |
| SUBISSUE-06 | — | Pending |
| SKILL-01 | — | Pending |
| SKILL-02 | — | Pending |
| SKILL-03 | — | Pending |
| SKILL-04 | — | Pending |
| SKILL-05 | — | Pending |
| TEAM-01 | — | Pending |
| TEAM-02 | — | Pending |
| TEAM-03 | — | Pending |
| TEAM-04 | — | Pending |
| TEAM-05 | — | Pending |
| TEAM-06 | — | Pending |
| TEAM-07 | — | Pending |

**Coverage:**
- v3.0 requirements: 18 total
- Mapped to phases: 0
- Unmapped: 18 ⚠️

---
*Requirements defined: 2026-03-13*
*Last updated: 2026-03-13 after initial definition*
