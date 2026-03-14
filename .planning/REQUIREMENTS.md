# Requirements: forgectl v3.0 — E2E GitHub Integration

**Milestone:** v3.0 E2E GitHub Integration
**Status:** Active
**Created:** 2026-03-13

## Overview

v3.0 adds three capabilities to the existing orchestrator: GitHub sub-issue DAG dependencies for automatic work ordering, skill/config bind-mounting for customizable agent behavior inside containers, and Claude Code agent teams for intra-task parallelism.

Zero new npm dependencies. All features build on existing libraries (Octokit, Dockerode, Zod) and existing architectural patterns.

---

## v1 Requirements

### Sub-Issue DAG Dependencies (SUBISSUE)

| ID | Requirement | Priority |
|----|-------------|----------|
| SUBISSUE-01 | Fetch GitHub sub-issues via REST API and populate `blocked_by` field on TrackerIssue | Must |
| SUBISSUE-02 | Store GitHub internal resource ID (`id`) in TrackerIssue metadata for write operations | Must |
| SUBISSUE-03 | Populate `terminalIssueIds` in scheduler from live sub-issue fetch with TTL cache | Must |
| SUBISSUE-04 | Detect and report DAG cycles created by merging sub-issue hierarchy with manual overrides | Must |
| SUBISSUE-05 | Post progress rollup comments on parent issues as sub-issues complete | Should |
| SUBISSUE-06 | Auto-close parent issue when all sub-issues reach terminal state | Should |

### Skill / Config Bind-Mounting (SKILL)

| ID | Requirement | Priority |
|----|-------------|----------|
| SKILL-01 | Mount CLAUDE.md, skills/, and agents/ directories into containers with read-only bind mounts | Must |
| SKILL-02 | Exclude credential files (`.credentials.json`, token files, `statsig/`) from all mounts | Must |
| SKILL-03 | Pass `--add-dir` flag to Claude Code so agents discover mounted skill directories | Must |
| SKILL-04 | Support workflow-specific skill selection via `skills:` section in WORKFLOW.md | Should |
| SKILL-05 | Extend config schema (Zod) with `skills` section for per-workflow skill configuration | Must |

### Agent Teams (TEAM)

| ID | Requirement | Priority |
|----|-------------|----------|
| TEAM-01 | Enable Claude Code agent teams via env vars and prompt wrapping inside containers | Must |
| TEAM-02 | Auto-scale container memory by team size (base + 1GB per teammate) | Must |
| TEAM-03 | Update slot manager to weight concurrent slots by team size, not run count | Must |
| TEAM-04 | Disable checkpoint/resume for team runs (incompatible with team internal state) | Must |
| TEAM-05 | Support `team:` section in WORKFLOW.md for team size, roles, and coordination mode | Should |

---

## Out of Scope (v3.0)

- Cross-issue blocking/blocked-by API (poorly documented, defer to v3.1)
- Sub-issue creation from pipeline definitions (complex two-way sync)
- Dynamic skill generation from issue context
- Persistent agent team sessions across crashes (experimental feature limitation)
- Skill marketplace / package manager
- GitHub dependency API programmatic access

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SUBISSUE-01 | Phase 25 | Complete |
| SUBISSUE-02 | Phase 25 | Complete |
| SUBISSUE-03 | Phase 29 | Pending |
| SUBISSUE-04 | Phase 29 | Pending |
| SUBISSUE-05 | Phase 29 | Pending |
| SUBISSUE-06 | Phase 29 | Pending |
| SKILL-01 | Phase 26 | Complete |
| SKILL-02 | Phase 26 | Complete |
| SKILL-03 | Phase 26 | Complete |
| SKILL-04 | Phase 26 | Complete |
| SKILL-05 | Phase 26 | Complete |
| TEAM-01 | Phase 27 | Complete |
| TEAM-02 | Phase 27 | Complete |
| TEAM-03 | Phase 27 | Complete |
| TEAM-04 | Phase 27 | Complete |
| TEAM-05 | Phase 27 | Complete |
