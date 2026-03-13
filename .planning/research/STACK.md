# Technology Stack

**Project:** forgectl v2.1 — Sub-issue DAGs, Skill Mounting, Agent Teams
**Researched:** 2026-03-13
**Scope:** NEW capabilities only. Existing stack (TypeScript, Node 20+, Commander, Fastify 5, Dockerode, Zod, Vitest, tsup, Drizzle/SQLite, Octokit, etc.) is validated and excluded.

## Key Finding: Zero New NPM Dependencies

All three features build on existing dependencies. This milestone is integration work, not library adoption.

| Feature | Existing Dependency | Change Needed |
|---------|-------------------|---------------|
| Sub-issue DAGs | `@octokit/rest` + existing `githubFetch()` | New API calls, populate `blocked_by` |
| Skill mounting | `dockerode` | Additional bind mounts, `--add-dir` CLI flag |
| Agent teams | `dockerode` | Env vars, resource scaling, prompt changes |

---

## Feature 1: GitHub Sub-Issues DAG Dependencies

### API Endpoints

GitHub sub-issues reached GA in 2025. The REST API provides these endpoints (all callable via existing `githubFetch()` in `src/tracker/github.ts`):

| Endpoint | Method | Path | Purpose |
|----------|--------|------|---------|
| List sub-issues | GET | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | Fetch child issues of a parent |
| Add sub-issue | POST | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | Link an issue as child of parent |
| Remove sub-issue | DELETE | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues/{sub_issue_id}` | Unlink child from parent |
| Reprioritize | PATCH | `/repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | Reorder children |
| Get parent | GET | `/repos/{owner}/{repo}/issues/{issue_number}/parent` | Fetch parent issue for a given issue |

**Confidence: HIGH** (official GitHub docs, GA feature, verified endpoints)

### Critical API Gotcha: sub_issue_id vs issue number

The `sub_issue_id` parameter in POST/DELETE requests requires the issue's **internal numeric ID** (the `id` field, e.g. `7890123456`), NOT the human-readable issue number (e.g. `42`). This is a common source of 500 errors.

The current `normalizeIssue()` in `src/tracker/github.ts` stores `ghIssue.number` as `TrackerIssue.id` but discards `ghIssue.id`. The internal ID must be captured.

