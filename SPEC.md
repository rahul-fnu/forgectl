# SPEC.md — forgectl System Specification

This document specifies the forgectl system architecture, focusing on the Linear tracker integration, worker/agent execution layer, durable task state, cost tracking, and execution traces. It is intended as a reference for AI agents and developers.

## Overview

forgectl's tracker system provides a normalized interface (`TrackerAdapter`) that abstracts issue trackers. The Linear adapter implements this interface using the `@linear/sdk` GraphQL client, supporting multi-team issue fetching, parent/child sub-issue DAGs, blocking relations, webhook-driven cache invalidation, and workflow state management.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    forgectl daemon                       │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐   ┌────────────┐  │
│  │  Scheduler   │───>│  Dispatcher  │──>│  Workers   │  │
│  │  (poll tick) │    │  (claim+run) │   │(agent exec)│  │
│  └──────┬──────┘    └──────────────┘   └────────────┘  │
│         │                                               │
│  ┌──────┴──────┐    ┌──────────────┐                    │
│  │   Linear    │    │   Webhook    │                    │
│  │   Adapter   │<───│   Endpoint   │<── Linear POST    │
│  │             │    │ /api/v1/     │                    │
│  │  ┌────────┐ │    │ linear/      │                    │
│  │  │SubIssue│ │    │ webhook      │                    │
│  │  │ Cache  │ │    └──────────────┘                    │
│  │  └────────┘ │                                        │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/tracker/types.ts` | `TrackerAdapter` interface, `TrackerConfig` type, `TrackerIssue` normalized model |
| `src/tracker/linear.ts` | Linear adapter implementation, webhook handler, signature verification |
| `src/tracker/registry.ts` | Factory registry — maps `kind` string to adapter constructor |
| `src/tracker/sub-issue-cache.ts` | TTL cache for parent→children mappings (shared across adapters) |
| `src/tracker/sub-issue-dag.ts` | Cycle detection (3-color DFS) for sub-issue dependency graphs |
| `src/tracker/token.ts` | Token resolution (`$linear`, `$gh`, `$ENV_VAR`, literal) |
| `src/config/schema.ts` | Zod schema — `TrackerConfigSchema` with Linear-specific fields |
| `src/daemon/server.ts` | Daemon startup — wires Linear adapter + webhook route |
| `src/cli/repo.ts` | `forgectl repo add --linear` command handler |
| `test/unit/tracker-linear.test.ts` | Unit tests (30 tests) |

## TrackerAdapter Interface

Every tracker adapter must implement:

```typescript
interface TrackerAdapter {
  readonly kind: string;
  fetchCandidateIssues(): Promise<TrackerIssue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;
  fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]>;
  postComment(issueId: string, body: string): Promise<void>;
  updateState(issueId: string, state: string): Promise<void>;
  updateLabels(issueId: string, add: string[], remove: string[]): Promise<void>;
  createPullRequest?(branch: string, title: string, body: string): Promise<string | undefined>;
  createAndMergePullRequest?(branch: string, title: string, body: string): Promise<{ merged: boolean; prUrl?: string; error?: string }>;
}
```

The Linear adapter does **not** implement `createPullRequest` or `createAndMergePullRequest` (Linear is an issue tracker, not a code host).

## TrackerIssue Model

The normalized issue model used throughout the orchestrator:

```typescript
interface TrackerIssue {
  id: string;          // Linear issue UUID (API-addressable)
  identifier: string;  // Human-readable: "ENG-123"
  title: string;
  description: string;
  state: string;       // Workflow state name: "In Progress", "Done", etc.
  priority: string | null;  // "1" (Urgent) through "4" (Low), null = No priority
  labels: string[];
  assignees: string[];
  url: string;
  created_at: string;  // ISO 8601
  updated_at: string;  // ISO 8601
  blocked_by: string[];  // IDs of blocking issues (children + blocking relations)
  metadata: Record<string, unknown>;  // Linear-specific: linearId, teamId, teamKey, stateId, stateType, priorityLabel, parentId, projectId
}
```

### ID Conventions

- `id`: Linear issue UUID — passed to all mutation methods (`postComment`, `updateState`, `updateLabels`)
- `identifier`: Human-readable team-prefixed identifier (e.g., `ENG-123`) — used in logs, comments, UI
- `blocked_by`: Array of issue UUIDs — combines both sub-issue children and blocking relations

## Linear Config Schema

```typescript
// In TrackerConfigSchema (zod)
{
  kind: "linear",
  token: string,                        // Required. "$linear", "$LINEAR_API_KEY", or literal
  team_ids: string[],                   // Required. At least one Linear team UUID
  project_id?: string,                  // Optional. Filter to a specific Linear project
  webhook_secret?: string,              // Optional. HMAC-SHA256 signing secret for webhooks
  labels?: string[],                    // Optional. Filter issues by label name
  active_states: string[],             // Default: ["open"]. State names or types to poll
  terminal_states: string[],           // Default: ["closed"]. States considered "done"
  poll_interval_ms: number,            // Default: 60000. Polling interval in ms
  auto_close: boolean,                 // Default: false. Auto-close issues when agent completes
  in_progress_label?: string,          // Label to add when agent starts working
  done_label?: string,                 // Label to add when agent completes
}
```

### Validation Rules

- `kind: "linear"` requires `team_ids` with at least one entry
- `kind: "github"` requires `repo` in `owner/repo` format
- `kind: "notion"` requires `database_id`

## Linear Adapter Implementation Details

### State & Label Mapping

Linear uses UUIDs for workflow states and labels. The adapter maintains two lazy-initialized caches:

- **StateMapping**: `name → id` and `id → name` for all workflow states across configured teams
- **LabelMapping**: `name → id` and `id → name` for all labels across configured teams

Mappings are populated on first API call (`initMappings()`) and persist for the adapter lifetime. State names are matched case-insensitively. UUID strings (containing `-`) are passed through as-is.

State types (`backlog`, `unstarted`, `started`, `completed`, `canceled`) are also indexed, so `active_states: ["started"]` matches any state with type "started".

### Issue Fetching Flow

```
fetchCandidateIssues()
  ├── initMappings()              # lazy, one-time
  ├── fetchFilteredIssues()       # for each team:
  │   ├── resolve state names → IDs
  │   ├── build GraphQL filter (team + state + labels + project)
  │   ├── paginate (50/page)
  │   └── resolveIssueData()      # await state, team, assignee in parallel
  ├── for each issue:
  │   ├── check SubIssueCache     # TTL 5min
  │   ├── fetchChildren()         # if cache miss
  │   ├── fetchBlockingRelations()
  │   └── normalizeLinearIssue()
  ├── auto-discover children      # fetch children not in candidate set
  └── detectIssueCycles()         # 3-color DFS
