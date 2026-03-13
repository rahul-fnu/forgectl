# Domain Pitfalls

**Domain:** Adding GitHub sub-issues DAG dependencies, skill/config bind-mounting (GSD), and Claude Code agent teams to an existing Docker-based AI orchestrator
**Researched:** 2026-03-13
**Confidence:** HIGH for sub-issues and bind-mounting (verified with official docs), MEDIUM for agent teams (experimental feature, docs verified but behavior may change)

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or security breaches.

### Pitfall 1: GitHub Sub-Issues API Uses Internal `id`, Not Issue Number

**What goes wrong:**
The REST API endpoint `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` requires a `sub_issue_id` parameter that is the issue's internal resource ID (a 10+ digit number), NOT the human-visible issue number from URLs. Developers pass `42` when the API needs `3000028010`. The API returns a cryptic `404 Not Found: "The provided sub-issue does not exist"`. This looks like a permissions issue, wasting hours debugging token scopes.

**Why it happens:**
GitHub issues have three identifiers: `number` (visible in URLs, e.g. #42), `id` (internal resource ID, e.g. 3000028010), and `node_id` (GraphQL global ID). The REST endpoint documentation says `sub_issue_id` but does not clearly distinguish which ID it means. The `gh issue view --json id` CLI command returns the `node_id`, not the numeric `id` needed for the REST call. The existing forgectl `TrackerIssue.id` field stores the issue number as a string, which is the wrong identifier for this API.

**Consequences:**
- Silent 404s when trying to create parent-child relationships
- TrackerIssue.id cannot be used directly as `sub_issue_id`
- If worked around by adding a separate `resourceId` field, all existing tracker adapter code and the `blocked_by` array semantics must be updated

**Prevention:**
- Fetch the full issue object via REST (`GET /repos/{owner}/{repo}/issues/{number}`) and extract the `id` field (not `number`, not `node_id`) before calling the sub-issues endpoint
- Add a `resourceId` field to TrackerIssue metadata rather than changing the `id` field (backward compatibility)
- Use the GraphQL API with `addSubIssue` mutation instead -- it uses `node_id` which is more consistently available, but requires the `GraphQL-Features: sub_issues` header
- Write an integration test that creates a real sub-issue relationship against a test repo to validate ID handling

**Detection:**
- 404 errors from the sub-issues endpoint despite correct authentication
- `sub_issue_id` values that are small numbers (1-1000) instead of 10+ digit resource IDs
- Tests passing with mocked API responses but failing against real GitHub

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

### Pitfall 2: GraphQL Sub-Issues Require Feature Flag Header

**What goes wrong:**
GraphQL queries and mutations for sub-issues silently return null or omit fields when the `GraphQL-Features: sub_issues` header is not included. The query doesn't error -- it just returns incomplete data. The `subIssues`, `subIssuesSummary`, and `parent` fields appear to not exist. Developers conclude the API doesn't support what they need and build a workaround using issue body parsing or task lists.

**Why it happens:**
GitHub's sub-issues feature is in public preview. GraphQL feature-gated fields don't throw errors when the header is missing -- they simply don't resolve. This is unlike REST APIs that return explicit 404/403 errors. The Octokit GraphQL client doesn't add this header by default.

**Consequences:**
- Building unnecessary workarounds to parse issue bodies for parent-child relationships
- `subIssuesSummary` returning null, leading to incorrect DAG construction
- `parent` field returning null, breaking dependency chain detection

**Prevention:**
- Always include `GraphQL-Features: sub_issues` header on every GraphQL request that touches sub-issues
- With @octokit/graphql: `graphql(query, { headers: { 'GraphQL-Features': 'sub_issues' } })`
- Add a startup validation query that fetches a known parent issue's `subIssuesSummary` to confirm the header is working
- Test against real GitHub, not mocked responses, for at least one integration test

**Detection:**
- `subIssuesSummary` returning `null` for issues that visibly have sub-issues in the GitHub UI
- `parent` field always null despite the issue having a parent

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

### Pitfall 3: Bind-Mounting ~/.claude/ Exposes OAuth Tokens to Container Code

**What goes wrong:**
Mounting `~/.claude/` (or parts of it) read-only into a container gives the agent access to OAuth tokens, session credentials, and configuration. A malicious or prompt-injected agent can read `.credentials.json` containing access tokens, refresh tokens, and scopes. These tokens can be exfiltrated if the container has network access (which is the default in forgectl). The agent now has the user's full Anthropic account access outside the container.

**Why it happens:**
The existing `prepareClaudeMounts()` in `src/auth/mount.ts` already mounts `~/.claude` as read-only for OAuth sessions (line 26). Adding GSD skill mounting requires mounting additional content from `~/.claude/` (CLAUDE.md files, settings, custom commands). The temptation is to mount the entire directory. But `~/.claude/` contains both configuration (safe to share) and credentials (dangerous to share) in the same tree.

**Consequences:**
- OAuth token exfiltration if agent is compromised or prompt-injected
- Token works outside the container -- attacker can make API calls as the user
- Credential rotation requires re-authenticating all active containers
- Violates the security principle that containers should only have credentials needed for their specific task

**Prevention:**
- NEVER mount `~/.claude/` wholesale -- selectively copy specific files into a staging directory
- Separate concerns: credentials go via the existing secrets mechanism (`/run/secrets/`), configuration/skills go via a separate read-only mount
- For GSD skills: copy only `CLAUDE.md`, `settings.json` (sanitized), and `commands/` directory -- exclude `.credentials.json`, `statsig/`, `todos/`, any token files
- Create a `prepareSkillMounts()` function that builds a filtered copy, similar to how `prepareCodexMounts()` copies only `auth.json` and `config.toml`
- Use an explicit allowlist of files/directories to mount, not a denylist (new credential files added to ~/.claude/ should be excluded by default)
- For CLAUDE.md files in project directories: mount them read-only via a separate bind at a known path like `/home/node/.claude-skills/`

**Detection:**
- Bind strings containing `/.claude:` without `:ro` suffix
- Container processes able to `cat /home/node/.claude/.credentials.json`
- Network egress from container to non-Anthropic endpoints while credential files are mounted

**Phase to address:** Phase 2 (Skill/Config Mounting)

---

### Pitfall 4: Agent Teams Spawn Multiple Claude Code Processes, Exhausting Container Memory

**What goes wrong:**
Agent teams create N+1 Claude Code processes (1 lead + N teammates), each with its own context window and Node.js runtime. The current container defaults (`4g` memory from `parseMemory()` in `runner.ts`) are sized for a single Claude Code process. With 3 teammates + 1 lead, four Claude Code processes run simultaneously, each consuming 500MB-1GB of memory. The container hits the memory limit, the OOM killer fires, and the entire run dies with no useful error message.

**Why it happens:**
The container resource limits in `runner.ts` are set per-container based on the RunPlan, which was designed for single-agent execution. Agent teams are an orthogonal feature that multiplies resource consumption inside the same container. The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var enables teams, but nothing adjusts the container's memory/CPU limits to compensate.

**Consequences:**
- Container OOM kills with no error context -- the run just dies
- Docker `inspect` shows `OOMKilled: true` but the forgectl error message is generic ("Unexpected worker error")
- If memory limit is simply raised to 16GB, the host machine may run out of resources when multiple concurrent runs each have teams enabled
- The existing `slot_manager` concurrency control counts runs, not processes -- 5 concurrent runs with 4 agents each = 20 Claude Code processes

**Prevention:**
- When agent teams are enabled, multiply the base memory limit by (1 + expected_teammates): e.g., `4g` base becomes `16g` for a team of 4
- Add a `team_size` or `max_teammates` field to the workflow/run configuration that feeds into resource calculation
- Update the slot manager to account for team size: a run with 4 agents should consume 4 slots, not 1
- Set `--pids-limit` on the container (e.g., 200) to prevent unbounded process spawning
- Add OOM detection: after container death, check `container.inspect()` for `OOMKilled` and report it explicitly
- Consider a maximum team size cap per workflow (configurable, default 5)

**Detection:**
- Container exits with code 137 (SIGKILL from OOM)
- `docker inspect` showing `OOMKilled: true`
- Host system swap usage spiking during multi-agent runs
- Slot utilization appearing low while host resources are exhausted

**Phase to address:** Phase 3 (Agent Teams)

---

### Pitfall 5: Agent Teams Cannot Resume After Container Restart

**What goes wrong:**
The lead agent creates teammates and maintains team state in `~/.claude/teams/{team-name}/config.json` and `~/.claude/tasks/{team-name}/`. If the container stops (OOM, daemon crash, checkpoint/pause), these files are inside the container's filesystem and are lost. On resume, the lead tries to message teammates that no longer exist. The official docs confirm: "/resume and /rewind do not restore in-process teammates."

**Why it happens:**
Agent teams store coordination state (team config, task list, mailbox) in the filesystem at `~/.claude/teams/` and `~/.claude/tasks/`. forgectl's durable execution model (checkpoint/resume from v2.0) assumes it can serialize run state and resume later. But agent team state is managed internally by Claude Code, not by forgectl, and there is no API to serialize/restore team state.

**Consequences:**
- Checkpoint/resume (v2.0 feature) is incompatible with agent teams
- Crash recovery cannot restore team runs -- they must restart from scratch
- Paused runs with teams cannot be resumed, wasting all prior agent work
- The lead may attempt to message nonexistent teammates, producing confusing errors

**Prevention:**
- Treat agent team runs as non-checkpointable: disable checkpoint/resume when teams are enabled
- On failure/crash: restart the entire team run from scratch rather than attempting resume
- Bind-mount a host directory to `~/.claude/teams/` and `~/.claude/tasks/` so team state persists across container restarts -- but note this only helps if teammates are re-spawned, which Claude Code doesn't do automatically
- Document that agent team runs have weaker durability guarantees than single-agent runs
- Add explicit error handling: if a team run resumes and teammates are gone, fail fast with a clear message rather than letting the lead send messages into the void
- Consider wrapping team runs in a simple retry-from-scratch policy rather than the checkpoint-based resume

**Detection:**
- Resume attempts that hang or produce "teammate not found" errors
- Team config files missing after container restart
- Runs stuck in "running" state after daemon recovery

**Phase to address:** Phase 3 (Agent Teams), must coordinate with existing checkpoint/resume from v2.0

---

### Pitfall 6: Sub-Issue DAG Cycles Create Infinite Dispatch Loops

**What goes wrong:**
GitHub sub-issues enforce a tree structure (single parent, max 8 levels), but the `blocked_by` field in TrackerIssue is a general-purpose array that could reference any issue. If users manually add `blocked_by` references that create cycles (A blocks B, B blocks C, C blocks A), or if sub-issue relationships are combined with manual dependency labels to form cycles, the dispatcher's `filterCandidates()` function will never unblock the cycle -- those issues are permanently stuck. Worse, if cycle detection is absent, a naive topological sort will loop infinitely.

**Why it happens:**
GitHub sub-issues are tree-structured (no cycles possible within the sub-issue hierarchy itself). But forgectl's `blocked_by` is populated from multiple sources: sub-issue parent-child relationships, dependency labels, and potentially manual overrides. Merging these sources can create cycles that no single source would have alone.

**Consequences:**
- Issues permanently stuck as "blocked" with no path to unblocking
- If the dispatcher attempts topological sorting without cycle detection, infinite loop or stack overflow
- Silent failure -- no error is raised, issues just never get dispatched

**Prevention:**
- Implement cycle detection when constructing the dependency DAG (Kahn's algorithm or DFS-based cycle detection)
- If a cycle is detected, log a warning and break it by removing the edge that was added last (or the one from the non-sub-issue source)
- Add a `max_depth` limit on dependency chain traversal (e.g., 20) as a safety net
- The existing `filterCandidates()` checks `blocked_by` linearly -- extend it to do a full DAG analysis on the candidate set
- Report cycles back to the user via a GitHub comment: "Issues #A, #B, #C form a dependency cycle. Please resolve."

**Detection:**
- Issues with `blocked_by` entries that never reach terminal state
- Dispatcher log showing the same set of issues filtered out on every poll cycle
- `filterCandidates()` returning empty sets when there are clearly open issues

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

## Moderate Pitfalls

### Pitfall 7: Sub-Issues Pagination Missed, Returning Only First Page of Children

**What goes wrong:**
A parent issue has 30 sub-issues. The GraphQL query uses `subIssues(first: 20)` and gets only the first 20. The remaining 10 are never fetched, so their dependencies are not tracked. Some issues appear to have no parent and get dispatched out of order, or child issues that should be blocked are dispatched prematurely.

**Prevention:**
- Always paginate: use cursor-based pagination (`after` parameter) and fetch all pages
- GitHub sub-issues have a maximum of 100 per level, so pagination should complete in at most 5 pages with `first: 20`
- Add a test with >20 sub-issues to verify pagination works
- Cache the full sub-issue tree per parent to avoid re-fetching on every poll cycle

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

### Pitfall 8: GSD .planning/ Directory Conflicts with Workspace Management

**What goes wrong:**
GSD writes research files, plans, and roadmaps to `.planning/` in the working directory. When forgectl mounts a workspace into the container and the agent uses GSD tooling, GSD writes to `.planning/` inside the workspace. On output collection, forgectl's git output mode commits these files. The `.planning/` directory ends up in the PR, cluttering the codebase. Or: forgectl's exclude patterns strip `.planning/`, and GSD's work products are silently lost.

**Prevention:**
- Add `.planning/` to the default exclude patterns for git output mode -- GSD artifacts are process artifacts, not deliverables
- If GSD planning artifacts should be preserved, collect them separately from the main output (e.g., as run metadata stored in SQLite, not in the git branch)
- Configure GSD's output directory via environment variable or config to write to a separate mount point (e.g., `/tmp/gsd-planning/`) rather than the workspace root
- Document that `.planning/` in workspace bind-mounts is ephemeral and should not be relied upon for persistence

**Phase to address:** Phase 2 (Skill/Config Mounting)

---

### Pitfall 9: Mounting CLAUDE.md as Read-Only Breaks Claude Code's Write Expectations

**What goes wrong:**
Claude Code expects to be able to write to CLAUDE.md and .claude/ directory for auto-memory, project settings updates, and MCP server configuration. If these are mounted read-only from the host, Claude Code encounters write errors. These errors may be silent (Claude Code catches them internally) or may cause degraded behavior (memory not persisting, settings not updating).

**Prevention:**
- Mount CLAUDE.md files as copies in a writable location, not as direct read-only bind-mounts
- Use the same copy-then-mount pattern already used for `.claude.json` in `prepareClaudeMounts()` (line 30-34 of mount.ts)
- For skills/custom commands that should be read-only: mount them at a separate path and configure Claude Code to read from there
- Test that Claude Code can function normally with the mounted configuration -- run a simple prompt and verify no write errors in stderr

**Phase to address:** Phase 2 (Skill/Config Mounting)

---

### Pitfall 10: Agent Teams Token Costs Scale Linearly and Are Not Tracked Per-Teammate

**What goes wrong:**
Each teammate is an independent Claude Code process with its own context window. A team of 4 agents uses roughly 4x the tokens of a single agent. The existing cost tracking in forgectl records token usage per run, but with teams, the lead's `tokenUsage` may not include teammate consumption. Budget enforcement sees 1x cost when actual cost is 4x. Runs pass budget checks but the actual Anthropic bill is 4x higher than tracked.

**Prevention:**
- When teams are enabled, multiply the estimated cost by the team size for budget pre-flight checks
- After run completion, aggregate token usage from all teammates (if Claude Code reports per-process usage) or apply a multiplier
- Add a `team_cost_multiplier` to budget configuration (default: teammate_count + 1)
- Warn users in documentation that agent team runs consume significantly more tokens
- Set tighter per-run budget limits when teams are enabled

**Phase to address:** Phase 3 (Agent Teams)

---

### Pitfall 11: ETag Cache Invalidation When GitHub App Token Rotates

**What goes wrong:**
The existing GitHub tracker adapter uses ETags for conditional requests (304 Not Modified). GitHub App installation tokens expire after 1 hour. When a new token is generated, ETags cached under the old token are invalid -- GitHub treats the new token as a different client and returns full responses regardless. The adapter's ETag cache gives false confidence that data is fresh when it's actually stale.

**Prevention:**
- Clear the ETag cache when the installation token is rotated
- Or: always include the ETag regardless of token -- GitHub 304 behavior may still work across tokens (verify with integration test)
- Track token generation time alongside ETags; invalidate ETags older than the current token

**Phase to address:** Phase 1 (Sub-Issues Integration, since it adds more API calls that use ETags)

---

### Pitfall 12: Sub-Issues Feature Not Enabled on Target Repository

**What goes wrong:**
Sub-issues are a public preview feature that requires opt-in per organization or repository. The forgectl orchestrator starts polling for sub-issues, gets empty responses (no errors), and silently operates without dependency information. Issues that should be blocked are dispatched immediately.

**Prevention:**
- On startup, make a probe request to check if sub-issues are available (e.g., query `subIssuesSummary` for a known issue)
- If the feature is not available, log a clear warning and fall back to label-based dependency tracking
- Document the requirement: users must enable sub-issues in their GitHub organization settings

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

## Minor Pitfalls

### Pitfall 13: Agent Teams Require Claude Code v2.1.32+

**What goes wrong:**
The container image has an older version of Claude Code. Agent teams silently fail to activate or produce confusing errors about unknown commands. The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var is set but has no effect.

**Prevention:**
- Pin Claude Code version in the container Dockerfile; verify >= v2.1.32
- Add a version check at container startup: `claude --version` and validate
- Include the version requirement in workflow configuration documentation

**Phase to address:** Phase 3 (Agent Teams)

---

### Pitfall 14: tmux Requirement for Agent Team Split Panes Inside Containers

**What goes wrong:**
Agent teams' split-pane mode requires tmux or iTerm2. Inside a Docker container, neither is available by default. The team falls back to in-process mode, which works but complicates log collection because all teammate output is multiplexed into a single stream.

**Prevention:**
- Install tmux in the container image if agent teams are a supported feature
- For log collection: use in-process mode and parse the multiplexed output, OR redirect each teammate's output to separate log files
- Since forgectl runs agents non-interactively (`claude -p "..."`), split panes are irrelevant -- use in-process mode explicitly via `--teammate-mode in-process`

**Phase to address:** Phase 3 (Agent Teams)

---

### Pitfall 15: Sub-Issue Depth Limit (8 Levels) Silently Truncates Deep Hierarchies

**What goes wrong:**
GitHub enforces a maximum of 8 levels of sub-issue nesting and 100 sub-issues per level. If a project uses deep hierarchies, deeper levels are silently ignored by the API, and forgectl's DAG is incomplete.

**Prevention:**
- Log a warning if the dependency chain depth exceeds 6 levels (approaching the 8-level limit)
- Document the 8-level / 100-per-level limits in user-facing documentation
- For most projects this is not an issue -- flag it as a known limitation

**Phase to address:** Phase 1 (Sub-Issues Integration)

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Sub-Issues Integration | ID confusion (number vs resource id vs node_id) | Use GraphQL API with `node_id`; always include `GraphQL-Features: sub_issues` header |
| Sub-Issues Integration | Cycle detection in merged dependency sources | Implement Kahn's algorithm; break cycles from non-sub-issue sources |
| Sub-Issues Integration | Pagination of large sub-issue lists | Always paginate with cursor; test with >20 children |
| Sub-Issues Integration | Feature not enabled on repo | Probe on startup; graceful fallback to label-based deps |
| Skill/Config Mounting | Credential exposure via ~/.claude/ | Allowlist of files to copy; never mount entire directory |
| Skill/Config Mounting | .planning/ directory in output | Add to exclude patterns; or redirect to separate mount |
| Skill/Config Mounting | Read-only mounts breaking Claude Code writes | Copy files to writable staging directory |
| Agent Teams | Container OOM from multiple processes | Scale memory by team size; update slot manager accounting |
| Agent Teams | Incompatible with checkpoint/resume | Disable checkpointing for team runs; restart-from-scratch on failure |
| Agent Teams | Token costs not tracked per teammate | Apply cost multiplier; warn on team budget pre-flight |
| Agent Teams | Version requirement (>= v2.1.32) | Version check at startup; pin in Dockerfile |

## Integration Risks with Existing v2.0 Subsystems

These are risks specific to how the new features interact with existing forgectl subsystems.

| Existing Subsystem | New Feature | Integration Risk | Mitigation |
|-------------------|-------------|-----------------|------------|
| Dispatcher (`filterCandidates`) | Sub-issues DAG | `blocked_by` semantics change from flat list to DAG edges; existing code does linear check | Extend to full DAG analysis; backward-compatible for issues without sub-issues |
| Slot Manager | Agent Teams | Slots count runs, not processes; teams multiply actual resource usage | Weight slots by team size; or count processes |
| Checkpoint/Resume | Agent Teams | Team state is not serializable; resume produces orphaned teammate references | Disable checkpointing for team runs |
| Container Runner (`createContainer`) | Agent Teams | Memory/CPU limits sized for 1 agent | Parameterize limits by team size |
| Auth Mount (`prepareClaudeMounts`) | Skill Mounting | Current function handles credentials; skill mounting is a separate concern | New `prepareSkillMounts()` function; don't extend existing one |
| Output Collection | GSD .planning/ | Git output mode commits everything; .planning/ pollutes PRs | Add to default excludes |
| Flight Recorder | Agent Teams | Events recorded per-run; team runs produce interleaved events from multiple processes | Tag events with teammate ID; or record team runs as a single aggregate |
| Budget Enforcement | Agent Teams | Budget checks assume 1 agent per run | Multiply estimates by team size |
| GitHub Comments | Sub-issues | Progress comments go on the dispatched issue; sub-issue context may be needed | Include parent issue reference in progress comments |

## "Looks Done But Isn't" Checklist

- [ ] **Sub-issues ID handling:** Tests pass with mocked responses using issue numbers, but fail against real GitHub API needing resource IDs
- [ ] **GraphQL feature header:** Queries work in GraphQL Explorer (which adds headers automatically) but fail in production code
- [ ] **Skill mount security:** Mounts work, but `.credentials.json` is accessible inside the container -- verify with `exec cat`
- [ ] **Agent team memory:** Single-agent test passes, but 4-agent team OOMs -- test with actual team size
- [ ] **Team + checkpoint:** Individual features tested, but checkpoint during team run not tested -- verify incompatibility is handled
- [ ] **DAG cycle detection:** Linear dependency chains tested, but cycles not tested -- create a cycle and verify it's detected
- [ ] **Sub-issue pagination:** Tested with <20 children, but not with >20 -- create 25+ sub-issues and verify all are fetched
- [ ] **Token tracking with teams:** Run cost reported, but only lead's tokens counted -- verify total matches Anthropic dashboard
- [ ] **ETag after token rotation:** Polling works initially, but after 1 hour when token rotates, verify ETags are handled correctly

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Wrong ID type for sub-issues API | LOW | Fix ID resolution code; no data loss; re-fetch sub-issue relationships |
| Missing GraphQL feature header | LOW | Add header; re-fetch data; no state corruption |
| Credential exposure via mount | HIGH | Rotate all exposed OAuth tokens immediately; audit container network logs for exfiltration; switch to allowlist mounting |
| Container OOM from agent teams | MEDIUM | Increase memory limits; restart failed runs; review slot manager accounting |
| Failed resume of team run | LOW | Mark run as failed; re-dispatch from scratch; document limitation |
| Dependency cycle blocking dispatch | LOW | Detect and report cycle; manually break cycle in GitHub; re-poll |
| .planning/ files in PR | LOW | Add to .gitignore or exclude pattern; force-push clean branch |
| Budget overrun from untracked team costs | MEDIUM | Reconcile actual Anthropic charges; adjust budget multiplier; pause until budget resets |

## Sources

- [GitHub Sub-Issues Public Preview Discussion](https://github.com/orgs/community/discussions/148714) -- limitations, nesting depth, quantity limits (HIGH confidence)
- [GitHub Changelog: REST API for Sub-Issues](https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/) -- REST endpoints available (HIGH confidence)
- [Create GitHub Issue Hierarchy Using the API](https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/) -- ID confusion, practical workarounds (HIGH confidence)
- [gh CLI 404 Error with Sub-Issues](https://github.com/cli/cli/issues/12258) -- `sub_issue_id` vs `number` confusion confirmed (HIGH confidence)
- [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams) -- official limitations, resource usage, architecture, known issues (HIGH confidence)
- [GitHub API Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) -- 5000 req/hr authenticated, ETag behavior (HIGH confidence)
- [GitHub API Best Practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) -- pagination, conditional requests, ETag per-token (HIGH confidence)
- [Claude Code Devcontainer Docs](https://code.claude.com/docs/en/devcontainer) -- credential mounting risks, security recommendations (HIGH confidence)
- [Running Claude Code Safely in Devcontainers](https://www.solberg.is/claude-devcontainer) -- .credentials.json exposure risk (MEDIUM confidence)
- [Claude Code Issue #1736: Re-authentication in Docker](https://github.com/anthropics/claude-code/issues/1736) -- credential persistence challenges (MEDIUM confidence)

---
*Pitfalls research for: forgectl v2.1 -- Sub-Issues, Skill Mounting, Agent Teams*
*Researched: 2026-03-13*
