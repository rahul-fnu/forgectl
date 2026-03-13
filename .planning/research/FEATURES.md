# Feature Landscape

**Domain:** AI agent orchestrator -- GitHub sub-issues, skill/config mounting, Claude Code agent teams
**Researched:** 2026-03-13
**Builds on:** forgectl v2.0 (existing orchestrator, tracker adapters, container sandbox, agent adapters)

---

## Table Stakes

Features users expect given existing forgectl capabilities. Missing = orchestrator feels incomplete for multi-issue workflows.

### 1. GitHub Sub-Issue Fetching and DAG Construction

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Fetch sub-issues via REST API (`GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`) | Parent issues with sub-issues are standard GitHub workflow; orchestrator must see them | Medium | Existing `GitHubAdapter` in `src/tracker/github.ts` |
| Build parent-child DAG from sub-issue relationships | Without this, orchestrator treats each sub-issue as independent work with no ordering | Medium | `TrackerIssue.blocked_by` field already exists but is always `[]` |
| Populate `blocked_by` from sub-issue hierarchy | Existing orchestrator already filters on `blocked_by`; just needs real data | Low | Sub-issue fetch above |
| Topological dispatch ordering respecting sub-issue hierarchy | Orchestrator should not start a child issue if its parent/blocker is incomplete | Low | Existing pipeline DAG executor has topological sort in `src/pipeline/` |
| Store GitHub internal `id` in TrackerIssue metadata | REST sub-issue API requires internal numeric `id` (not issue `number` and not `node_id`) for POST/DELETE operations | Low | Extend `normalizeIssue()` to store `ghIssue.id` in `metadata` |

**Confidence:** HIGH -- GitHub sub-issues REST API is documented and GA. Endpoints: `GET`, `POST`, `DELETE` on `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues`, plus `PATCH .../sub_issues/priority` for reprioritize. Limits: 100 sub-issues per parent, 8 nesting levels.

**Critical API detail:** The REST `POST` endpoint to add a sub-issue requires the issue's internal numeric `id` (from the `id` JSON field), NOT the issue `number` and NOT the `node_id`. The existing adapter uses `ghIssue.number` for `TrackerIssue.id`. Sub-issue operations will need `ghIssue.id` stored in `metadata.github_internal_id`.

### 2. CLAUDE.md / Skills / Agents Directory Mounting into Containers

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Mount project `.claude/` directory into container | Claude Code inside containers cannot see project skills, CLAUDE.md, or agent definitions without this | Low | Existing `prepareClaudeMounts()` in `src/auth/mount.ts` already mounts `~/.claude` for OAuth; extend pattern |
| Mount user-level `~/.claude/skills/` and `~/.claude/agents/` | Users' personal skills and agents (e.g., GSD framework at `~/.claude/skills/gsd-*/`) must be available inside the sandbox | Low | Same bind-mount pattern |
| Mount project `.claude/skills/` and `.claude/agents/` | Project-specific skills and agent definitions checked into the repo | Low | Workspace already copied via `prepareRepoWorkspace()` -- `.claude/` just needs to not be in exclude list |
| CLAUDE.md hierarchy preservation | Claude Code expects `~/.claude/CLAUDE.md` (global), `./CLAUDE.md` (project root), and nested `dir/CLAUDE.md` files | Low | Workspace copy already includes these if not excluded |
| Read-only mount for skills/agents, writable for agent-memory | Skills and agents should not be modified by the sandbox agent; `~/.claude/agent-memory/` directories need write access for persistent memory feature | Medium | Split bind-mounts: `:ro` for skills/agents, writable tmpdir for memory |

**Confidence:** HIGH -- Claude Code skill/agent/CLAUDE.md loading is purely file-system based and well-documented. Skill locations: `~/.claude/skills/<name>/SKILL.md` (user), `.claude/skills/<name>/SKILL.md` (project). Agent locations: `~/.claude/agents/<name>.md` (user), `.claude/agents/<name>.md` (project). Loading is hierarchical with priority: CLI flag > project > user > plugin.

### 3. Agent Config Passthrough (--agents flag, --model, etc.)

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|--------------|
| Pass `--agents` JSON flag to Claude Code invocations | Allows forgectl to inject subagent definitions for in-container Claude Code sessions without files on disk | Low | Existing `claudeCodeAdapter.buildShellCommand()` in `src/agent/claude-code.ts` appends flags |
| Pass `--agent <name>` flag to run Claude Code as a specific agent type | Enables running the main thread as a coordinator agent that can spawn subagents | Low | Same flag passthrough |
| Configure model per-agent in WORKFLOW.md | Already partially supported (`agent.model`); ensure it flows through to `--model` flag | Low | Existing config merge |
| Pass `--add-dir` for additional skill directories | Claude Code can load skills from additional directories; useful for shared skill repos | Low | Flag passthrough |