```

### SDK Usage Patterns

The Linear SDK (`@linear/sdk`) returns proxy objects with lazy-loading getters. Key patterns:

```typescript
// Direct properties (sync)
issue.id              // string
issue.identifier      // string (e.g., "ENG-123")
issue.title           // string
issue.priority        // number (0-4)
issue.url             // string
issue.createdAt       // Date
issue.labelIds        // string[]
issue.parentId        // string | undefined (getter)

// Lazy-loading getters (need await)
const state = await issue.state;       // WorkflowState | undefined
const team = await issue.team;         // Team | undefined
const assignee = await issue.assignee; // User | undefined

// Async connection methods
const children = await issue.children();           // IssueConnection
const relations = await issue.relations();         // IssueRelationConnection
const inverseRelations = await issue.inverseRelations(); // IssueRelationConnection
const labels = await issue.labels();               // IssueLabelConnection

// Mutations
await client.createComment({ issueId, body });
await client.updateIssue(issueId, { stateId });
await client.updateIssue(issueId, { labelIds: [...ids] });
```

### Blocking Relations

Linear has two relation directions:

- **Forward** (`issue.relations()`): This issue's outgoing relations. `type === "blocks"` means the `relatedIssue` blocks this issue.
- **Inverse** (`issue.inverseRelations()`): Other issues pointing at this one. `type === "blocks"` means the `issue` blocks this issue.

The adapter uses `relatedIssueId` and `issueId` direct properties to avoid extra API calls when resolving blocker IDs.

### SubIssueCache

Shared TTL cache (default 5 minutes) for parent→children mappings:

```typescript
interface SubIssueEntry {
  parentId: string;                    // Parent issue UUID
  childIds: string[];                  // Child issue UUIDs
  childStates: Map<string, string>;   // childId → state name
  fetchedAt: number;                  // Date.now() at fetch time
}
```

The cache is shared between the adapter and the webhook handler. Webhook events invalidate relevant entries to force fresh fetches on the next tick.

## Webhook Protocol

### Endpoint

`POST /api/v1/linear/webhook`

### Security

- **Signature header**: `linear-signature` containing HMAC-SHA256 hex digest
- **Verification**: `HMAC-SHA256(raw_request_body, webhook_secret)`
- **Comparison**: Timing-safe (`crypto.timingSafeEqual`)
- **Must use raw body** (not re-serialized JSON)

### Handled Events

| Event | Action | Effect |
|-------|--------|--------|
| Issue create | Any issue created | Invalidate parent cache if child; trigger tick |
| Issue remove | Any issue deleted | Invalidate parent cache if child; trigger tick |
| Issue update (stateId) | State change | Invalidate parent caches containing this child; trigger tick |
| Issue update (parentId) | Parent changed | Invalidate both old and new parent caches; trigger tick |
| Issue update (labelIds) | Labels changed | Trigger tick (may affect filtering) |
| Non-Issue events | Comment, Project, etc. | Ignored (returns `false`) |

### Response

Returns `{ ok: true }` within 5 seconds (Linear's timeout). Cache invalidation is synchronous; the orchestrator tick is fire-and-forget (`void orchestrator.triggerTick()`).

### Payload Shape

```typescript
interface LinearWebhookPayload {
  action: string;        // "create" | "update" | "remove"
  type: string;          // "Issue" | "Comment" | "Project" | ...
  data?: {
    id: string;
    parentId?: string;
    // ... other issue fields
  };
  updatedFrom?: {        // Previous values for changed fields
    stateId?: string;
    parentId?: string;
    labelIds?: string[];
    // ...
  };
  organizationId?: string;
  webhookTimestamp?: number;
}
```

## Token Resolution

The `resolveToken()` function in `src/tracker/token.ts` supports:

| Input | Resolution |
|-------|-----------|
| `$linear` | `process.env.LINEAR_API_KEY` — throws with setup instructions if unset |
| `$gh` | Runs `gh auth token` subprocess (5s timeout) |
| `$VAR_NAME` | `process.env.VAR_NAME` — throws if unset |
| `literal` | Returned as-is |

## CLI: Repo Profile Setup

```bash
# GitHub (default)
forgectl repo add <name> --tracker-repo <owner/repo> [--labels <csv>] [--token <token>]

