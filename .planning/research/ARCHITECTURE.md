# Architecture Patterns

**Domain:** GitHub sub-issues DAG, skill/config mounting, agent teams -- integration with forgectl orchestrator
**Researched:** 2026-03-13

## Recommended Architecture

Three features, each with a clear integration surface into the existing codebase. The overarching principle: **extend, don't restructure**. forgectl's existing tracker/dispatcher/worker pipeline is sound; these features add capabilities at well-defined seams.

```
                    GitHub Sub-Issues
                         |
                    TrackerAdapter
                    (enriched blocked_by)
                         |
              +----------+----------+
              |                     |
         Dispatcher            Scheduler
    (DAG-aware filtering)  (terminalIds from sub-issues)
              |
           Worker
              |
    +---------+---------+
    |                   |
  Skill Mount       Agent Teams
  (bind mounts)    (team mode env)
    |                   |
  Container         Container
  (createContainer)  (invokeAgent)
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `src/tracker/github.ts` (MODIFY) | Fetch sub-issues from GitHub REST API, populate `blocked_by` | Dispatcher, Scheduler |
| `src/tracker/types.ts` (MODIFY) | Add `parent_id`, `sub_issue_ids` to TrackerIssue | All consumers of TrackerIssue |
| `src/orchestrator/scheduler.ts` (MODIFY) | Build `terminalIssueIds` from terminal state fetch | Dispatcher via tick |
| `src/container/skills.ts` (NEW) | Resolve skill directories, prepare bind mounts for CLAUDE.md + skills | Worker, prepareExecution |
| `src/config/schema.ts` (MODIFY) | Add `skills` config section with skill source paths, team config | Skill mount, agent teams |
| `src/agent/teams.ts` (NEW) | Agent teams orchestration: env setup, team lead prompt, teammate coordination | Worker |
| `src/agent/claude-code.ts` (MODIFY) | Support team env vars passed through | invoke.ts |

### Data Flow

**Sub-issues flow:**
```
GitHub API (GET /repos/{owner}/{repo}/issues/{number}/sub_issues)
  -> github.ts fetchSubIssues()
    -> normalizeIssue() populates blocked_by from sub-issue parent relationship
      -> dispatcher filterCandidates() checks blocked_by against terminalIssueIds
        -> terminalIssueIds built from closed issues (scheduler tick)
```

**Skill mounting flow:**
```
forgectl.yaml skills config OR WORKFLOW.md skills section
  -> skills.ts resolveSkillSources()
    -> prepareSkillMounts() returns { binds, env } (ContainerMounts pattern)
      -> prepareExecution() adds skill binds to container creation
        -> CLAUDE.md + skills available inside container at expected paths
```

**Agent teams flow:**
```
WORKFLOW.md team config OR forgectl.yaml agent.team section
  -> worker detects team config
    -> teams.ts buildTeamEnv() sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
      -> teams.ts buildTeamPromptPrefix() wraps task with team instructions
        -> Claude Code internally creates lead + teammates
          -> Claude Code manages task list, mailbox, coordination