**Confidence:** HIGH -- Claude Code CLI flags are well-documented. `--agents` accepts inline JSON with `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `memory` fields. `--agent` sets main thread agent type.

---

## Differentiators

Features that set forgectl apart from manual multi-agent workflows. Not expected, but highly valued.

### 4. Automatic Sub-Issue DAG with Cross-Issue Dependency Resolution

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|--------------|
| Auto-discover full sub-issue tree (up to 8 levels deep) | No manual dependency annotation needed; orchestrator builds work graph from GitHub's native hierarchy | Medium | Sub-issue fetch, recursive traversal |
| Merge sub-issue hierarchy with explicit blocked-by dependencies | GitHub has BOTH parent/child (sub-issues) AND blocking/blocked-by (dependencies) -- forgectl should unify both into one DAG | High | Two different API surfaces; dependency API access is unclear (see pitfall below) |
| Progress rollup comments on parent issues | When sub-issues complete, post progress summary on parent ("3/5 sub-issues done, 2 in progress") | Medium | Existing `postComment()` on adapter |
| Auto-close parent when all sub-issues complete | Natural completion semantics for hierarchical work | Low | Existing `updateState()` + `auto_close` config |
| Create sub-issues from pipeline definitions | Allow forgectl to decompose a parent issue into sub-issues based on a pipeline YAML, then dispatch each | High | REST `POST /repos/{owner}/{repo}/issues` + sub-issue linking via internal `id` |

### 5. Claude Code Agent Teams in Containers

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|--------------|
| Enable agent teams inside containers via environment variable | Multiple Claude Code instances collaborate on complex issues within a single sandbox | Low | Pass `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var to container |
| Teammate isolation via git worktrees inside container | Each teammate gets its own worktree (Claude Code native `isolation: worktree` feature on subagents) | Medium | Container needs git installed, sufficient disk, worktree support |
| Configure team structure in WORKFLOW.md | Define lead agent type, preferred teammate count, task decomposition hints | Medium | New `team:` config schema section |
| Writable team state directories in container | Agent teams store state at `~/.claude/teams/{name}/config.json` and `~/.claude/tasks/{name}/`; these must be writable | Low | Writable bind-mount for `~/.claude/teams/` and `~/.claude/tasks/` |
| Token budget awareness for teams | Teams use significantly more tokens (each teammate is a separate Claude instance); forgectl should enforce per-run budget limits | Medium | Existing cost tracking + team multiplier estimation |
| In-process teammate mode (no tmux dependency) | Containers will not have tmux/iTerm2; in-process mode is the only viable option | Low | Set `--teammate-mode in-process` or config equivalent |

**Confidence:** MEDIUM -- Agent teams are experimental (gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var). Known limitations: no session resumption with in-process teammates, task status can lag, one team per session, no nested teams, lead is fixed. Feature could change or be removed. The in-process mode works in any terminal, which is good for containers.

### 6. Skill Injection and Custom Agent Definitions per Workflow

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|--------------|
| Workflow-specific skill bundles | Different workflows mount different skill sets (e.g., "api-conventions" for backend, "component-patterns" for frontend) | Medium | New `skills:` list in WORKFLOW.md front matter, selective skill directory mounting |
| Workflow-specific agent definitions (subagents) | Each workflow defines specialized subagents (e.g., code-reviewer, test-writer) that Claude Code can delegate to | Medium | Mount `.claude/agents/` or pass `--agents` JSON |
| Dynamic skill generation from issue context | Generate a temporary SKILL.md from the issue description/labels to guide the agent | Medium | Template expansion into `.claude/skills/` before mount |
| Preload skills into subagents via agent definition | Subagent `skills:` field injects full skill content at startup -- no discovery needed | Low | Agent definitions with `skills` field in frontmatter |

---

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Custom inter-agent messaging protocol | Claude Code agent teams already have mailbox messaging and shared task lists; don't reinvent | Use native agent team communication; forgectl orchestrates at the issue/container level |
| Persistent agent team sessions across issues | Agent teams are experimental and don't support session resumption; coupling forgectl to this is fragile | Spawn fresh teams per issue; use forgectl checkpoints for durable state |
| Nested agent teams (teams spawning sub-teams) | Claude Code explicitly prohibits this -- teammates cannot spawn their own teams | Decompose work via sub-issues instead; one team per leaf issue |
| Real-time streaming of teammate output to dashboard | Adds massive complexity; teammates run inside containers with their own contexts | Collect results after completion; post summaries to GitHub comments |
| Full CQRS for sub-issue state | Already decided against CQRS in v2.0; sub-issue state lives in GitHub | Poll GitHub for state; use flight recorder for audit trail |
| Managing GitHub Projects boards | Out of scope; forgectl manages issues, not project views | Users manage board views in GitHub UI |
| Sub-issue creation across repositories | GitHub sub-issues work within a single repo; cross-repo adds enormous complexity | Keep sub-issues within the configured repo; document limitation |
| Split-pane teammate mode in containers | Requires tmux/iTerm2 which containers do not have; adds unnecessary dependency | Always use `in-process` teammate mode in containers |
| Mounting entire `~/.claude/` writable | Security risk -- agent could modify user's global config, settings, or credentials | Mount specific subdirectories; skills/agents as `:ro`, only agent-memory as writable |
| Skill marketplace / skill package manager | Over-engineering for v2.1; manual skill placement works fine | Users place skills in `.claude/skills/` or mount via WORKFLOW.md config |