# Linear
forgectl repo add <name> --linear \
  --team-id <uuid>              # Repeatable for multi-team
  [--project-id <uuid>]         # Filter to project
  [--webhook-secret <secret>]   # Enable webhook verification
  [--labels <csv>]              # Filter by label
  [--token <token>]             # Default: $linear
```

Profiles are stored as YAML overlays in `~/.forgectl/repos/<name>.yaml` and deep-merged with `~/.forgectl/config.yaml` at load time.

## Daemon Wiring

In `src/daemon/server.ts`, the Linear adapter is instantiated with a shared `SubIssueCache`:

```typescript
if (config.tracker.kind === "linear") {
  const { createLinearAdapter } = await import("../tracker/linear.js");
  tracker = createLinearAdapter(config.tracker, subIssueCache);
}
```

The webhook endpoint is registered when `tracker.kind === "linear"` and `tracker.webhook_secret` is set. It uses Fastify's raw body parsing to preserve the original request body for signature verification.

## Testing

30 unit tests in `test/unit/tracker-linear.test.ts`:

- Config validation (5 tests): schema parsing, required fields, defaults
- Adapter construction (4 tests): error cases, method presence, cache sharing
- Registry integration (1 test): factory registration
- Webhook handler (11 tests): event filtering, cache invalidation, parent changes
- Signature verification (5 tests): valid/invalid/tampered/wrong-secret
- Normalization (1 test): adapter creation smoke test
- Token resolution (3 tests in `token-resolve.test.ts`): `$linear` sentinel

Run tests:
```bash
FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/tracker-linear.test.ts
```

## Rate Limits

Linear uses complexity-based rate limiting:
- **5,000 requests/hour** with API key
- **250,000 complexity points/hour**
- Single query max: 10,000 points
- Practical: ~250 full issue queries/hour at 50 issues/query

The adapter does not currently implement rate limit tracking (unlike the GitHub adapter). For high-volume usage, increase `poll_interval_ms` or rely on webhooks.

## Worker & Agent Execution Layer

### End-to-End Execution Flow

When the scheduler dispatches an issue, this is the full lifecycle:

```
Scheduler tick
  └── Dispatcher.dispatchIssue(issue)
        ├── claimIssue() — exclusive lock, prevents duplicate dispatch
        ├── addLabel("in-progress") — best-effort, non-fatal
        ├── Pre-execution approval gate (if autonomy requires)
        │   └── Check auto-approve rules → block or proceed
        ├── Create GitHub/Linear progress comment
        ├── Insert run record to SQLite (status="running")
        └── executeWorkerAndHandle() — fire-and-forget async
              │
              ├── Worker.executeWorker():
              │   ├── ensureWorkspace() — per-issue dir, runs after_create hook
              │   ├── before_run hook — fail if error
              │   ├── Pre-flight: verify .git exists in workspace
              │   ├── buildOrchestratedRunPlan() — issue → RunPlan
              │   ├── prepareExecution():
              │   │   ├── Ensure Docker image exists (pull or build)
              │   │   ├── Prepare workspace (clone repo, bind-mount)
              │   │   ├── Get agent credentials (keychain lookup)
              │   │   ├── Create Docker container (sleep loop)
              │   │   └── Apply network firewall (if allowlist mode)
              │   ├── createAgentSession() — OneShotSession (default)
              │   ├── Record pre-agent HEAD SHA
              │   ├── Invoke agent (prompt piped via base64):
              │   │   ├── Claude: cat prompt | claude -p - --dangerously-skip-permissions
              │   │   └── Codex: codex exec --yolo "$(cat prompt)"
              │   ├── Validation loop:
              │   │   ├── Run ALL validation steps sequentially
              │   │   ├── If any fail → format feedback → re-invoke agent
              │   │   └── Restart ALL steps from top (not per-step)
              │   ├── Validation gate (final, no retries)
              │   │   └── If fails → mark failed, skip output collection
              │   ├── Collect git output → create branch, push
              │   ├── Post-execution approval gate (if autonomy requires)
              │   ├── after_run hook (non-fatal)
              │   └── Return WorkerResult
              │
              ├── SUCCESS (status === "completed"):
              │   ├── Create PR via tracker.createPullRequest()
              │   ├── Trigger parent rollup (if sub-issue)
              │   ├── Auto-close issue + add done_label
              │   └── Release from claimed set
              │
              └── FAILURE (status !== "completed"):
                  ├── Check retry budget (attempt vs max_retries)
                  ├── If exhausted → post failure comment, release
                  └── If retries remain → schedule retry with backoff