```

## Feature 1: GitHub Sub-Issues DAG Dependencies

### Current State

- `TrackerIssue.blocked_by: string[]` exists but is **always empty** for GitHub issues
- `normalizeIssue()` in `github.ts` line 76 hardcodes `blocked_by: []`
- `filterCandidates()` in `dispatcher.ts` already checks `blocked_by` against `terminalIssueIds` (lines 99-105)
- `terminalIssueIds` in `scheduler.ts` line 64 is always an empty `Set<string>` -- never populated
- Pipeline system (`dag.ts`) has full DAG support but is separate from the orchestrator
- `webhookPayloadToTrackerIssue()` in `webhooks.ts` also hardcodes `blocked_by: []`

### GitHub Sub-Issues REST API

The sub-issues REST API is GA (since late 2024). Key endpoints:

```
GET  /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues  (body: {sub_issue_id: <internal_id>})
DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue  (body: {sub_issue_id: <internal_id>})
```

GraphQL also available (requires `GraphQL-Features: sub_issues` header):
```graphql
query { node(id: "...") { ... on Issue { subIssues(first: 100) { nodes { number state title } } parent { number } } } }
```

**Important distinction:** The REST endpoint URL uses issue `number`, but the POST body requires the internal `id` field (not `node_id`, not `number`). The GET endpoint returns sub-issue objects with both `id` and `number`.

Limits: 100 sub-issues per parent, 8 levels of nesting.

### Integration Design

**Approach: Enrich TrackerIssue at fetch time, populate terminalIds at tick time.**

The existing `filterCandidates` logic is correct -- it just needs real data.

#### Step 1: Extend TrackerIssue type

```typescript
// src/tracker/types.ts
export interface TrackerIssue {
  // ... existing fields ...
  blocked_by: string[];        // Already exists -- now populated
  parent_id: string | null;    // NEW: parent issue number if this is a sub-issue
  sub_issue_ids: string[];     // NEW: child sub-issue numbers
}
```

#### Step 2: Fetch sub-issues in GitHub adapter

**Key design decision: batch sub-issue fetching, not per-issue.**

Fetching sub-issues for every candidate issue on every poll is expensive (1 API call per issue). Instead, fetch sub-issues only for issues that have them (GitHub includes a `sub_issues_summary` field in the GraphQL API that indicates child count).

Strategy:
1. Fetch candidate issues as normal (existing)
2. For each candidate, check if it has sub-issues (via body parsing or metadata)
3. Batch-fetch sub-issues for those that do (parallel Promise.all)
4. Build the `blocked_by` relationships

**Dependency semantics for sub-issues:**
- A **parent issue** should not be dispatched until all its sub-issues are in terminal states. So `parent.blocked_by = [sub1.id, sub2.id, ...]`
- A **sub-issue** is independent unless it has explicit dependencies. `sub.blocked_by = []` by default.
- This means: sub-issues get dispatched first, parent dispatches when all children complete. Natural bottom-up execution.

```typescript
// src/tracker/sub-issues.ts
export async function fetchSubIssues(
  githubFetch: FetchFn,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<SubIssueInfo[]> {
  const url = `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues`;
  const response = await githubFetch(url);
  return (await response.json()) as SubIssueInfo[];
}

export interface SubIssueInfo {
  id: number;      // Internal GitHub ID
  number: number;  // Issue number
  state: string;
  title: string;
}
```

#### Step 3: Populate terminalIssueIds in scheduler tick

This is the critical missing piece. The scheduler needs to know which issues are terminal to unblock dependents.

```typescript
// In scheduler tick(), replace the empty terminalIds:
// Option A: Fetch terminal issues from tracker
const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminal_states);
const terminalIds = new Set(terminalIssues.map(i => i.id));