**Recommendation:** Store `ghIssue.id` in `TrackerIssue.metadata.github_internal_id`. This keeps the TrackerIssue interface tracker-agnostic (Notion doesn't have this concept) while preserving the data needed for sub-issue API calls.

### What Exists Already (Reusable)

| Component | Location | Reuse Strategy |
|-----------|----------|----------------|
| `TrackerIssue.blocked_by: string[]` | `src/tracker/types.ts` | Currently always `[]` for GitHub. Populate from parent issue chain. |
| `filterCandidates()` blocked_by check | `src/orchestrator/dispatcher.ts:100-105` | Already blocks dispatch when blockers are non-terminal. Just populate `blocked_by`. |
| DAG validation + topological sort | `src/pipeline/dag.ts` | Reuse `validateDAG()` and `topologicalSort()` for sub-issue dependency ordering. |
| `githubFetch()` with retry/rate-limit | `src/tracker/github.ts:131-193` | Add sub-issue endpoint calls using same authenticated fetch. |
| `getParallelGroups()` | `src/pipeline/dag.ts:155-191` | Use for parallel sub-issue scheduling. |

### Technology Needed

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@octokit/rest` | ^22.0.1 (existing) | Sub-issues REST API | Already installed. Sub-issues use standard REST; no special headers required (unlike GraphQL which needs `GraphQL-Features: sub_issues`). |

### What NOT to Add

- **No `@octokit/graphql`.** The REST API covers all sub-issue operations. The GraphQL API requires a special `GraphQL-Features: sub_issues` header and uses `node_id` instead of issue numbers, adding complexity. REST is simpler and matches the existing adapter pattern.
- **No dependency graph library (e.g. `graphlib`, `dagre`).** The existing `src/pipeline/dag.ts` already implements DAG validation, cycle detection, topological sort, and parallel grouping. Reuse it.

---

## Feature 2: Skill/Config Bind-Mounting into Containers

### How Claude Code Discovers Skills

Claude Code loads skills from these locations (in priority order):

| Priority | Location | Path Pattern | Loaded When |
|----------|----------|-------------|-------------|
| 1 (highest) | Enterprise | Managed settings | Always |
| 2 | Personal | `~/.claude/skills/<name>/SKILL.md` | Always |
| 3 | Project | `.claude/skills/<name>/SKILL.md` (in CWD) | Always |
| 4 | Additional dirs | `.claude/skills/<name>/SKILL.md` inside `--add-dir` paths | When `--add-dir` specified |

For CLAUDE.md files from additional directories: set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

**Confidence: HIGH** (official Claude Code docs at code.claude.com/docs/en/skills)

### Skill File Format

Every skill directory contains a `SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill
description: What this skill does and when to use it
disable-model-invocation: true   # optional: manual-only
allowed-tools: Read, Grep, Bash  # optional: tool restrictions
context: fork                     # optional: run in subagent
---

Markdown instructions here...
```

Key frontmatter fields relevant to forgectl integration:

| Field | Purpose | Relevance |
|-------|---------|-----------|
| `name` | Slash command name | Used for invocation |
| `description` | When Claude should auto-load | Drives automatic skill activation |
| `disable-model-invocation` | Prevent auto-triggering | Important for dangerous skills like deploy |
| `allowed-tools` | Tool restrictions | Security boundary |
| `context: fork` | Run in isolated subagent | Useful for parallel skill execution |

### Docker Bind-Mount Strategy

The existing `createContainer()` in `src/container/runner.ts` accepts `binds: string[]`. Skills/configs are mounted read-only so Claude Code inside the container can discover them.

| Mount Purpose | Host Path | Container Path | Mode | Claude Code Flag |
|---------------|-----------|----------------|------|-----------------|
| GSD skills directory | User-configured skill path(s) | `/forgectl-skills/.claude/skills/` | `ro` | `--add-dir /forgectl-skills` |
| Project CLAUDE.md | Workspace `.claude/CLAUDE.md` | Already in workspace bind | `rw` | None (auto-discovered in CWD) |
| Settings with env vars | Generated settings.json | `/home/node/.claude/settings.json` | `ro` | None (auto-discovered in `~/.claude/`) |

The container's Claude Code invocation appends `--add-dir /forgectl-skills` to pick up mounted skills. Skills from `--add-dir` directories are auto-discovered and support hot-reload (changes detected without restart).

### Integration Changes Needed

1. **`src/agent/types.ts`** - Add `additionalDirs?: string[]` to `AgentOptions`
2. **`src/agent/claude-code.ts`** - Append `--add-dir` flags in `buildShellCommand()`
3. **`src/container/runner.ts`** - Accept skill bind mounts in `createContainer()`
4. **`src/config/schema.ts`** - New `skills` config section (Zod validated)
5. **`src/workflow/types.ts`** - Workflow-level skill path overrides

### Technology Needed

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `dockerode` | ^4.0.2 (existing) | Bind mounts via `HostConfig.Binds` | Already used. Add more bind entries for skill directories. |

### What NOT to Add

- **No Docker volume plugins.** Simple bind mounts suffice. Skills are small text files (< 500 lines per SKILL.md recommended).
- **No file-sync tools.** Read-only mounts are sufficient. Skills are static during execution.
- **No special packaging/bundling.** Skills are just directories with SKILL.md files. Mount the directory tree as-is.
- **No `settings.json` generation library.** Write a simple JSON file with the needed env vars. It is three fields.

---

## Feature 3: Claude Code Agent Teams Inside Containers

### How Agent Teams Work

Agent teams are an experimental Claude Code feature (v2.1.32+) where a lead session spawns teammate instances that coordinate via shared task list and mailbox messaging.

**Confidence: MEDIUM** (official docs, but marked experimental with known limitations)

### Architecture Summary

| Component | Role | Storage |
|-----------|------|---------|
| Team lead | Creates team, spawns teammates, coordinates | Main Claude Code session |
| Teammates | Independent Claude Code instances, own context window | `~/.claude/teams/{team-name}/config.json` |
| Task list | Shared work items with pending/in-progress/completed states | `~/.claude/tasks/{team-name}/` |
| Mailbox | Inter-agent messaging (point-to-point and broadcast) | Internal to Claude Code |

### Enabling Inside Containers

| Requirement | Configuration | Notes |
|-------------|--------------|-------|
| Feature flag | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var | Pass via container env |
| Display mode | `--teammate-mode in-process` or `teammateMode: "in-process"` in settings.json | Containers have no tmux/iTerm2. Must use in-process mode. |
| Writable home | `~/.claude/tasks/` and `~/.claude/teams/` must be writable | Default container filesystem is writable; just ensure the paths exist |
| Resources | N+1 Claude Code processes (lead + N teammates) | Increase memory/CPU limits for team-enabled workflows |
| API key | All teammates share the lead's Anthropic API key | Already injected via container secrets |
| Permissions | Teammates inherit lead's `--dangerously-skip-permissions` | Already set by forgectl |
| Version | Claude Code >= v2.1.32 | Container image must have recent enough version |

### How forgectl Triggers Teams

Agent teams are NOT triggered by a CLI flag. They are triggered by the **prompt content** instructing the lead to create a team. This means:

1. The prompt builder (`src/context/`) generates prompts that instruct the lead to spawn teammates
2. The container needs scaled resources when team mode is expected
3. The `AgentOptions.timeout` should be higher (teams do parallel work but wall-clock time is longer)

Example prompt injection for team mode:
```
Create an agent team with 3 teammates to work on this task:
- Teammate 1: Implement the core logic in src/feature/
- Teammate 2: Write tests in test/feature/
- Teammate 3: Update documentation

Wait for all teammates to complete before finishing.
```

### Resource Scaling

| Config | Single Agent | Agent Team (3 teammates) | Agent Team (5 teammates) |
|--------|-------------|-------------------------|-------------------------|
| Memory | 4 GB (default) | 8 GB | 12 GB |
| CPUs | 2 | 4 | 6 |
| Timeout | 10 min | 20 min | 30 min |

The multiplier should be configurable per workflow, not hardcoded.

### Known Limitations (from official docs)

| Limitation | Impact on forgectl |
|------------|-------------------|
| No session resumption for teammates | If container crashes, team state is lost. Checkpoint at issue level, not team level. |
| Task status can lag | Teammates may not mark tasks complete. The lead may need nudging via timeout. |
| One team per session | Fine for forgectl -- one issue = one container = one team. |
| No nested teams | Teammates cannot spawn sub-teams. OK for current scope. |
| Shutdown can be slow | Budget for graceful shutdown time in container lifecycle. |

### Technology Needed

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `dockerode` | ^4.0.2 (existing) | Container env vars, resource limits | Add team-specific env vars and scale resources. |

### What NOT to Add

- **No tmux in container images.** `in-process` mode works without tmux. Adding tmux to Docker images increases image size and complexity for zero benefit in headless operation.
- **No external team orchestration.** Let Claude Code's built-in team coordination handle intra-task parallelism. forgectl orchestrates at the issue level; Claude Code orchestrates at the sub-task level. These are different abstraction layers.
- **No `agent-relay` for team communication.** The existing `agent-relay` package is for forgectl's own multi-agent patterns (review mode, parallel pipelines). Claude Code teams use their own internal messaging. Do not mix them.
- **No Claude Code SDK or programmatic API.** Claude Code is invoked as a CLI tool via `claude -p`. There is no SDK for controlling teams programmatically. The prompt is the interface.

---

## Configuration Additions

New Zod schema fields in `src/config/schema.ts`:

```typescript
// Skills mounting config
skills: z.object({
  paths: z.array(z.string()).optional(),    // Extra skill dirs to mount
  mountUserSkills: z.boolean().default(true), // Mount ~/.claude/skills/
}).optional()

// Agent team config (per workflow in WORKFLOW.md)
team: z.object({
  enabled: z.boolean().default(false),
  size: z.number().min(2).max(10).default(3),  // Suggested teammate count
  resourceMultiplier: z.number().min(1).max(5).default(2),  // Memory/CPU scaling
  timeout: z.number().optional(),  // Override timeout for team tasks
}).optional()

// Sub-issue config (extends tracker config)
subIssues: z.object({
  enabled: z.boolean().default(false),
  maxDepth: z.number().min(1).max(5).default(2),  // Max nesting depth to fetch
  autoBlock: z.boolean().default(true),  // Auto-populate blocked_by from parent chain
}).optional()
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Sub-issue API | REST via `githubFetch()` | GraphQL via `@octokit/graphql` | REST is simpler, no special headers, consistent with existing adapter. GraphQL `sub_issues` feature flag adds fragility. |
| Sub-issue ID storage | `metadata.github_internal_id` | New `internalId` field on TrackerIssue | Keeps TrackerIssue interface tracker-agnostic. Only GitHub needs this internal ID. Notion sub-tasks (if ever) would use UUIDs natively. |
| Skill delivery | Bind mounts + `--add-dir` | Copy skills into container image at build time | Bind mounts allow per-run skill selection without image rebuilds. More flexible. |
| Skill delivery | Bind mounts + `--add-dir` | Docker volumes | Volumes add lifecycle management complexity. Bind mounts are simpler for read-only content. |
| Team coordination | Claude Code native teams | forgectl `agent-relay` multi-agent | Different abstraction levels. `agent-relay` coordinates across issues/containers. Claude Code teams coordinate within a single task. Using `agent-relay` for intra-task work would fight Claude Code's own coordination. |
| Team display | `in-process` mode | Install `tmux` in container | Containers run headless via `claude -p`. tmux adds image bloat for zero benefit. |
| DAG library | Existing `src/pipeline/dag.ts` | `graphlib` npm package | Already have validated, tested DAG code. Adding a dependency for the same functionality is waste. |

## Installation

No new packages required:

```bash
# Verify existing dependencies cover all needs
npm ls @octokit/rest dockerode zod
# All three should already be installed at current versions

# No new installs needed
```

## What NOT to Add (Summary)

| Dependency | Why Skip |
|------------|----------|
| `@octokit/graphql` | REST API covers all sub-issue operations without special headers |
| `graphlib` / `dagre` | Existing `src/pipeline/dag.ts` already has DAG validation, cycle detection, topological sort |
| `tmux` (in container image) | `in-process` teammate mode works without it |
| Any Claude Code SDK | Does not exist. CLI with `-p` flag is the programmatic interface |
| `agent-relay` for teams | Wrong abstraction level. Claude Code teams have their own messaging |
| Docker volume plugins | Bind mounts are simpler and sufficient for read-only skill files |
| `node-cron` / scheduling lib | Existing poll loop + setTimeout patterns suffice |

## Sources

- [GitHub Sub-Issues REST API Docs](https://docs.github.com/en/rest/issues/sub-issues) -- HIGH confidence, GA feature
- [GitHub Blog: Sub-Issues and Projects REST API](https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/) -- HIGH confidence
- [Create GitHub Issue Hierarchy Using the API](https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/) -- MEDIUM confidence, verified sub_issue_id vs number gotcha
- [GitHub Sub-Issues Public Preview Discussion](https://github.com/orgs/community/discussions/148714) -- MEDIUM confidence, community discussion
- [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams) -- HIGH confidence, official docs
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills) -- HIGH confidence, official docs
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- HIGH confidence, official docs
- [Claude Code --add-dir Guide](https://claudelog.com/faqs/--add-dir/) -- MEDIUM confidence, community source verified against official docs
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless) -- HIGH confidence, official docs
