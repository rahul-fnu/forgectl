---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: E2E GitHub Integration
status: planning
stopped_at: Phase 27 context gathered
last_updated: "2026-03-13T08:15:37.549Z"
last_activity: 2026-03-13 -- v3.0 roadmap created, 4 phases (25-28), 16 requirements mapped
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 4
  completed_plans: 4
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-12)

**Core value:** Continuously pull work from issue trackers, dispatch AI agents, validate, report back -- zero human intervention.
**Current focus:** Phase 25 -- Sub-Issue DAG Dependencies

## Current Position

Phase: 25 of 28 (Sub-Issue DAG Dependencies)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-03-13 -- v3.0 roadmap created, 4 phases (25-28), 16 requirements mapped

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0 (v3.0)
- Average duration: unknown
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 25. Sub-Issue DAG | TBD | - | - |
| 26. Skill Mounting | TBD | - | - |
| 27. Agent Teams | TBD | - | - |
| 28. Sub-Issue Advanced | TBD | - | - |

*Updated after each plan completion*
| Phase 25-sub-issue-dag-dependencies P01 | 3 | 2 tasks | 4 files |
| Phase 25-sub-issue-dag-dependencies P02 | 100 | 2 tasks | 5 files |
| Phase 26-skill-config-bind-mounting P01 | 234 | 2 tasks | 15 files |
| Phase 26-skill-config-bind-mounting P02 | 480 | 2 tasks | 5 files |

## Accumulated Context

### Decisions

- [v3.0 planning]: Zero new npm dependencies -- all three features use existing Octokit, Dockerode, Zod
- [v3.0 planning]: Build order -- Sub-issues first (data-only, highest standalone value), Skills second (prerequisite for Teams), Teams last (highest risk, experimental)
- [v3.0 planning]: Agent teams are prompt+env concern, not architectural -- Claude Code handles coordination internally
- [v3.0 planning]: Phase 28 depends on Phase 25 only (not 26 or 27) -- it is additive polish on sub-issue DAG
- [Phase 25-01]: Standalone DFS cycle detector instead of reusing validateDAG() -- pipeline validator errors on unknown refs which are valid in issue graphs
- [Phase 25-01]: Lazy TTL expiry on cache read and getAllEntries() -- no background timer needed
- [Phase 25-02]: Optional injection for subIssueCache in TickDeps and WebhookDeps -- backward compat preserved, Notion adapter users unaffected
- [Phase 25-02]: Webhook invalidation on issues.edited is best-effort -- TTL is the reliable fallback
- [Phase 25-02]: Test isolation: use mockRejectedValueOnce not mockRejectedValue to avoid contaminating subsequent tests
- [Phase 26-01]: WorkflowFrontMatterSchema uses .optional() not .default([]) for skills -- absent means not specified (override semantics)
- [Phase 26-01]: CREDENTIAL_DENY_LIST uses basename matching after split('/') for recursive readdirSync path compatibility
- [Phase 26-01]: No project logger in mount.ts -- avoids heavy dependency chain in utility module
- [Phase Phase 26-02]: Commander --no-skills sets opts.skills=false; CLIOptions uses skills?: boolean; resolver maps skills===false to noSkills:true in RunPlan
- [Phase Phase 26-02]: skillAddDirFlags captured as local variable before agentOptions, then spread into flags array -- avoids mutating plan.agent.flags

### Pending Todos

None.

### Blockers/Concerns

- [Phase 27]: Agent teams is experimental Claude Code API -- feature could change. Validate in-process teammate mode works inside Docker containers during planning.
- [Phase 25]: Verify sub-issue pagination behavior with >20 children during planning. Confirm ETag cache invalidation strategy.

## Session Continuity

Last session: 2026-03-13T08:15:37.544Z
Stopped at: Phase 27 context gathered
Resume file: .planning/phases/27-agent-teams/27-CONTEXT.md
