# GitHub Issues Integration — How It Works

This documents the full end-to-end flow of forgectl's GitHub Issues integration: how issues become PRs autonomously.

## Quick Start

```bash
# 1. Configure (.forgectl/config.yaml)
tracker:
  kind: github
  token: ghp_YOUR_TOKEN        # or set GITHUB_TOKEN env var
  repo: owner/repo
  labels: [forgectl]            # only dispatch issues with this label
  in_progress_label: in-progress
  done_label: done

orchestrator:
  enabled: true
  max_concurrent_agents: 1
  poll_interval_ms: 30000       # poll every 30s

# 2. Build and start
npm run build
node dist/index.js orchestrate --foreground

# 3. Create a GitHub issue with the "forgectl" label
# → forgectl picks it up, runs an agent, pushes a branch, creates a PR
```

## Architecture Overview

```
GitHub Issues API
    │
    │ poll every 30s (ETag-cached)
    ▼
┌──────────────┐
│  Scheduler   │─── tick() every poll_interval_ms
│  (scheduler) │    1. reconcile running workers
│              │    2. fetch candidate issues
│              │    3. filter (claimed, running, done)
│              │    4. sort by priority
│              │    5. dispatch to available slots
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Dispatcher  │─── dispatchIssue()
│ (dispatcher) │    1. claim issue (dedup)
│              │    2. add in-progress label
│              │    3. fire async worker
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Worker     │─── executeWorker()
│  (worker)    │    1. ensure workspace + clone hook
│              │    2. build RunPlan + prompt
│              │    3. create container (Docker)
│              │    4. invoke Claude Code agent
│              │    5. run validation (typecheck, tests)
│              │    6. collect git output → branch
│              │    7. push branch + create PR
│              │    8. post result comment
└──────────────┘
```

## File Map

| File | Purpose |
|------|---------|
| `src/daemon/server.ts` | Daemon startup, orchestrator init, WORKFLOW.md loading |
| `src/orchestrator/index.ts` | Orchestrator class (start/stop/tick lifecycle) |
| `src/orchestrator/scheduler.ts` | Polling loop, tick dispatch logic |
| `src/orchestrator/dispatcher.ts` | Issue claiming, worker launch, post-execution handling |
| `src/orchestrator/worker.ts` | Full worker lifecycle (container → agent → validate → git → PR) |
| `src/orchestrator/reconciler.ts` | Reconcile running workers, stall detection, cleanup timeouts |
| `src/orchestrator/state.ts` | OrchestratorState, WorkerInfo, SlotManager, claim/release |
| `src/orchestrator/retry.ts` | Exponential backoff, retry scheduling |
| `src/tracker/github.ts` | GitHub API adapter (fetch issues, labels, comments, PRs) |
| `src/tracker/types.ts` | TrackerAdapter interface, TrackerIssue type |
| `src/github/comments.ts` | Progress comments (updated in-place), result comments |
| `src/github/checks.ts` | GitHub Check Run creation/update/completion |
| `src/github/pr-description.ts` | PR creation and description generation |
| `src/github/webhooks.ts` | Webhook handlers (issue labeled, comment slash commands) |
| `src/github/commands.ts` | Slash command parsing (`/forgectl run`, `/forgectl stop`, etc.) |
| `src/github/command-handler.ts` | Command routing (run, stop, status, approve, reject, help) |
| `src/github/app.ts` | GitHub App service (@octokit/app JWT auth) |
| `src/github/types.ts` | Shared types (RepoContext, IssueContext, ParsedCommand) |
| `src/agent/claude-code.ts` | Claude Code CLI command builder |
| `src/agent/invoke.ts` | Agent invocation inside container (prompt file → exec) |
| `src/context/prompt.ts` | Prompt builder (system + context + task + validation info) |
| `src/workflow/workflow-file.ts` | WORKFLOW.md parser, DEFAULT_PROMPT_TEMPLATE |
| `src/workflow/template.ts` | Template renderer ({{issue.title}}, {{issue.description}}) |
| `src/output/git.ts` | Git output collection (branch creation, push) |
| `src/container/runner.ts` | Docker container creation, exec, cleanup |
| `src/config/schema.ts` | Zod config schema (all defaults) |
| `.forgectl/config.yaml` | Live project config |

## The Full Lifecycle (Step by Step)

### Phase 1: Polling & Dispatch

**Scheduler** (`scheduler.ts`) runs `tick()` every `poll_interval_ms`:

1. **Reconcile** — check running workers against GitHub issue states. If an issue was closed externally, clean up the worker. Detect stalled workers (no activity for `stall_timeout_ms`, default 10 min).