// Option B: Cache terminalIds in OrchestratorState with TTL
// (preferred -- avoids re-fetching closed issues every tick)
if (!state.terminalIdsCache || state.terminalIdsCacheExpiry < Date.now()) {
  const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminal_states);
  state.terminalIdsCache = new Set(terminalIssues.map(i => i.id));
  state.terminalIdsCacheExpiry = Date.now() + config.orchestrator.poll_interval_ms;
}
const terminalIds = state.terminalIdsCache;
```

Option B is strongly preferred because:
- Fetching all closed issues every 30s is wasteful
- Terminal state rarely changes (closed issues stay closed)
- Cache TTL matching poll interval is good enough

#### Step 4: Handle webhook sub-issue events

`webhookPayloadToTrackerIssue()` currently hardcodes `blocked_by: []`. When a sub-issue is closed via webhook, we should update the terminal IDs cache.

### New Files

| File | Purpose |
|------|---------|
| `src/tracker/sub-issues.ts` | `fetchSubIssues()` REST API calls, `enrichWithSubIssues()` |

### Modified Files

| File | Change |
|------|--------|
| `src/tracker/types.ts` | Add `parent_id: string \| null`, `sub_issue_ids: string[]` to TrackerIssue |
| `src/tracker/github.ts` | Import and call sub-issues API in `fetchCandidateIssues()`, populate `blocked_by` |
| `src/tracker/notion.ts` | Add `parent_id: null, sub_issue_ids: []` for interface compat |
| `src/orchestrator/scheduler.ts` | Build `terminalIssueIds` from cached terminal issue fetch |
| `src/orchestrator/state.ts` | Add `terminalIdsCache: Set<string>` with TTL to OrchestratorState |
| `src/github/webhooks.ts` | Populate `parent_id`, `sub_issue_ids` from webhook payload (best-effort) |


## Feature 2: Skill/Config Bind-Mounting

### Current State

- Container bind mounts created in `prepareExecution()` (`src/orchestration/single.ts`, lines 72-84)
- Auth mounts use the `ContainerMounts` pattern (`src/auth/mount.ts`): `{ binds, env, cleanup }`
- `createContainer()` takes a `binds: string[]` array -- fully extensible
- Claude Code reads CLAUDE.md from working directory and `~/.claude/` for personal skills
- Claude Code skills follow the Agent Skills standard: `SKILL.md` with YAML frontmatter
- Skills from `--add-dir` directories are loaded when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
- No mechanism exists today to inject skills or CLAUDE.md files into containers

### What Needs to Be Available Inside the Container

| Host Source | Container Target | Why |
|------------|-----------------|-----|
| Project `.claude/skills/` | `/workspace/.claude/skills/` | Already there (workspace bind covers it) |
| Project `CLAUDE.md` | `/workspace/CLAUDE.md` | Already there (workspace bind covers it) |
| `~/.claude/skills/` | `/home/node/.claude/skills/` | Personal skills (NOT in workspace) |
| `~/.claude/CLAUDE.md` | `/home/node/.claude/CLAUDE.md` | Personal context (NOT in workspace) |
| External skill packs (e.g., GSD) | `/home/node/.claude/additional/{name}/` | Third-party skill collections |
| Custom CLAUDE.md files | Appended/layered | Workflow-specific agent instructions |

**Key insight:** Project-level skills and CLAUDE.md are already available via the workspace bind mount. The gap is personal/global skills and external skill packs that live outside the repo.

### Integration Design

**Approach: New `skills.ts` module that mirrors the `auth/mount.ts` ContainerMounts pattern.**

#### Config Schema Addition

```typescript
// src/config/schema.ts -- new section
skills: z.object({
  sources: z.array(z.string()).default([]),       // External skill directories to mount
  mount_personal: z.boolean().default(true),       // Mount ~/.claude/skills/
  claude_md: z.array(z.string()).default([]),       // Additional CLAUDE.md files
}).default({})
```

#### WORKFLOW.md Extension

```yaml
---
skills:
  sources:
    - ~/.claude/get-shit-done
    - ./team-skills
  mount_personal: true
  claude_md:
    - ~/.claude/CLAUDE.md
---
```

#### Skill Mount Module

```typescript
// src/container/skills.ts
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";

export interface SkillMountConfig {
  sources: string[];
  mountPersonal: boolean;
  claudeMd: string[];
}

export interface SkillMounts {
  binds: string[];
  env: Record<string, string>;
}