```

### Agent Adapters

Each agent type has an adapter that builds the shell command:

| Agent | Command | Notes |
|-------|---------|-------|
| Claude Code | `cat prompt \| claude -p - --output-format text --dangerously-skip-permissions [--max-turns N]` | Piped via stdin |
| Codex | `codex exec --yolo --skip-git-repo-check [--model M] "$(cat prompt)"` | Prompt via command substitution |
| browser-use | HTTP POST to sidecar at `localhost:8765/run` | Python HTTP sidecar |

**Prompt delivery**: Written to container via base64 in 64KB chunks (avoids ARG_MAX and shell escaping).

**Key files**: `src/agent/claude-code.ts`, `src/agent/codex.ts`, `src/agent/browser-use.ts`, `src/agent/invoke.ts`

### Agent Result

```typescript
interface AgentResult {
  stdout: string;
  stderr: string;
  status: "completed" | "failed" | "timeout" | "user_input_required";
  tokenUsage: { input: number; output: number; total: number };
  durationMs: number;
  turnCount: number;
}
```

### Worker Result

```typescript
interface WorkerResult {
  agentResult: AgentResult;
  comment: string;                  // Result comment posted to tracker
  executionResult?: ExecutionResult;
  validationResult?: ValidationResult;
  branch?: string;                  // e.g., "forge/refactor-auth/1710856800"
  pendingApproval?: boolean;
}
```

### Retry & Backoff

- **Backoff formula**: `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`
  - Attempt 1: 10s, attempt 2: 20s, attempt 3: 40s, ...
  - Default max: 300s (5 minutes)
- **Max retries**: configurable via `orchestrator.max_retries` (default: 5)
- **Failure classification**: exit 0 → `"continuation"` (not a failure), otherwise → `"error"` (retry)
- **Retry state**: in-memory `retryTimers` + `retryAttempts` maps (lost on daemon crash)

**Key files**: `src/orchestrator/worker.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/retry.ts`

### Validation System

Validation steps run after agent completion to verify correctness:

```typescript
interface ValidationStep {
  name: string;
  command: string;       // Shell command executed in container
  retries: number;       // Max agent re-invocations for this step
  timeout?: string;      // e.g., "60s"
  description: string;   // Included in agent prompt
}
```

**Flow**: Run all steps → if any fail, format feedback → re-invoke agent → restart ALL steps from top → repeat until pass or retries exhausted.

**Feedback format**:
```
VALIDATION FAILED. The following checks did not pass:

