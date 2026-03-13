---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: E2E GitHub Integration
status: planning
stopped_at: Completed 28-01-PLAN.md
last_updated: "2026-03-13T23:31:53.684Z"
last_activity: 2026-03-13 -- v3.0 roadmap created, 4 phases (25-28), 16 requirements mapped
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 8
  completed_plans: 7
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
| Phase 27-agent-teams P01 | 184 | 2 tasks | 8 files |
| Phase 27-agent-teams P02 | 390 | 2 tasks | 6 files |
| Phase 28-sub-issue-advanced-features P01 | 2 | 1 tasks | 2 files |

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
- [Phase 27-01]: team sub-object in WorkflowFrontMatterSchema is NOT .strict() — only top-level schema uses .strict(), matching existing tracker/workspace pattern
- [Phase 27-01]: noTeam/skipCheckpoints use || undefined pattern (same as noSkills) so absent fields are omitted from RunPlan rather than set to false
- [Phase 27-01]: slotWeight equals teamSize initially — Plan 02 may override with config-driven values
- [Phase 27-02]: SlotManager sums slotWeight values instead of counting workers — enables proportional slot consumption
- [Phase 27-02]: slotWeight defaults to 1 in dispatcher (config.team?.size ?? 1) — backward compatible with all existing solo runs
- [Phase 27-02]: All 4 saveCheckpoint calls gated by !plan.skipCheckpoints — checkpoint bypass works for team runs with skipCheckpoints=true
- [Phase 28-01]: RollupOctokitLike adds listComments with per_page/page params to OctokitLike pattern from comments.ts
- [Phase 28-01]: allChildrenTerminal returns false for empty Map -- no children means nothing is done yet
- [Phase 28-01]: Marker-based comment upsert: search by hidden HTML comment per update, no DB storage of comment IDs

### Pending Todos

None.

### Blockers/Concerns

- [Phase 27]: Agent teams is experimental Claude Code API -- feature could change. Validate in-process teammate mode works inside Docker containers during planning.
- [Phase 25]: Verify sub-issue pagination behavior with >20 children during planning. Confirm ETag cache invalidation strategy.

## Session Continuity

Last session: 2026-03-13T23:31:53.676Z
Stopped at: Completed 28-01-PLAN.md
Resume file: None