export function prepareSkillMounts(config: SkillMountConfig): SkillMounts {
  const binds: string[] = [];
  const env: Record<string, string> = {};

  // 1. Mount personal skills from ~/.claude/skills/
  if (config.mountPersonal) {
    const personalSkills = resolve(homedir(), ".claude/skills");
    if (existsSync(personalSkills)) {
      binds.push(`${personalSkills}:/home/node/.claude/skills:ro`);
    }
    // Also mount personal CLAUDE.md
    const personalClaudeMd = resolve(homedir(), ".claude/CLAUDE.md");
    if (existsSync(personalClaudeMd)) {
      binds.push(`${personalClaudeMd}:/home/node/.claude/CLAUDE.md:ro`);
    }
  }

  // 2. Mount external skill sources (GSD, team packs, etc.)
  for (const source of config.sources) {
    const expanded = source.replace(/^~/, homedir());
    const absPath = resolve(expanded);
    if (!existsSync(absPath)) continue;
    const name = basename(absPath);
    binds.push(`${absPath}:/home/node/.claude/additional/${name}:ro`);
  }

  // 3. Mount additional CLAUDE.md files
  //    These are separate from the personal one -- for workflow-specific context
  for (let i = 0; i < config.claudeMd.length; i++) {
    const source = config.claudeMd[i].replace(/^~/, homedir());
    const absPath = resolve(source);
    if (!existsSync(absPath)) continue;
    // Mount each with a unique name to avoid conflicts
    binds.push(`${absPath}:/home/node/.claude/additional/claude-md-${i}/CLAUDE.md:ro`);
  }

  // 4. Enable additional directory CLAUDE.md loading
  if (config.sources.length > 0 || config.claudeMd.length > 0) {
    env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
  }

  return { binds, env };
}
```

#### Integration Point: prepareExecution

In `prepareExecution()` (`src/orchestration/single.ts`), after auth mounts and before container creation:

```typescript
// After credential mounts...
if (plan.skills) {
  const skillMounts = prepareSkillMounts(plan.skills);
  binds.push(...skillMounts.binds);
  for (const [k, v] of Object.entries(skillMounts.env)) {
    agentEnv.push(`${k}=${v}`);
  }
}
```

Same integration needed in `buildOrchestratedRunPlan()` in `worker.ts` for orchestrated runs.

### New Files

| File | Purpose |
|------|---------|
| `src/container/skills.ts` | `prepareSkillMounts()` -- resolve paths, create bind mount specs |

### Modified Files

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add `SkillsConfigSchema` to ConfigSchema |
| `src/workflow/types.ts` | Add `skills?: SkillMountConfig` to RunPlan and WorkflowFileConfig |
| `src/orchestration/single.ts` | Call `prepareSkillMounts()` in `prepareExecution()` |
| `src/orchestrator/worker.ts` | Pass skills config through `buildOrchestratedRunPlan()` |


## Feature 3: Claude Code Agent Teams Inside Containers

### Current State

- Agent invocation: `invoke.ts` writes prompt to temp file, runs `sh -c "cat file | claude -p ..."` via `execInContainer`
- `claudeCodeAdapter.buildShellCommand()` builds the CLI command string
- Agent teams are experimental, require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var
- Teams need Claude Code v2.1.32+ and Opus 4.6+ model
- Teams work via: shared task list at `~/.claude/tasks/`, team config at `~/.claude/teams/`, mailbox messaging
- One lead session orchestrates multiple teammate sessions (separate Claude Code processes)
- Teammates load CLAUDE.md and skills from working directory automatically
- In-process mode works in any terminal (no tmux needed)
- Teams handle their own coordination: task assignment, claiming, dependencies, messaging

### Integration Design

**Approach: Agent teams are a prompt-level and env-level concern, not an architectural change.**

Critical insight: Claude Code handles ALL team coordination internally. forgectl just needs to:
1. Set the env var to enable teams
2. Ensure model is compatible (Opus 4.6+)
3. Craft the prompt to instruct team creation with appropriate structure
4. Scale container resources for multiple Claude instances
5. Increase timeout (teams take longer than single agents)

Agent teams are NOT a new orchestration mode. They operate within a single `invokeAgent` call. Claude Code itself spawns and manages sub-processes inside the container.

#### Config Schema Addition

```typescript
// In agent config within schema.ts
agent: z.object({
  // ... existing fields ...
  team: z.object({
    enabled: z.boolean().default(false),
    max_teammates: z.number().int().min(1).max(10).default(3),
    teammate_model: z.string().optional(),
  }).default({}),
})
```

#### WORKFLOW.md Extension

```yaml
---
agent:
  type: claude-code
  model: claude-opus-4-6
  team:
    enabled: true
    max_teammates: 4
    teammate_model: claude-sonnet-4-20250514
