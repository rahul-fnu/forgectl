# Project Research Summary

**Project:** forgectl v2.1 -- Sub-issue DAGs, Skill Mounting, Agent Teams
**Domain:** AI agent orchestrator enhancement (Docker-based, GitHub-integrated)
**Researched:** 2026-03-13
**Confidence:** HIGH (stack, features, architecture) / MEDIUM (agent teams -- experimental)

## Executive Summary

forgectl v2.1 adds three capabilities to the existing orchestrator: GitHub sub-issue DAG dependencies for automatic work ordering, skill/config bind-mounting for customizable agent behavior inside containers, and Claude Code agent teams for intra-task parallelism. The critical finding across all research is that **zero new NPM dependencies are needed** -- all three features build on existing libraries (Octokit, Dockerode, Zod) and existing architectural patterns (TrackerIssue enrichment, ContainerMounts, prompt-level orchestration). This is integration work, not library adoption.

The recommended approach is a three-phase build following dependency order: sub-issues first (populates the already-existing but empty `blocked_by` field), skill mounting second (independent but prerequisite for teams), and agent teams third (depends on skills, highest risk). The architecture principle is **extend, don't restructure** -- each feature plugs into well-defined seams in the existing tracker/dispatcher/worker pipeline. Sub-issues enrich data at fetch time; the dispatcher's existing `filterCandidates()` logic handles the rest. Skills use the established `ContainerMounts` pattern. Teams are a prompt-level and env-level concern, not an architectural change.

The top risks are: GitHub's sub-issue API uses internal resource IDs (not issue numbers), which will cause silent 404s if not handled; mounting `~/.claude/` for skills can expose OAuth tokens to container code; and agent teams spawn N+1 processes that will OOM the container without resource scaling. All three are well-understood with clear prevention strategies documented in PITFALLS.md. The agent teams feature carries additional risk as an experimental Claude Code capability -- session resumption is not supported, and the feature could change or be removed.

## Key Findings

### Recommended Stack

No new dependencies. All three features build on the existing stack: `@octokit/rest` for sub-issue REST API calls via the existing `githubFetch()`, `dockerode` for additional bind mounts and env vars, and `zod` for new config schema sections. The existing `src/pipeline/dag.ts` provides DAG validation, cycle detection, and topological sort -- no graph library needed.

**Core technologies (all existing):**
- `@octokit/rest` ^22.0.1: Sub-issue REST API calls -- GA endpoints, no special headers needed (unlike GraphQL)
- `dockerode` ^4.0.2: Bind mounts for skills, env vars for teams, resource scaling
- `zod`: New `skills`, `team`, and `subIssues` config schema sections

**What NOT to add:** `@octokit/graphql` (REST is simpler), `graphlib`/`dagre` (existing DAG code suffices), tmux in containers (in-process mode works), any Claude Code SDK (does not exist).

### Expected Features

**Must have (table stakes):**
- GitHub sub-issue fetching and `blocked_by` population -- orchestrator currently ignores sub-issue hierarchy
- CLAUDE.md / skills / agents directory mounting into containers -- agents cannot access project or personal skills today
- Agent config passthrough (`--agents`, `--agent`, `--add-dir` flags) -- necessary for skill and subagent discovery
- Store GitHub internal `id` in TrackerIssue metadata -- required for any sub-issue write operations

**Should have (differentiators):**
- Automatic sub-issue DAG with progress rollup comments on parent issues
- Claude Code agent teams inside containers (experimental but high-value for complex tasks)
- Workflow-specific skill bundles and agent definitions per WORKFLOW.md
- Auto-close parent issues when all sub-issues complete

**Defer:**
- Cross-issue dependency resolution (blocking/blocked-by API poorly documented for programmatic access)
- Sub-issue creation from pipeline definitions (complex two-way sync)
- Dynamic skill generation from issue context (optimization, not needed for initial value)
- Persistent agent team sessions across crashes (experimental feature limitation)
- Skill marketplace / package manager (over-engineering for v2.1)

### Architecture Approach

Three features integrate at well-defined seams in the existing pipeline. Sub-issues enrich `TrackerIssue` at fetch time and populate `terminalIssueIds` at tick time -- the dispatcher's existing `filterCandidates()` handles filtering unchanged. Skills use a new `prepareSkillMounts()` function following the established `ContainerMounts` pattern from `auth/mount.ts`. Agent teams are purely prompt-level and env-level: set the feature flag, scale resources, wrap the prompt with team instructions, and let Claude Code handle all coordination internally.