--- test:unit (exit code 1) ---
Command: npm test
STDOUT: [truncated to 3000 chars]
STDERR: [truncated to 3000 chars]

Fix the code issues. Do NOT weaken linting rules...
Fix the issues and the checks will run again.
```

**Validation gate**: After the retry loop, a final gate runs all steps once with no retries. If the gate fails, output collection is skipped entirely.

**Key files**: `src/validation/runner.ts`, `src/validation/feedback.ts`, `src/validation/step.ts`

### Prompt Building

The prompt sent to the agent is assembled from multiple sources:

```
[Workflow system prompt]
[Context files — text inlined, binary/large summarized in manifest]
[Available tools list]
--- Task ---
[Issue title + description from tracker]
[Validation step descriptions — agent knows what will be checked]
[Output instructions]
```

Context files >64KB are listed in a manifest rather than inlined. Binary files are described but not inlined.

**Key file**: `src/context/prompt.ts`

### Workspace Lifecycle

```
ensureWorkspace(identifier)
  ├── sanitizeIdentifier() — only [A-Za-z0-9._-], no path traversal
  ├── assertContainment() — prevents escape from workspace root
  ├── mkdir if not exists
  └── run after_create hook (e.g., git clone)

Worker lifecycle:
  ├── before_run hook — fatal if fails
  ├── [agent execution]
  ├── after_run hook — non-fatal
  └── workspace persists (not cleaned up per run)

removeWorkspace(identifier)
  ├── before_remove hook — non-fatal
  └── rm -rf