---
```

#### Team Module

```typescript
// src/agent/teams.ts
export interface TeamConfig {
  enabled: boolean;
  maxTeammates: number;
  teammateModel?: string;
}

export function buildTeamEnv(config: TeamConfig): string[] {
  if (!config.enabled) return [];
  return ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"];
}

export function buildTeamPromptPrefix(config: TeamConfig, taskPrompt: string): string {
  if (!config.enabled) return taskPrompt;

  const lines = [
    `Create an agent team with up to ${config.maxTeammates} teammates to work on this task.`,
    `Use in-process mode for teammates.`,
  ];

  if (config.teammateModel) {
    lines.push(`Use ${config.teammateModel} for each teammate.`);
  }

  lines.push(
    `Break the work into parallel tasks where possible.`,
    `Assign non-overlapping file ownership to avoid conflicts.`,
    `Wait for all teammates to finish before completing.`,
    ``,
    `Task:`,
    taskPrompt,
  );

  return lines.join("\n");
}

export function scaleResourcesForTeam(
  resources: { memory: string; cpus: number },
  maxTeammates: number,
): { memory: string; cpus: number } {
  // Each teammate is a full Claude Code process
  // Rough estimate: 1GB per teammate + 2GB base
  const baseMemoryMB = parseMemoryMB(resources.memory);
  const teamMemoryMB = Math.max(baseMemoryMB, 2048 + maxTeammates * 1024);
  const teamCpus = Math.min(resources.cpus * 2, 8);
  return {
    memory: `${Math.ceil(teamMemoryMB / 1024)}g`,
    cpus: teamCpus,
  };
}
```

#### Integration in Worker

```typescript
// In worker.ts executeWorker() or buildOrchestratedRunPlan():
const teamConfig = resolveTeamConfig(config, workflowFile);

if (teamConfig.enabled) {
  // 1. Scale container resources
  plan.container.resources = scaleResourcesForTeam(
    plan.container.resources,
    teamConfig.maxTeammates,
  );

  // 2. Add team env vars
  agentEnv.push(...buildTeamEnv(teamConfig));

  // 3. Increase timeout (teams take 2-5x longer)
  plan.agent.timeout = Math.max(plan.agent.timeout, plan.agent.timeout * 3);

  // 4. Wrap prompt with team instructions
  fullPrompt = buildTeamPromptPrefix(teamConfig, fullPrompt);
}
```

### Constraints and Limitations

- **In-process mode only**: tmux is unavailable inside containers. Force in-process mode via prompt.
- **No session resumption**: If the container dies, team state is lost. Aligns with forgectl's one-shot model.
- **Token cost**: Teams use 3-5x more tokens. Gate by workflow config, never automatic.
- **Shared filesystem**: Teammates share `/workspace`. Prompt must instruct non-overlapping file ownership.
- **No nested teams**: Teammates cannot spawn their own teams. Only the lead manages the team.
- **Cleanup**: The lead must clean up team resources before the container exits. Include cleanup instruction in prompt.

### New Files

| File | Purpose |
|------|---------|
| `src/agent/teams.ts` | Team config types, env builder, prompt prefix builder, resource scaler |

### Modified Files

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add team config to agent schema |
| `src/workflow/types.ts` | Add team config to RunPlan and WorkflowFileConfig |
| `src/orchestrator/worker.ts` | Apply team env, scale resources, wrap prompt, increase timeout |
| `src/orchestration/single.ts` | Pass team env vars in prepareExecution |


## Patterns to Follow

### Pattern 1: ContainerMounts for extensible bind mounting

**What:** All container customization (auth, skills, team state) uses the same `{ binds, env, cleanup }` shape from `auth/mount.ts`.

**When:** Any time new host-side resources need to be available in the container.

**Example:**
```typescript
// Every mount producer returns the same shape
export interface ContainerMounts {
  binds: string[];
  env: Record<string, string>;
  cleanup: () => void;
}