**Major components:**
1. `src/tracker/sub-issues.ts` (NEW) -- REST API client for sub-issue fetching, enriches TrackerIssue with `parent_id`, `sub_issue_ids`, populated `blocked_by`
2. `src/container/skills.ts` (NEW) -- Resolves skill directories, prepares read-only bind mounts, sets `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
3. `src/agent/teams.ts` (NEW) -- Team env builder, prompt prefix builder, container resource scaler
4. `src/orchestrator/scheduler.ts` (MODIFY) -- Populate `terminalIssueIds` from cached terminal issue fetch (currently always empty Set)
5. `src/config/schema.ts` (MODIFY) -- New `skills`, `team`, `subIssues` Zod schema sections

### Critical Pitfalls

1. **GitHub sub-issue API uses internal `id`, not issue number** -- The `sub_issue_id` parameter needs the 10+ digit internal resource ID, not the human-visible `#42`. Store `ghIssue.id` in `TrackerIssue.metadata.github_internal_id`. Write integration tests against real GitHub.

2. **Mounting `~/.claude/` exposes OAuth tokens** -- Never mount `~/.claude/` wholesale. Use an explicit allowlist: copy only CLAUDE.md, skills/, agents/ directories. Exclude `.credentials.json`, `statsig/`, token files. Keep auth credentials on the existing `/run/secrets/` path.

3. **Agent teams OOM containers** -- Each teammate is a full Claude Code process (~500MB-1GB). Scale memory by team size (base + 1GB per teammate). Update slot manager to weight by team size, not just run count. Add OOM detection via `container.inspect()`.

4. **Agent teams incompatible with checkpoint/resume** -- Team state (`~/.claude/teams/`, `~/.claude/tasks/`) is internal to Claude Code with no serialize/restore API. Disable checkpointing for team runs; use restart-from-scratch on failure.