2. **Fetch candidates** — call `tracker.fetchCandidateIssues()`:
   - Queries `GET /repos/{owner}/{repo}/issues?state=open&labels=forgectl&per_page=100&sort=updated`
   - Uses ETag caching — returns cached result on HTTP 304
   - Filters out PRs (GitHub returns PRs in issues endpoint)
   - Extracts priority from labels: `P0`→0, `P1`→1, `priority:critical`→0, etc.
   - Returns `TrackerIssue[]` with id, title, description, labels, priority, url

3. **Filter** — exclude issues that are:
   - Already claimed by this orchestrator
   - Already running (in `state.running` map)
   - Labeled with `done_label` (default: "done")

4. **Sort** — by priority (ascending), then age (oldest first), then identifier

5. **Dispatch** — for each issue up to `availableSlots`:
   - `claimIssue()` — add to claimed set (prevents double-dispatch)
   - `updateLabels([in_progress_label], [])` — best-effort, non-blocking
   - Fire `executeWorkerAndHandle()` asynchronously

### Phase 2: Worker Execution

**Dispatcher** (`dispatcher.ts`) runs `executeWorkerAndHandle()`:

1. Add `WorkerInfo` to `state.running` map with `onActivity` callback for stall detection
2. Post **progress comment** on the issue (updated in-place throughout):
   ```
   🔄 forgectl run started
   ├── ⏳ Agent executing...
   ├── ○ Validating
   └── ○ Collecting output
   ```
3. Insert run record into SQLite (if runRepo available)
4. Call `executeWorker()` (the core work)

**Worker** (`worker.ts`) does the actual work:

1. **Workspace** — `workspaceManager.ensureWorkspace(identifier)` creates a directory under `~/.forgectl/workspaces/`. Runs the `after_create` hook (e.g., `git clone https://... .`)

2. **RunPlan** — builds the execution plan:
   - Renders the prompt template with issue data (`{{issue.title}}`, `{{issue.description}}`, `{{attempt}}`)
   - Sets agent config (type, model, max_turns, timeout, flags)
   - Sets container config (image, network, resources)
   - Sets validation steps from config
   - Sets output mode to "git"

3. **Container** — `prepareExecution()` from `src/orchestration/single.ts`:
   - Pulls/builds Docker image (e.g., `forgectl-code-node20`)
   - Creates workspace bind mount
   - Mounts Claude credentials (`~/.claude` + `~/.claude.json`)
   - Creates container with `User: "node"` (non-root, required for `--dangerously-skip-permissions`)
   - Starts container with `sleep infinity`

4. **Agent invocation** — builds full prompt via `buildPrompt(plan)`:
   ```
   You are an autonomous coding agent working inside a Docker container.
   Your task is to implement the changes described in the GitHub issue below.

   ## Issue: {title}
   {description}

   ## Instructions
   1. Read the relevant source files...
   2. Implement the requested changes...
   ...

   After you finish, these validation checks will run:
   - typecheck: `npm run typecheck`
   - test: `FORGECTL_SKIP_DOCKER=true npm test`
   ```
   Then executes in container:
   ```
   cat /tmp/forgectl/prompt.txt | claude -p - --output-format text --dangerously-skip-permissions --max-turns 50
   ```

5. **Validation** — `runValidationLoop()`:
   - Runs each validation step command in the container
   - If any fail: formats error output, re-invokes agent with feedback
   - Retries up to `step.retries` times per step
   - Agent fixes issues and validation re-runs all steps from the top

6. **Git output** — `collectGitOutput()`:
   - Compares pre-agent HEAD SHA to current HEAD
   - Creates branch: `forge/{slug}/{timestamp}`
   - Commits any uncommitted changes
   - Extracts `.git` archive from container
   - Fetches branch into host repo
   - Pushes to remote (using tracker token for auth)