```

Per-issue workspaces when `max_concurrent_agents > 1`. Shared workspace when `max_concurrent_agents === 1`.

**Key files**: `src/workspace/manager.ts`, `src/workspace/hooks.ts`, `src/workspace/safety.ts`

## Durable Task State

### SQLite Persistence

All run state is persisted to SQLite (`~/.forgectl/forgectl.db`, WAL mode). The daemon survives crashes — interrupted runs are recovered on restart.

**Core tables**:

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `runs` | Run lifecycle & state | id, task, workflow, status, submittedAt, startedAt, completedAt, result (JSON), error, pauseReason, pauseContext (JSON), approvalContext (JSON), githubCommentId, parentRunId, depth |
| `run_events` | Audit trail | runId, type (18 event types), timestamp, data (JSON) |
| `run_snapshots` | Execution checkpoints | runId, stepName, timestamp, state (JSON) |
| `run_costs` | Token usage & costs | runId, agentType, model, inputTokens, outputTokens, costUsd (string), timestamp |
| `execution_locks` | Concurrency control | lockType, lockKey, ownerId, daemonPid, acquiredAt |
| `delegations` | Parent→child task tracking | parentRunId, childRunId, taskSpec (JSON), status, result (JSON), retryCount |
| `pipeline_runs` | DAG execution state | id, pipelineDefinition (JSON), status, nodeStates (JSON) |

**Key files**: `src/storage/schema.ts`, `src/storage/database.ts`, `src/storage/repositories/`

### Crash Recovery

On daemon startup, before accepting requests:

1. **Lock cleanup**: `releaseAllStaleLocks(lockRepo, currentPid)` — deletes all locks with `daemonPid ≠ current PID`
2. **Run recovery**: `recoverInterruptedRuns(runRepo, snapshotRepo)`:
   - Finds all runs with `status="running"` (orphaned from previous daemon)
   - Loads latest checkpoint from `run_snapshots`
   - Marks run as `"interrupted"` with reason and completedAt
   - Does NOT recreate containers — state is soft-marked for human review

**Checkpoint phases**: `"prepare"` | `"execute"` | `"validate"` | `"output"` — saved at phase boundaries via `saveCheckpoint()`.

**Key files**: `src/durability/recovery.ts`, `src/durability/checkpoint.ts`, `src/durability/locks.ts`

### Pause/Resume

Runs can be paused for human input (governance gates, clarification):

```
pauseRun():  running → waiting_for_input  (stores pauseReason + pauseContext JSON)
resumeRun(): waiting_for_input → running  (returns stored context, clears pause state)
```

API: `POST /api/v1/runs/:id/resume` with `{ input: "..." }`.

**Key file**: `src/durability/pause.ts`

### Governance & Approval Gates

Two gates based on autonomy level (`full` | `interactive` | `semi` | `supervised`):

| Autonomy | Pre-execution gate | Post-output gate |
|----------|-------------------|-----------------|
| `full` | skip | skip |
| `interactive` | skip | requires approval |
| `semi` | requires approval | skip |
| `supervised` | requires approval | requires approval |

**Auto-approve rules** can bypass gates based on labels, workflow pattern (glob), or cost threshold (AND logic — all specified conditions must pass).

**State machine**: `pending_approval` → approve → `running` → `pending_output_approval` → approve → `completed`

**API**: `POST /api/v1/runs/:id/approve`, `POST /api/v1/runs/:id/reject`

**Key files**: `src/governance/autonomy.ts`, `src/governance/approval.ts`, `src/governance/rules.ts`

## Cost Tracking & Budget Enforcement

### Token Cost Calculation

Costs are calculated from agent result `tokenUsage` using per-model rates:

```typescript
// src/agent/cost-rates.ts (USD per token)
"claude-sonnet-4-20250514":  { input: 3/1M,  output: 15/1M }
"claude-opus-4-20250514":    { input: 15/1M, output: 75/1M }
"claude-haiku-3-5":          { input: 0.8/1M, output: 4/1M }
"o3":                        { input: 10/1M, output: 40/1M }
"gpt-4.1":                   { input: 2/1M,  output: 8/1M }
fallback:                    { input: 3/1M,  output: 15/1M }
```

Cost stored as string in `run_costs` table (avoids float precision loss).

### Budget Enforcement

```typescript
// src/agent/budget.ts
checkBudget(costRepo, runId, budgetConfig):
  ├── Per-run cap: sumByRunId(runId) >= max_cost_per_run → BudgetExceededError
  └── Per-day cap: sumSince(startOfDay) >= max_cost_per_day → BudgetExceededError

getBudgetStatus(costRepo, runId, budgetConfig):
  └── Returns { runCostUsd, dayCostUsd, maxPerRun, maxPerDay, withinBudget }
```

Budget config via workflow definition:
```yaml
budget:
  max_cost_per_run: 5.00
  max_cost_per_day: 50.00