5. **Sub-issue DAG cycles from merged dependency sources** -- GitHub sub-issues are tree-structured (no cycles), but merging with manual `blocked_by` overrides can create cycles. Implement cycle detection (Kahn's algorithm); report cycles via GitHub comment.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Sub-Issues DAG Dependencies
**Rationale:** Highest standalone value. Unblocks dependency-aware orchestration immediately. The existing `blocked_by` + `filterCandidates` infrastructure just needs real data -- no architectural changes. Independent of other features.
**Delivers:** Automatic work ordering based on GitHub sub-issue hierarchy. Parent issues wait for children to complete before dispatch.
**Addresses:** Sub-issue fetching (table stakes #1), `blocked_by` population, topological dispatch ordering, GitHub internal ID storage
**Avoids:** Pitfalls #1 (ID confusion), #2 (GraphQL feature header -- use REST instead), #6 (DAG cycles), #7 (pagination), #11 (ETag cache invalidation), #12 (feature not enabled on repo)
**Key work:** Extend TrackerIssue type, build `sub-issues.ts` REST client, populate `terminalIssueIds` in scheduler with caching, cycle detection

### Phase 2: Skill/Config Bind-Mounting
**Rationale:** Independent of Phase 1 but prerequisite for Phase 3 (teams benefit from mounted skills). Improves agent quality immediately for all runs, not just team runs.
**Delivers:** Personal skills, project skills, CLAUDE.md hierarchy, and external skill packs available inside containers. Workflow-specific skill selection.
**Addresses:** CLAUDE.md mounting (table stakes #2), agent config passthrough (table stakes #3), workflow-specific skill bundles (differentiator #6)
**Avoids:** Pitfalls #3 (credential exposure -- allowlist mounting), #8 (.planning/ directory conflicts), #9 (read-only mount breaking writes)
**Key work:** New `skills.ts` module (ContainerMounts pattern), config schema additions, `--add-dir` flag passthrough, WORKFLOW.md `skills:` section

### Phase 3: Agent Teams
**Rationale:** Depends on Phase 2 (skills should be mountable before teams use them). Highest risk (experimental API, resource scaling, checkpoint incompatibility). Highest token cost. Most novel differentiator.
**Delivers:** Multi-agent collaboration within a single container for complex tasks. Prompt-driven team creation with automatic resource scaling.
**Addresses:** Agent teams enablement (differentiator #5), team config in WORKFLOW.md, resource scaling, in-process teammate mode
**Avoids:** Pitfalls #4 (OOM from multiple processes), #5 (checkpoint incompatibility), #10 (untracked token costs), #13 (version requirement), #14 (tmux requirement)
**Key work:** New `teams.ts` module, env vars + prompt wrapping, resource auto-scaling, slot manager weighting, disable checkpointing for team runs

### Phase 4: Sub-Issue Advanced Features
**Rationale:** Builds on Phase 1 foundation. Lower priority -- nice-to-have polish on top of working DAG dispatch.
**Delivers:** Progress rollup comments on parent issues, auto-close parent when all children complete, webhook handling for sub-issue events.
**Addresses:** Progress rollup (differentiator #4), auto-close parent (differentiator #4)
**Key work:** Parent comment updates, auto-close logic, webhook sub-issue event handling

### Phase Ordering Rationale

- Phase 1 is independent and delivers the most fundamental capability (work ordering) with the lowest risk -- it extends existing patterns that already work
- Phase 2 is independent of Phase 1 but must precede Phase 3 -- teams without skills are possible but less effective
- Phase 3 depends on Phase 2 and carries the most risk (experimental API, resource scaling, checkpoint interaction) -- it should come last among the core features
- Phase 4 is additive polish on Phase 1 and can be deferred if schedule is tight
- Phases 1 and 2 could run in parallel if resourced, as they have no dependencies on each other

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Agent Teams):** Experimental feature with known limitations. Needs hands-on testing of in-process teammate mode inside Docker containers. Resource scaling heuristics (memory per teammate) should be validated empirically. Checkpoint/resume interaction needs explicit test cases.
- **Phase 1 (Sub-Issues, partial):** The `terminalIssueIds` caching strategy needs validation -- whether to use a simple TTL cache or event-driven invalidation from webhooks. Also need to verify sub-issue API pagination behavior with >20 children.

Phases with standard patterns (skip research-phase):
- **Phase 2 (Skill Mounting):** Well-documented Claude Code skill discovery. Straightforward bind-mount pattern already proven in `auth/mount.ts`. Config schema extension is routine.
- **Phase 4 (Sub-Issue Advanced):** Standard GitHub comment/webhook patterns already established in v2.0 GitHub App integration.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. All existing libraries verified for needed capabilities. |
| Features | HIGH | Table stakes clearly defined. Sub-issues REST API is GA. Skill discovery is well-documented. |
| Architecture | HIGH | All three features integrate at well-defined seams. Detailed code-level integration points identified. |
| Pitfalls | HIGH (sub-issues, skills) / MEDIUM (teams) | Sub-issue and skill pitfalls verified with official docs and community reports. Agent team pitfalls based on experimental feature docs. |

**Overall confidence:** HIGH for Phases 1-2, MEDIUM for Phase 3

### Gaps to Address

- **GitHub dependency API (blocking/blocked-by):** Docs are UI-focused only. No clear REST endpoints for reading programmatic blocking relationships. Defer to v2.2 or later; start with sub-issue hierarchy only.
- **Agent teams token accounting:** Claude Code may not report per-teammate token usage. Need empirical testing to determine if lead's `tokenUsage` includes teammate consumption or if a multiplier estimate is required.
- **ETag behavior across GitHub App token rotations:** Unclear if 304 responses work when the installation token changes. Need integration testing to confirm whether ETag cache should be cleared on rotation.
- **Sub-issue webhook events:** GitHub may not send webhook events specifically for sub-issue link/unlink operations. Need to verify which webhook event types fire when sub-issues are added or removed.

## Sources

### Primary (HIGH confidence)
- [GitHub Sub-Issues REST API Docs](https://docs.github.com/en/rest/issues/sub-issues) -- GA endpoints, parameters, limits
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills) -- SKILL.md format, discovery paths, --add-dir
- [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams) -- team architecture, limitations, in-process mode
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- --agents, --agent, --add-dir flags
- [GitHub API Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) -- 5000 req/hr, ETag behavior
- [Claude Code Subagents Documentation](https://code.claude.com/docs/en/sub-agents) -- subagent config, skills preloading

### Secondary (MEDIUM confidence)
- [Create GitHub Issue Hierarchy Using the API](https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/) -- sub_issue_id vs number gotcha
- [GitHub Sub-Issues Public Preview Discussion](https://github.com/orgs/community/discussions/148714) -- community limitations, nesting depth
- [GSD Framework](https://github.com/gsd-build/get-shit-done) -- skill/agent mounting patterns
- [Running Claude Code Safely in Devcontainers](https://www.solberg.is/claude-devcontainer) -- credential exposure risk

### Low confidence (needs validation)
- GitHub dependency API programmatic access -- no clear REST endpoints found; may require GraphQL with undocumented fields

---
*Research completed: 2026-03-13*
*Ready for roadmap: yes*