// Collected in prepareExecution and merged
const allBinds = [...workspaceBinds, ...authMounts.binds, ...skillMounts.binds];
const allEnv = [...authEnv, ...skillEnv, ...teamEnv];
```

### Pattern 2: Enrichment at fetch time, filtering at dispatch time

**What:** The tracker adapter enriches TrackerIssue with dependency info. The dispatcher filters based on that enrichment. No coupling between fetch and filter logic.

**When:** Adding new blocking/dependency relationships.

**Example:**
```typescript
// Tracker: enrich
const issue = normalizeIssue(ghIssue);
issue.blocked_by = subIssueNumbers;  // populated from API

// Dispatcher: filter (existing code, unchanged)
const eligible = filterCandidates(candidates, state, terminalIssueIds);
```

### Pattern 3: Prompt-level orchestration for agent capabilities

**What:** Rather than building complex multi-process orchestrators, delegate coordination to Claude Code itself. forgectl's role is environment setup and resource provisioning.

**When:** The agent runtime already has the capability you need (e.g., agent teams, subagents).

**Example:**
```typescript
// Don't build a team coordinator -- let Claude Code do it
const prompt = teamConfig.enabled
  ? buildTeamPromptPrefix(teamConfig, taskPrompt)
  : taskPrompt;
// Set env var, pass prompt, Claude Code handles the rest
```

### Pattern 4: Read-only mounts for injected content

**What:** All injected content (skills, CLAUDE.md, external configs) mounted as `:ro`.

**When:** Mounting content the agent should use but not modify.

**Why:** Prevents agent from modifying skills/configs during execution, affecting future runs.


## Anti-Patterns to Avoid

### Anti-Pattern 1: Merging pipeline DAG with orchestrator scheduling

**What:** Trying to reuse `src/pipeline/dag.ts` for sub-issue dependency scheduling.

**Why bad:** Pipeline DAG is for pre-defined, static pipelines with known nodes. Sub-issue dependencies are dynamic, discovered at poll time, and change as issues are created/closed. Different data models, different lifecycle.

**Instead:** Keep the orchestrator's existing `filterCandidates` + `terminalIssueIds` pattern. It's polling-friendly and handles dynamic DAGs naturally.

### Anti-Pattern 2: Eagerly fetching all sub-issues every tick

**What:** Fetching sub-issues for every issue on every poll tick.

**Why bad:** GitHub rate limits (5000 req/hr for authenticated requests). With 50 open issues, that's 50 extra API calls per tick. At 30s poll interval, that's 6000 calls/hr -- over the limit.

**Instead:** Cache sub-issue relationships with TTL matching poll interval. Only re-fetch when the candidate list changes or on cache expiry. Consider using GraphQL for batched sub-issue queries (one call for all issues).

### Anti-Pattern 3: Building a custom team coordinator

**What:** Creating a forgectl-managed multi-container agent team system with message routing.

**Why bad:** Claude Code's agent teams already handle task lists, mailboxes, inter-agent messaging, and coordination. Reimplementing this in forgectl would be massive effort with worse results.

**Instead:** Use Claude Code's built-in agent teams feature. forgectl enables it via env vars and crafts the prompt. The complexity lives in Claude Code, not forgectl.

### Anti-Pattern 4: Mounting skills read-write

**What:** Mounting skill directories without `:ro` flag.

**Why bad:** Agent could modify or delete skills during execution, affecting future runs.

**Instead:** Always mount skills as read-only. If the agent needs writable skill state, use a copy-on-write approach (copy to workspace first).

### Anti-Pattern 5: Team mode without resource scaling

**What:** Enabling agent teams without increasing container memory/CPU.

**Why bad:** Each teammate is a separate Claude Code process. 3 teammates in a 4GB container will OOM.

**Instead:** Auto-scale container resources when team mode is enabled. ~1GB per teammate + 2GB base.


## Scalability Considerations

| Concern | Current (3 agents) | With sub-issues (10 agents) | With teams (30 sub-agents) |
|---------|--------------------|-----------------------------|----------------------------|
| API calls/tick | ~3 (fetch candidates) | ~13 (candidates + sub-issues) | ~13 (same, teams are internal) |
| Memory per container | 4GB | 4GB | 8-16GB (teams need more) |
| CPU per container | 2 cores | 2 cores | 4-8 cores (teams need more) |
| Token cost per agent | 1x | 1x | 3-5x (teams multiply cost) |
| Filesystem contention | Low (1 agent/workspace) | Low (1 agent/workspace) | Medium (teammates share workspace) |
| Rate limit pressure | Low | Medium (sub-issue fetches) | Medium (same as sub-issues) |


## Suggested Build Order

Based on dependency analysis and integration risk:

### Phase 1: Sub-Issues DAG (foundation, highest standalone value)
**Rationale:** Unblocks dependency-aware orchestration immediately. The existing `blocked_by` + `filterCandidates` infrastructure just needs real data. Low risk -- extends existing patterns.

Build sequence:
1. Extend TrackerIssue type with `parent_id` and `sub_issue_ids`
2. Build `sub-issues.ts` REST API client
3. Integrate into `github.ts` candidate fetching with caching
4. Populate `terminalIssueIds` in scheduler tick
5. Update webhook handler for sub-issue events
6. Test with real GitHub sub-issues

### Phase 2: Skill/Config Mounting (independent, enables Phase 3)
**Rationale:** Independent of Phase 1. Improves agent quality immediately and is prerequisite for effective team usage (teams inherit skills).

Build sequence:
1. Define SkillsConfigSchema in config
2. Build `skills.ts` mount module (ContainerMounts pattern)
3. Wire into `prepareExecution()`
4. Add WORKFLOW.md skills section support
5. Add to `buildOrchestratedRunPlan()` for orchestrated runs
6. Test with personal skills and GSD skill packs

### Phase 3: Agent Teams (depends on Phase 2, highest complexity)
**Rationale:** Depends on Phase 2 (skills should be mountable before teams use them). Highest token cost and resource requirements. Most novel feature -- needs careful testing.

Build sequence:
1. Define team config schema
2. Build `teams.ts` (env builder, prompt prefix, resource scaler)
3. Wire into worker (env, resources, prompt wrapping, timeout)
4. Add container resource auto-scaling
5. Test with simple team tasks (research, review)
6. Test with complex team tasks (cross-layer implementation)

**Phase ordering rationale:**
- Phase 1 is independent and highest standalone value (enables automatic dependency scheduling)
- Phase 2 is independent but improves Phase 3 effectiveness (teams benefit from mounted skills)
- Phase 3 builds on Phase 2 conceptually and is highest-risk (token cost, resource scaling, experimental API)


## Sources

- [GitHub Sub-Issues REST API Docs](https://docs.github.com/en/rest/issues/sub-issues) -- HIGH confidence (official docs)
- [Introducing Sub-Issues Blog Post](https://github.blog/engineering/architecture-optimization/introducing-sub-issues-enhancing-issue-management-on-github/) -- HIGH confidence
- [Sub-Issues REST API Changelog](https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/) -- HIGH confidence
- [Create GitHub Issue Hierarchy Using the API](https://jessehouwing.net/create-github-issue-hierarchy-using-the-api/) -- MEDIUM confidence
- [Claude Code Agent Teams Official Docs](https://code.claude.com/docs/en/agent-teams) -- HIGH confidence (official docs)
- [Claude Code Skills Official Docs](https://code.claude.com/docs/en/skills) -- HIGH confidence (official docs)
- [Sub-Issues Public Preview Discussion](https://github.com/orgs/community/discussions/148714) -- MEDIUM confidence
- [Evolving GitHub Issues and Projects GA](https://github.com/orgs/community/discussions/154148) -- MEDIUM confidence