---

## Feature Dependencies

```
GitHub Internal ID Storage (1)
    |
    v
Sub-Issue Fetch (1) --> DAG Construction (1) --> Topological Dispatch (1)
                                              --> Progress Rollup (4)
                                              --> Auto-Close Parent (4)
                                              --> Sub-Issue Creation from Pipeline (4)

Skill/Config Mounting (2) --> Agent Config Passthrough (3)
                          |       |
                          |       v
                          |   Agent Teams in Containers (5)
                          |       |
                          |       v
                          |   Team Config in WORKFLOW.md (5)
                          |
                          --> Skill Injection per Workflow (6)
                          --> Dynamic Skill Generation (6)

CLAUDE.md Mounting (2) --> Agent Definitions Mounting (2) --> Workflow-Specific Agents (6)
```

**Critical path:** Sub-issue fetching must come first (unlocks DAG). Skill/config mounting must come before agent teams (teams need skills and agent definitions available in the container).

---

## MVP Recommendation

### Build first (foundation):

1. **GitHub sub-issue fetching + `blocked_by` population** -- Immediately makes the existing orchestrator DAG-aware for real GitHub hierarchies. Low-medium complexity, high value. Extends existing `GitHubAdapter.normalizeIssue()` to store `ghIssue.id` in metadata and populate `blocked_by` from sub-issue parent relationships. The orchestrator's existing `blocked_by` filtering logic handles the rest.

2. **`.claude/` directory mounting (skills + agents + CLAUDE.md)** -- Unlocks customizable agent behavior inside containers. Low complexity, extends existing `prepareClaudeMounts()` pattern in `src/auth/mount.ts`. Foundation for both agent teams and skill injection.

### Build second (configuration):

3. **Agent config passthrough (`--agents`, `--agent`, `--add-dir` flags)** -- Low complexity, immediate value. Lets WORKFLOW.md define specialized agents and skills for Claude Code to use inside containers.

4. **Workflow-specific skill/agent config in WORKFLOW.md** -- New `skills:` and `agents:` config sections that control what gets mounted and passed via CLI flags per workflow.

### Build third (advanced):

5. **Agent teams enablement** -- Pass `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, ensure writable `~/.claude/teams/` and `~/.claude/tasks/` directories, set `in-process` teammate mode. Medium complexity, high differentiator.

6. **Sub-issue DAG features (progress rollup, auto-close parent)** -- Low-medium complexity, builds on foundation from step 1.

### Defer:
- **Cross-issue dependency resolution (blocking/blocked-by)**: GitHub's dependency API for programmatic access is poorly documented; start with sub-issue hierarchy only.
- **Sub-issue creation from pipelines**: Complex two-way sync; start with read-only consumption of existing sub-issues.
- **Team task persistence across crashes**: Experimental feature limitations make this fragile; fresh teams per issue is safer.
- **Dynamic skill generation from issue context**: Nice optimization but not needed for initial value.

---

## Sources

### HIGH Confidence
- [GitHub REST API for sub-issues](https://docs.github.com/en/rest/issues/sub-issues) -- Official docs, GA endpoints
- [GitHub sub-issues architecture blog post](https://github.blog/engineering/architecture-optimization/introducing-sub-issues-enhancing-issue-management-on-github/) -- 100 sub-issues per parent, 8 nesting levels
- [GitHub issue dependencies docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) -- blocked-by/blocking relationships
- [Claude Code subagents documentation](https://code.claude.com/docs/en/sub-agents) -- Full subagent config: YAML frontmatter, --agents flag, tool restrictions, model selection, skills preloading, hooks, memory, worktree isolation
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills) -- SKILL.md format, directory locations (`~/.claude/skills/`, `.claude/skills/`), frontmatter fields, context:fork, supporting files, --add-dir

### MEDIUM Confidence
- [Claude Code agent teams documentation](https://code.claude.com/docs/en/agent-teams) -- Experimental feature, requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var, shared task list, mailbox messaging, in-process and split-pane modes, known limitations
- [GitHub sub-issues API practical guide](https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/) -- REST POST needs internal `id` not `number`; GraphQL needs `GraphQL-Features: sub_issues` header
- [GSD (Get-Shit-Done) framework](https://github.com/gsd-build/get-shit-done) -- Real-world example of skill/agent mounting, `$HOME` path handling in containers

### LOW Confidence
- GitHub dependency API programmatic access -- Docs are UI-focused only; no clear REST endpoints for reading blocked-by/blocking relationships programmatically. May require GraphQL with undocumented schema fields. Needs phase-specific research before building.