7. **PR creation** — `createPRForBranch()`:
   - Creates PR via GitHub API: `POST /repos/{owner}/{repo}/pulls`
   - Title: `[forgectl] {issue title}`
   - Body includes: issue link (Closes #N), changes summary, validation results, cost
   - Contains `<!-- forgectl-generated -->` marker for safe re-writes

8. **Result comment** — posts on the issue:
   ```
   ✅ Run completed | Duration: 36s | Cost: $0.0234

   **Validation:** ✔ typecheck ✔ test

   Branch: `forge/add-version-endpoint/20260313`
   PR: #11
   ```

### Phase 3: Post-Execution

Back in `executeWorkerAndHandle()`:

- **Success**: add `done_label`, remove `in_progress_label`, schedule re-dispatch (1s delay for continuation)
- **Failure**: increment retry counter. If retries exhausted (default 5): post failure comment, release. Otherwise: schedule retry with exponential backoff (10s, 20s, 40s, ... capped at 5 min)

## Config Reference

### Tracker Config
```yaml
tracker:
  kind: github                    # required: "github" or "notion"
  token: ghp_...                  # required: GitHub PAT (or set GITHUB_TOKEN env)
  repo: owner/repo               # required: target repository
  labels: [forgectl]              # optional: only dispatch issues with these labels
  in_progress_label: in-progress  # optional: added when worker starts
  done_label: done                # optional: added on success, skipped on dispatch
  auto_close: false               # optional: close issue on success (default: false)
  active_states: [open]           # optional: states to query (default: ["open"])
  terminal_states: [closed]       # optional: states that trigger cleanup (default: ["closed"])
  poll_interval_ms: 30000         # optional: how often to poll (default: 60000)
```

### Orchestrator Config
```yaml
orchestrator:
  enabled: true                   # required: enable orchestration
  max_concurrent_agents: 1        # how many issues to work on simultaneously
  poll_interval_ms: 30000         # scheduler tick interval
  stall_timeout_ms: 600000        # 10 min: kill workers with no activity
  max_retries: 5                  # retry budget per issue
  max_retry_backoff_ms: 300000    # 5 min: exponential backoff cap
  drain_timeout_ms: 30000         # graceful shutdown timeout
```

### Agent Config
```yaml
agent:
  type: claude-code               # "claude-code" | "codex" | "browser-use"
  timeout: 30m                    # max agent runtime
  max_turns: 50                   # max Claude Code turns
  model: ""                       # model override (empty = default)
  flags: []                       # extra CLI flags
```

### Container Config
```yaml
container:
  image: forgectl-code-node20     # Docker image (must have claude CLI installed)
  resources:
    memory: 4g
    cpus: 2
  network:
    mode: open                    # "open" | "allowlist" | "airgapped"
```

### Validation Config
```yaml
validation:
  on_failure: abandon             # "abandon" | "output-wip" | "pause"
  steps:
    - name: typecheck
      command: npm run typecheck
      retries: 2
    - name: test
      command: FORGECTL_SKIP_DOCKER=true npm test
      retries: 2
```

### Workspace Config
```yaml
workspace:
  root: ~/.forgectl/workspaces
  hooks:
    after_create: git clone https://github.com/owner/repo.git .
```

## Template Variables

The prompt template supports these variables:

| Variable | Value | Example |
|----------|-------|---------|
| `{{issue.title}}` | Issue title | "Add /version endpoint" |
| `{{issue.description}}` | Issue body (markdown) | Full issue body text |
| `{{issue.id}}` | Issue number (string) | "10" |
| `{{issue.identifier}}` | Formatted identifier | "#10" |
| `{{issue.state}}` | Issue state | "open" |
| `{{issue.priority}}` | Extracted priority | "P1" or null |
| `{{issue.labels}}` | Labels array (JSON) | `["forgectl","bug"]` |
| `{{issue.url}}` | Issue URL | "https://github.com/..." |
| `{{attempt}}` | Current attempt number | 1, 2, 3... |

Custom templates go in `WORKFLOW.md` (body section below the YAML front matter).

## GitHub API Interactions

### Reads (polling)
- `GET /repos/{owner}/{repo}/issues` — fetch candidates (ETag-cached)
- `GET /repos/{owner}/{repo}/issues/{number}` — fetch state for reconciliation

### Writes (per issue lifecycle)
- `POST /repos/{owner}/{repo}/issues/{number}/labels` — add in-progress label
- `DELETE /repos/{owner}/{repo}/issues/{number}/labels/{label}` — remove label
- `POST /repos/{owner}/{repo}/issues/{number}/comments` — progress comment (created once)
- `PATCH /repos/{owner}/{repo}/issues/comments/{commentId}` — update progress in-place
- `POST /repos/{owner}/{repo}/pulls` — create PR
- `PATCH /repos/{owner}/{repo}/pulls/{number}` — update PR description
- `POST /repos/{owner}/{repo}/check-runs` — create check run (if headSha available)
- `PATCH /repos/{owner}/{repo}/check-runs/{id}` — update/complete check run
- `git push` — push branch to remote

### Resilience
- **Retries:** 3 attempts with [1s, 3s, 5s] backoff for network errors and 5xx
- **Rate limiting:** Tracks `x-ratelimit-remaining`, throws at 0
- **Best-effort writes:** Label/comment/check-run failures are caught and logged, never crash the worker

## State Machine

```
Issue Created (with label)
    │
    ▼
  claimed ──────────────────► released (if dispatch fails)
    │
    ▼
  running ──────────────────► retry_queued (on error, if retries left)
    │                              │
    │                              ▼
    │                          released (after backoff, re-enters claimed)
    │
    ├── agent completes ──────► continued (success) ──► released
    │                                                     └── done_label added
    ├── stall detected ───────► retry_queued or released
    │
    └── max retries ──────────► released (failure comment posted)
```

### Worker Info (in-memory)
```typescript
{
  issueId: string;          // GitHub issue number
  identifier: string;       // "#10"
  issue: TrackerIssue;      // Full issue data
  session: AgentSession | null;  // Container agent session (null before exec starts)
  cleanup: CleanupContext;  // Container + temp dir cleanup handles
  startedAt: number;        // Epoch ms
  lastActivityAt: number;   // Updated by agent activity callback
  attempt: number;          // 1-based retry counter
}
```

## Slash Commands (GitHub App / Webhook Mode)

When running as a GitHub App with webhooks enabled:

| Command | Action |
|---------|--------|
| `/forgectl run` | Dispatch this issue for execution |
| `/forgectl run code` | Dispatch with specific workflow |
| `/forgectl rerun` | Re-run last run for this issue |
| `/forgectl stop` | Cancel active run |
| `/forgectl status` | Show current run status |
| `/forgectl approve` | Approve pending run (governance) |
| `/forgectl reject` | Reject pending run (governance) |
| `/forgectl help` | Show command reference |

**Note:** Slash commands require the GitHub App webhook integration (`src/github/webhooks.ts`). The basic daemon polling mode (without GitHub App) does not support slash commands — it only polls and auto-dispatches labeled issues.

## Known Limitations

1. **headSha not populated in polling mode** — Check runs are only created when headSha is available (typically from PR webhook events). In polling mode, check runs are skipped.

2. **Single-repo only** — The tracker config points to one `owner/repo`. Multi-repo requires multiple daemon instances.

3. **No incremental workspace** — Each dispatch clones fresh (via after_create hook). For large repos, this is slow. Reuse is possible by removing the hook and pre-populating the workspace.

4. **Prompt quality depends on issue quality** — The agent gets the issue title + body as its task. Vague issues produce vague results. Write detailed issues with file paths, expected behavior, and constraints.

5. **Validation restarts all steps** — After agent fixes, ALL validation steps re-run from the top (not just the failing ones). This is by design but can be slow with many steps.

6. **Branch naming** — Branches are `forge/{slug}/{timestamp}`. The slug is truncated to 60 chars from the task text. Multiple runs create separate branches.

7. **OAuth session mount is read-only** — `~/.claude` is mounted `:ro`. Claude Code can read credentials but can't update history or settings inside the container. `.claude.json` is copied writable.

8. **Container runs as `node` user (uid 1000)** — The host user must also be uid 1000 for workspace bind-mount permissions to work. This matches most default Linux setups.

## Building On Top of This

### To add a new GitHub interaction:
1. Add the API call to `src/tracker/github.ts` (inside the adapter closure)
2. Expose it via the `TrackerAdapter` interface in `src/tracker/types.ts`
3. Call it from `src/orchestrator/dispatcher.ts` or `src/orchestrator/worker.ts`

### To customize the agent prompt:
1. Create a `WORKFLOW.md` file in the project root
2. The body (below the YAML front matter) becomes the prompt template
3. Use `{{issue.title}}`, `{{issue.description}}`, etc.
4. Or edit `DEFAULT_PROMPT_TEMPLATE` in `src/workflow/workflow-file.ts`

### To add new validation steps:
Add to `.forgectl/config.yaml`:
```yaml
validation:
  steps:
    - name: lint
      command: npm run lint
      retries: 1
    - name: typecheck
      command: npm run typecheck
      retries: 2
```

### To change post-execution behavior:
Edit `executeWorkerAndHandle()` in `src/orchestrator/dispatcher.ts` — this is where success/failure handling, label management, and PR creation happen.

### To add new slash commands:
1. Add the command type to `CommandType` in `src/github/types.ts`
2. Add parsing in `src/github/commands.ts`
3. Add handling in `src/github/command-handler.ts`

### To test changes:
```bash
FORGECTL_SKIP_DOCKER=true npm test   # Unit + integration tests (no Docker)
npm run typecheck                     # TypeScript compilation check
npm run build                         # Full build

# E2E test:
npm run build
rm -rf ~/.forgectl/workspaces ~/.forgectl/forgectl.db
node dist/index.js orchestrate --foreground
# Create an issue with the "forgectl" label and watch the logs
```