```

Budget status exposed via `GET /api/v1/runs/:id` (included in response when cost repo available).

### CLI Cost Inspection

```bash
forgectl costs                          # All costs
forgectl costs --runId <id>             # Per-run breakdown
forgectl costs --since 24h             # Recent costs
forgectl costs --workflow code         # Per-workflow
forgectl inspect <runId>               # Full event timeline + cost summary
```

## Execution Traces

Beyond what the issue tracker records (state changes + comments), forgectl maintains several trace layers:

### 1. Run Events Table (audit trail)

Every significant event is persisted to `run_events` with timestamp and JSON data:

```
Event types (18):
  started, phase, validation, retry, output, completed, failed,
  dispatch, reconcile, stall, orch_retry, prompt, agent_response,
  validation_step, cost, snapshot,
  approval_required, approved, rejected, revision_requested,
  output_approval_required, output_approved, output_rejected
```

Events emitted via `runEvents` EventEmitter, persisted by `EventRecorder` (swallows insert errors — never crashes the emitter).

### 2. Run Snapshots (checkpoints)

Phase boundary checkpoints in `run_snapshots`:
- stepName: `after:prepare`, `after:execute`, `after:validate`, `after:output`
- state: JSON with phase metadata
- Used for crash recovery and execution timeline

### 3. Run Costs Table

Per-invocation token usage:
- agentType, model, inputTokens, outputTokens, costUsd, timestamp
- Queryable by runId, workflow, time range

### 4. Runs Table (high-level state)

- status, duration (submittedAt → completedAt), error message
- approvalContext: who approved/rejected, feedback text
- pauseContext: why paused, what question was asked
- parentRunId + depth: delegation chain

### 5. GitHub Integration (optional)

When GitHub App is configured:
- **Progress comments**: Updated at each phase (started → agent_executing → validating → collecting_output → completed)
- **Check runs**: CI-style status checks on the PR
- **PR descriptions**: Summary table with changes, validation results, cost

### 6. SSE Event Stream

Real-time events via `GET /api/v1/events` (orchestrator-wide) or `GET /runs/:id/events` (per-run).

### 7. Structured Logger

`Logger` class writes structured entries with phase, message, data, and optional issueId. Used throughout the orchestrator for operational logging.

**Key files**: `src/logging/events.ts`, `src/logging/recorder.ts`, `src/logging/logger.ts`, `src/flight-recorder/`

## Known Limitations

### Linear Adapter
1. **No PR integration**: Linear is an issue tracker — PR creation/merging must go through the GitHub adapter or another mechanism.
2. **No rate limit tracking**: Unlike the GitHub adapter, the Linear adapter does not monitor or degrade on rate limit exhaustion.
3. **State mappings not refreshed**: If workflow states are renamed after daemon start, the adapter won't pick up changes until restart.
4. **Label filter uses `some`**: Issues matching any configured label are included (OR semantics, not AND).
5. **Blocking relations not cached**: Fetched on every `fetchCandidateIssues()` call (relatively cheap, but adds API calls per issue).

### Execution Layer
6. **Retry state is in-memory**: `retryTimers` and `retryAttempts` maps are lost on daemon crash. The reconciler attempts recovery, but retry counts reset.
7. **OneShotSession reports zero tokens**: The `OneShotSession` adapter returns `{ input: 0, output: 0, total: 0 }` for tokenUsage — actual usage comes from cost events, not the session.
8. **No container recreation on recovery**: Crash recovery marks runs as interrupted but does not attempt to recreate containers or resume execution.
9. **CostRepository insertion gap**: The `run_costs` table schema exists but the primary cost insertion path uses cost events in `run_events`. Budget enforcement queries `run_costs` — these must be populated for budget checks to work.

## Extending

To add a new tracker kind:

1. Implement `TrackerAdapter` interface in `src/tracker/<kind>.ts`
2. Add kind to `TrackerConfigSchema` enum in `src/config/schema.ts`
3. Add kind to `TrackerConfig.kind` union in `src/tracker/types.ts`
4. Register factory in `src/tracker/registry.ts`
5. Add adapter wiring in `src/daemon/server.ts` (for shared cache / webhook support)
6. Add token sentinel in `src/tracker/token.ts` (optional)
7. Add CLI support in `src/cli/repo.ts` and `src/index.ts` (optional)
