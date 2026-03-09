# Architecture Patterns

**Domain:** Durable AI agent runtime with persistent storage, event sourcing, governance, GitHub App integration, and browser-use agent adapter
**Researched:** 2026-03-09

## Recommended Architecture

The v2.0 architecture layers new capabilities onto the existing v1.0 foundation without replacing it. Each new subsystem integrates at well-defined seams in the current codebase. The guiding principle: **existing in-memory state becomes a cache of persistent state**, not the other way around.

```
                   INTERACTION SURFACES
        ┌──────────────────┬──────────────────┐
        │  GitHub App      │  Existing         │
        │  /webhooks/github│  REST API + UI    │
        │  (Fastify routes)│  (unchanged)      │
        └────────┬─────────┴────────┬──────────┘
                 │                  │
        ┌────────▼──────────────────▼──────────┐
        │        GOVERNANCE LAYER               │
        │  Autonomy enforcement, approval gates │
        │  Budget pre-flight checks             │
        │  (wraps dispatcher, new middleware)    │
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼─────────────────────────────┐
        │     DURABLE ORCHESTRATOR              │
        │  Extended state machine:              │
        │    + waiting_for_input                │
        │    + paused, checkpointed             │
        │  Session persistence + resume         │
        │  Execution locks via SQLite           │
        │  (modifies src/orchestrator/)         │
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼─────────────────────────────┐
        │     FLIGHT RECORDER                   │
        │  Append-only event ledger             │
        │  Subscribes to RunEvent emitter       │
        │  Persists to events table             │
        │  State reconstruction from events     │
        │  (new src/audit/, hooks into logging) │
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼─────────────────────────────┐
        │     IDENTITY LAYER                    │
        │  Company + Agent entities             │
        │  Budget scoping, attribution          │
        │  (new src/company/, extends agent/)   │
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼─────────────────────────────┐
        │     STORAGE LAYER                     │
        │  SQLite + Drizzle ORM                 │
        │  Repository pattern per entity        │
        │  Migrations via drizzle-kit           │
        │  (new src/storage/)                   │
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼─────────────────────────────┐
        │     V1.0 FOUNDATION                   │
        │  Docker sandbox, validation loop,     │
        │  agent sessions, tracker adapters,    │
        │  workspace manager, WORKFLOW.md       │
        └──────────────────────────────────────┘
```

### Component Boundaries

| Component | Directory | New/Modified | Responsibility | Communicates With |
|-----------|-----------|-------------|----------------|-------------------|
| Storage Layer | `src/storage/` | **NEW** | SQLite connection, Drizzle schema, migrations, repository functions | Everything above it |
| Company/Identity | `src/company/` | **NEW** | Company CRUD, agent identity, roles, budget scopes | Storage, Orchestrator, Governance |
| Agent Identity | `src/agent/identity.ts` | **NEW file in existing dir** | Agent entity model, lifecycle states | Storage, Company |
| Flight Recorder | `src/audit/` | **NEW** | Append-only event persistence, state snapshots, query API | Storage, Logging (events.ts) |
| Durable Orchestrator | `src/orchestrator/` | **MODIFIED** | Extended state machine, checkpointing, pause/resume, execution locks | Storage, Audit, Agent sessions |
| Governance | `src/governance/` | **NEW** | Approval gates, autonomy enforcement, budget checks | Storage, Orchestrator, WORKFLOW.md |
| Cost Tracking | `src/costs/` | **NEW** | CostEvent recording, budget enforcement, period resets | Storage, Governance, Agent sessions |
| GitHub App | `src/github-app/` | **NEW** | Webhook receiver, slash commands, reactions, check runs | Fastify daemon, Orchestrator, Governance |
| Browser-Use Adapter | `src/agent/browser-use.ts` | **NEW file in existing dir** | Sidecar process management, HTTP bridge to Python service | Agent session interface, Container |
| Daemon Server | `src/daemon/server.ts` | **MODIFIED** | Initialize storage on startup, register webhook routes, pass db to services | Storage, all services |
| Daemon Routes | `src/daemon/routes.ts` | **MODIFIED** | Add webhook route group, audit trail API endpoints | GitHub App, Flight Recorder |
| Config Schema | `src/config/schema.ts` | **MODIFIED** | Add autonomy, budget_cap, triggers fields | Governance, Workflow |
| Workflow Types | `src/workflow/types.ts` | **MODIFIED** | Add autonomy, budget_cap, triggers to WorkflowFileConfig | Governance |
| RunEvent/RunLog | `src/logging/events.ts`, `run-log.ts` | **MODIFIED** | Extended event types, flight recorder subscription | Audit |

---

## Integration Point 1: SQLite/Drizzle Storage Layer

### Where It Plugs In

**New directory:** `src/storage/` with the following structure:

```
src/storage/
  db.ts          # SQLite connection singleton (better-sqlite3 + drizzle)
  schema.ts      # Drizzle table definitions
  migrate.ts     # Migration runner (drizzle-kit)
  repositories/
    runs.ts      # Run CRUD
    events.ts    # Append-only event store
    agents.ts    # Agent identity CRUD
    companies.ts # Company CRUD
    approvals.ts # Approval gate CRUD
    costs.ts     # Cost event recording
    sessions.ts  # Durable session state
```

### What It Replaces vs. What It Preserves

| Current | v2.0 |
|---------|------|
| `OrchestratorState` (in-memory Sets/Maps) | In-memory state **backed by** SQLite; rebuilt from DB on daemon restart |
| `RunLog` saved as JSON files via `saveRunLog()` | Run metadata in `runs` table; JSON log files **still written** for backward compat |
| `RunEvent` emitted to EventEmitter only | Events **also** persisted to `events` table by flight recorder subscriber |
| `MetricsCollector` (in-memory counters) | Metrics computed from persistent events; in-memory collector becomes a cache |
| Retry attempts tracked in `state.retryAttempts` Map | Attempt count stored in `runs` table, loaded on recovery |

### Connection Initialization

The database initializes **once** at daemon startup, before any services start:

```typescript
// src/storage/db.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;

export function initDb(path: string = '~/.forgectl/forgectl.db') {
  const sqlite = new Database(resolvedPath, { /* WAL mode for concurrent reads */ });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  _db = drizzle(sqlite, { schema });
  return _db;
}

export function getDb() {
  if (!_db) throw new Error('Database not initialized — call initDb() first');
  return _db;
}
```

**Modified file:** `src/daemon/server.ts` adds `initDb()` call before `new Orchestrator()`:

```typescript
// In startDaemon():
import { initDb, runMigrations } from '../storage/db.js';

const db = initDb();
await runMigrations(db);
// ... then create orchestrator, register routes, etc.
```

### Schema Design (Key Tables)

```typescript
// src/storage/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config'),  // JSON blob
  createdAt: text('created_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull(), // pending_approval | idle | running | paused | waiting_for_input | terminated
  reportsTo: text('reports_to'),
  budgetCents: integer('budget_cents'),
  budgetPeriod: text('budget_period'), // monthly | weekly
  createdAt: text('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').references(() => agents.id),
  issueId: text('issue_id'),
  issueIdentifier: text('issue_identifier'),
  trackerKind: text('tracker_kind'),
  status: text('status').notNull(), // queued | running | paused | waiting_for_input | completed | failed | abandoned
  attempt: integer('attempt').notNull().default(1),
  checkpointData: text('checkpoint_data'), // JSON: serialized execution state
  costCents: integer('cost_cents').default(0),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').references(() => runs.id),
  type: text('type').notNull(),
  data: text('data').notNull(), // JSON
  createdAt: text('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => runs.id),
  type: text('type').notNull(), // plan_review | expensive_run | deploy | custom
  status: text('status').notNull(), // pending | approved | rejected | revision_requested
  requestedBy: text('requested_by'),
  decidedBy: text('decided_by'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

export const costEvents = sqliteTable('cost_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').references(() => runs.id),
  agentId: text('agent_id').references(() => agents.id),
  provider: text('provider').notNull(), // anthropic | openai
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cents: real('cents').notNull(),
  createdAt: text('created_at').notNull(),
});

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').references(() => runs.id),
  role: text('role').notNull(), // agent | human
  content: text('content').notNull(),
  source: text('source'), // github_comment | notion_comment | cli
  externalId: text('external_id'), // GitHub comment ID, etc.
  createdAt: text('created_at').notNull(),
});
```

### Backward Compatibility

The `saveRunLog()` function in `src/logging/run-log.ts` continues to write JSON files. A new `persistRunLog()` function writes to both the `runs` table and the JSON file. Existing `forgectl run` commands see no difference. The database is an additive layer.

---

## Integration Point 2: GitHub App Webhook Receiver in Fastify Daemon

### Where It Plugs In

**New directory:** `src/github-app/` with the following structure:

```
src/github-app/
  webhook.ts        # Fastify route plugin for /webhooks/github
  verify.ts         # HMAC-SHA256 signature verification
  events.ts         # Event handlers (issue labeled, comment created, reaction, etc.)
  commands.ts       # Slash command parser
  bot.ts            # Bot comment formatting (templates)
  auth.ts           # GitHub App JWT + installation token management
  types.ts          # Event payload types
```

### Integration with Fastify Daemon

The webhook receiver is a **Fastify plugin** registered on the existing app instance. This follows Fastify's encapsulation model.

**Modified file:** `src/daemon/server.ts`

```typescript
// After existing registerRoutes():
import { registerGitHubAppRoutes } from '../github-app/webhook.js';

if (config.githubApp) {
  registerGitHubAppRoutes(app, {
    appId: config.githubApp.appId,
    privateKey: config.githubApp.privateKey,
    webhookSecret: config.githubApp.webhookSecret,
    orchestrator,
    governance,  // approval/budget system
    db,
  });
}
```

**Modified file:** `src/daemon/routes.ts` -- the webhook route group is separate, NOT added here. It gets its own plugin for encapsulation.

### Webhook Flow

```
GitHub POST /webhooks/github
  → verify.ts: HMAC-SHA256 signature check (preValidation hook)
  → webhook.ts: route handler, parse event type from X-GitHub-Event header
  → events.ts: dispatch to handler by event type
    → issues.labeled → check trigger rules → enqueue into orchestrator via dispatchIssue()
    → issue_comment.created → check for slash command → commands.ts parser
    → pull_request_review → feed back to agent session
    → check_run.rerequested → re-trigger run
```

### Key Design Decision: Webhook Events Enqueue, Don't Execute

Webhook handlers do NOT execute runs synchronously. They either:
1. Call `orchestrator.triggerTick()` to wake the scheduler (for new work)
2. Post to an internal event bus for the governance system (for approvals)
3. Resume a paused run by updating the `runs` table status and waking the scheduler

This keeps webhook response times under 1 second (GitHub expects a response within 10 seconds).

### Authentication: @octokit/auth-app + @octokit/webhooks

Use `@octokit/app` which bundles auth-app, webhooks, and Octokit REST client. This is the official GitHub SDK for GitHub Apps.

```typescript
// src/github-app/auth.ts
import { App } from '@octokit/app';

export function createGitHubApp(config: GitHubAppConfig) {
  return new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: { secret: config.webhookSecret },
  });
}
```

Webhook signature verification uses the Octokit webhooks library's `verify()` function, wrapped as a Fastify `preValidation` hook. This requires `@fastify/raw-body` to access the raw request body for signature computation.

### Relationship to Existing Tracker Adapter

The GitHub App does NOT replace the existing `TrackerAdapter`. The tracker adapter handles **polling** for candidate issues. The GitHub App handles **push events** (webhooks). They coexist:

- **Without GitHub App:** Polling-only mode (existing v1 behavior, unchanged)
- **With GitHub App:** Webhooks trigger immediate dispatch; polling is fallback/reconciliation

When a webhook arrives for an issue event, the handler calls `orchestrator.triggerTick()` which re-runs the normal candidate selection pipeline. The webhook just makes it faster (seconds instead of poll interval).

---

## Integration Point 3: Event-Sourced Flight Recorder Under RunEvent/RunLog

### Where It Plugs In

**New directory:** `src/audit/`

```
src/audit/
  recorder.ts    # Flight recorder: subscribes to RunEvent, persists to DB
  snapshots.ts   # State snapshot creation at step boundaries
  query.ts       # Query API: run history, filter, replay
  writeback.ts   # Rich write-back formatting for GitHub/Notion comments
```

### How It Layers Under Existing Logging

The existing `RunEvent` emitter (`src/logging/events.ts`) is the **source**. The flight recorder is a **subscriber** that persists events to SQLite. This is purely additive -- no existing code changes except adding the subscription.

```
  Agent/Worker/Orchestrator
         │
         ▼
  emitRunEvent(event)          ← existing, unchanged
         │
    ┌────┴────────────────┐
    ▼                     ▼
  SSE listeners       FlightRecorder.onEvent(event)   ← NEW subscriber
  (existing)               │
                           ▼
                    INSERT INTO events (run_id, type, data, created_at)
```

**Modified file:** `src/logging/events.ts` -- extend the `RunEvent.type` union to include new event types:

```typescript
export interface RunEvent {
  runId: string;
  type: "started" | "phase" | "validation" | "retry" | "output" | "completed" | "failed"
    | "dispatch" | "reconcile" | "stall" | "orch_retry"
    // v2.0 additions:
    | "checkpoint" | "paused" | "resumed" | "waiting_for_input" | "input_received"
    | "approval_requested" | "approval_decided" | "cost_event"
    | "agent_tool_call" | "container_lifecycle";
  timestamp: string;
  data: Record<string, unknown>;
}
```

**Modified file:** `src/daemon/server.ts` -- initialize the recorder after db:

```typescript
import { FlightRecorder } from '../audit/recorder.js';

const recorder = new FlightRecorder(db);
recorder.start(); // Subscribes to runEvents emitter
```

### State Reconstruction

The flight recorder enables reconstructing any run's state by replaying its events. This powers:
- `forgectl run inspect <run-id>` CLI command
- Dashboard run detail view
- Crash recovery (rebuild in-memory state from events on daemon restart)

### Append-Only Guarantee

Events are INSERT-only into the `events` table. No UPDATE or DELETE. Corrections are new compensating events. The table has no unique constraint on (run_id, type) -- duplicates are valid (multiple retries produce multiple events).

---

## Integration Point 4: Durable Execution Extending Orchestrator State Machine

### What Changes in `src/orchestrator/`

**Modified file:** `src/orchestrator/state.ts`

The `IssueState` type gains new states:

```typescript
export type IssueState =
  | "claimed"
  | "running"
  | "retry_queued"
  | "released"
  // v2.0 additions:
  | "paused"              // Human requested pause via slash command
  | "waiting_for_input"   // Agent asked a clarification question
  | "checkpointed";       // Saved state, container may be reclaimed
```

The `OrchestratorState` changes from ephemeral to **persistent-backed**:

```typescript
export interface OrchestratorState {
  // Existing (now backed by DB):
  claimed: Set<string>;
  running: Map<string, WorkerInfo>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  retryAttempts: Map<string, number>;
  // v2.0 additions:
  paused: Map<string, PausedRunInfo>;
  waitingForInput: Map<string, WaitingRunInfo>;
}

export interface PausedRunInfo {
  issueId: string;
  runId: string;
  checkpointId: string;  // References state snapshot in DB
  pausedAt: number;
  reason: string;
}

export interface WaitingRunInfo {
  issueId: string;
  runId: string;
  checkpointId: string;
  question: string;       // What the agent asked
  askedAt: number;
  timeoutMs: number;      // When to mark as stalled
}
```

### Execution Locks via SQLite

Replace the in-memory `claimed` Set with SQLite-backed atomic claims using `BEGIN IMMEDIATE`:

```typescript
// src/orchestrator/locks.ts
export function atomicClaim(db: DB, issueId: string, workerId: string): boolean {
  return db.transaction(() => {
    const existing = db.select().from(runs)
      .where(and(eq(runs.issueId, issueId), inArray(runs.status, ['running', 'paused', 'waiting_for_input'])))
      .get();
    if (existing) return false;
    // Insert new run record
    db.insert(runs).values({ id: newRunId(), issueId, status: 'running', ... }).run();
    return true;
  })();
}
```

### Crash Recovery

**Modified file:** `src/orchestrator/index.ts` -- the `startupRecovery()` method expands:

```typescript
private async startupRecovery(): Promise<void> {
  // Existing: clean terminal workspaces (unchanged)

  // NEW: Recover interrupted runs from DB
  const interruptedRuns = db.select().from(runs)
    .where(eq(runs.status, 'running'))
    .all();

  for (const run of interruptedRuns) {
    if (run.checkpointData) {
      // Has checkpoint: mark as checkpointed, scheduler will resume
      db.update(runs).set({ status: 'checkpointed' }).where(eq(runs.id, run.id)).run();
    } else {
      // No checkpoint: mark as failed with crash reason
      db.update(runs).set({ status: 'failed', completedAt: now() }).where(eq(runs.id, run.id)).run();
      this.recorder.emit({ runId: run.id, type: 'failed', data: { reason: 'daemon_crash_recovery' } });
    }
  }

  // Rebuild in-memory state from DB
  this.state = rebuildStateFromDb(db);
}
```

### Checkpoint/Resume Flow

```
Agent working on issue #42
  → Step boundary reached (e.g., after validation pass)
  → Checkpoint: serialize { prompt history, workspace state hash, step index, context }
  → INSERT INTO state_snapshots (run_id, data, created_at)
  → If daemon crashes...
  → On restart: find checkpointed runs
  → Restore workspace (already persisted on disk)
  → Rebuild agent context from checkpoint + audit trail events
  → Resume agent from last step
```

---

## Integration Point 5: Governance/Autonomy Extending WORKFLOW.md Contract

### What Changes in WORKFLOW.md

**Modified file:** `src/workflow/types.ts` -- `WorkflowFileConfig` gains:

```typescript
export interface WorkflowFileConfig {
  // ... existing fields ...

  // v2.0 additions:
  autonomy?: 'full' | 'semi' | 'interactive' | 'supervised';
  budget_cap?: number;    // Max cost in dollars per run
  triggers?: {
    github_labels?: string[];
    notion_status?: string;
  };
}
```

**Modified file:** `src/config/schema.ts` -- `ConfigSchema` gains governance section:

```typescript
export const ConfigSchema = z.object({
  // ... existing fields ...

  governance: z.object({
    default_autonomy: z.enum(['full', 'semi', 'interactive', 'supervised']).default('semi'),
    budget: z.object({
      default_cap_cents: z.number().int().default(500),  // $5.00
      period: z.enum(['monthly', 'weekly', 'per_run']).default('per_run'),
    }).default({}),
    auto_approve: z.object({
      max_cost_cents: z.number().int().default(100),
      max_files_changed: z.number().int().default(10),
      labels: z.array(z.string()).default([]),
    }).default({}),
  }).default({}),
});
```

### Governance Enforcement Points

The governance system inserts checks at three points in the existing dispatch flow:

```
Candidate selected (dispatcher.ts)
  → PRE-DISPATCH: Budget pre-flight check (governance)
    → If over budget: reject, post comment, skip
  → DISPATCH: executeWorker() begins
  → IN-FLIGHT: Agent produces plan
    → If autonomy != 'full': pause, post plan for review
    → Wait for approval (waiting_for_input state)
  → POST-COMPLETION: Cost recording
    → Update budget spent, emit cost_event
```

**New middleware pattern** -- governance wraps the dispatcher, not replaces it:

```typescript
// src/governance/enforcement.ts
export async function governedDispatch(
  issue: TrackerIssue,
  config: ForgectlConfig,
  governance: GovernanceEngine,
  originalDispatch: DispatchFn,
): Promise<void> {
  // 1. Budget pre-flight
  const budgetOk = await governance.checkBudget(issue, config);
  if (!budgetOk) {
    await governance.rejectOverBudget(issue);
    return;
  }

  // 2. Autonomy check — does this need pre-approval?
  const autonomy = config.governance.default_autonomy; // or from WORKFLOW.md
  if (autonomy === 'supervised') {
    await governance.requestPlanApproval(issue);
    return; // Don't dispatch yet; wait for approval webhook/reaction
  }

  // 3. Proceed with normal dispatch
  originalDispatch(issue);
}
```

**Modified file:** `src/orchestrator/dispatcher.ts` -- the `dispatchIssue()` function wraps with governance check before calling `executeWorkerAndHandle()`.

---

## Integration Point 6: Browser-Use as Third Agent Adapter

### Architecture: Python Sidecar in Docker Container

Browser-use is a Python library with no official REST API. The integration pattern is a **sidecar process** running inside the same Docker container as the agent, with a thin HTTP bridge.

```
┌─────────────────── Docker Container ───────────────────┐
│                                                         │
│  ┌──────────────┐     HTTP (localhost:9222)    ┌──────┐│
│  │ browser-use  │◄────────────────────────────►│bridge││
│  │ Python agent │     POST /task               │(Node)││
│  │ + Playwright │     GET /status              │      ││
│  └──────────────┘     POST /stop               └──┬───┘│
│                                                    │    │
│                                            stdio/exec   │
│                                                    │    │
└────────────────────────────────────────────────────┘    │
                                                     │
                                              forgectl daemon
                                              (BrowserUseSession)
```

### Why Sidecar, Not External Service

1. **Sandboxing:** Browser-use runs inside the container, inheriting all Docker isolation (network, filesystem, resources)
2. **Lifecycle:** Container start/stop manages the browser-use process -- no external service to manage
3. **Security:** The browser can't escape the container sandbox
4. **Consistency:** Same model as Claude Code (CLI in container) and Codex (subprocess in container)

### Implementation

**New file:** `src/agent/browser-use.ts`

```typescript
import type Docker from 'dockerode';
import type { AgentSession, AgentResult, InvokeOptions } from './session.js';

/**
 * BrowserUseSession runs a Python browser-use agent inside the Docker container.
 * Communication via HTTP to a thin bridge server inside the container.
 */
export class BrowserUseSession implements AgentSession {
  private container: Docker.Container;
  private bridgePort = 9222;
  private alive = false;

  constructor(container: Docker.Container, options: BrowserUseOptions) {
    this.container = container;
  }

  async invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult> {
    // 1. Start bridge + browser-use if not running
    if (!this.alive) {
      await this.startSidecar();
    }

    // 2. POST task to bridge
    const exec = await this.container.exec({
      Cmd: ['curl', '-s', '-X', 'POST', `http://localhost:${this.bridgePort}/task`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ task: prompt, timeout: options?.timeout })],
      AttachStdout: true, AttachStderr: true,
    });

    // 3. Poll status until complete
    // 4. Return AgentResult
  }

  isAlive(): boolean { return this.alive; }
  async close(): Promise<void> { /* stop sidecar */ }
}
```

### Container Image

Browser-use requires a Docker image with Python, Playwright, and Chromium. This is a **separate base image** from the default Node.js agent image:

```dockerfile
# Dockerfile.browser-use
FROM mcr.microsoft.com/playwright/python:v1.50.0
RUN pip install browser-use
COPY bridge/ /opt/bridge/
CMD ["python", "/opt/bridge/server.py"]
```

The bridge server is a minimal FastAPI/Flask app (~50 lines) that wraps browser-use's Agent class with HTTP endpoints.

### Agent Registry Integration

**Modified file:** `src/agent/registry.ts` -- add browser-use adapter:

```typescript
// Existing:
const adapters: Record<string, AgentAdapter> = {
  'claude-code': claudeCodeAdapter,
  'codex': codexAdapter,
};

// v2.0:
// browser-use doesn't use the AgentAdapter interface (shell command builder)
// because it uses a sidecar HTTP pattern, not CLI invocation.
// Instead, it's handled in createAgentSession():
```

**Modified file:** `src/agent/session.ts` -- extend `createAgentSession()`:

```typescript
export function createAgentSession(
  agentType: string,
  container: Docker.Container,
  agentOptions: AgentOptions,
  env: string[],
  sessionOptions?: AgentSessionOptions,
): AgentSession {
  if (agentType === 'browser-use') {
    return new BrowserUseSession(container, agentOptions, env);
  }
  if (agentType === 'codex' && sessionOptions?.useAppServer) {
    return new AppServerSession(container, agentOptions, env, sessionOptions);
  }
  const adapter = getAgentAdapter(agentType);
  return new OneShotSession(container, adapter, agentOptions, env, sessionOptions);
}
```

**Modified file:** `src/config/schema.ts` -- extend AgentType:

```typescript
export const AgentType = z.enum(['claude-code', 'codex', 'browser-use']);
```

### When to Use Browser-Use

Browser-use is for tasks that require web interaction: scraping, form filling, web research, testing web UIs. It is NOT a general-purpose coding agent. The WORKFLOW.md specifies when to use it:

```yaml
---
name: web-research
agent: browser-use
autonomy: semi
validation:
  steps:
    - name: output-exists
      command: test -f /workspace/output/results.json
---
```

---

## Data Flow Changes

### v1.0 Data Flow (Current)
```
Tracker poll → candidates → filter → sort → dispatch → worker → agent CLI → validation → output → comment
                                                  ↓
                                           RunEvent emitter → SSE → dashboard
                                                  ↓
                                           saveRunLog() → JSON file
```

### v2.0 Data Flow (New)
```
Tracker poll ──────────────┐
GitHub webhook ────────────┤
                           ▼
                     candidates → governance pre-flight → filter → sort → dispatch
                                                                           ↓
                     ┌───────────────────────────────────────── worker ─────────────┐
                     │                                                              │
                     │  autonomy check → [if supervised: pause, await approval]     │
                     │  agent session (Claude/Codex/browser-use) → validation       │
                     │  [if clarification needed: pause, ask question, wait]        │
                     │  checkpoint at step boundaries                               │
                     │                                                              │
                     └──────────────────────────┬───────────────────────────────────┘
                                                ↓
                                         RunEvent emitter
                                           ↓       ↓        ↓
                                     SSE stream   Flight    Rich write-back
                                     (existing)   Recorder  (GitHub comment /
                                                  (→ DB)    Notion update)
                                                    ↓
                                              Cost recording
                                              Budget update
```

---

## Patterns to Follow

### Pattern 1: Repository Pattern for Storage

**What:** Each entity (runs, events, agents, approvals) gets a typed repository module with query/mutation functions. No raw SQL or Drizzle calls outside `src/storage/repositories/`.

**When:** All database access.

**Example:**

```typescript
// src/storage/repositories/runs.ts
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db.js';
import { runs } from '../schema.js';

export function createRun(data: NewRun): Run {
  return getDb().insert(runs).values(data).returning().get();
}

export function getRunById(id: string): Run | undefined {
  return getDb().select().from(runs).where(eq(runs.id, id)).get();
}

export function getRunsByIssue(issueId: string): Run[] {
  return getDb().select().from(runs).where(eq(runs.issueId, issueId)).orderBy(desc(runs.createdAt)).all();
}
```

### Pattern 2: Event Subscriber for Cross-Cutting Concerns

**What:** New subsystems (flight recorder, cost tracking, write-back) subscribe to the existing `runEvents` EventEmitter rather than being called directly from the orchestrator.

**When:** Adding observability or side-effects that shouldn't couple to the core dispatch loop.

**Why:** The orchestrator stays clean. Subscribers can fail independently without blocking the main flow.

### Pattern 3: Fastify Plugin Encapsulation for Route Groups

**What:** Each new route group (webhooks, audit API, governance API) is a separate Fastify plugin with its own prefix and dependencies.

**When:** Adding new API surface area.

**Example:**

```typescript
// src/github-app/webhook.ts
import type { FastifyInstance } from 'fastify';

export async function registerGitHubAppRoutes(app: FastifyInstance, deps: WebhookDeps) {
  app.register(async (instance) => {
    instance.addHook('preValidation', verifyWebhookSignature(deps.webhookSecret));
    instance.post('/webhooks/github', async (request, reply) => { /* ... */ });
  });
}
```

### Pattern 4: Governance as Middleware Wrapper

**What:** Governance checks wrap existing dispatch functions rather than being embedded inside them. The core orchestrator doesn't know about approvals or budgets -- it just dispatches. Governance intercepts before dispatch.

**When:** Adding policy enforcement without contaminating the execution engine.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Replacing In-Memory State Entirely with DB Queries

**What:** Making every state check a database query.

**Why bad:** SQLite is fast but not free. The scheduler tick runs every 30 seconds and checks running workers, retry queues, and slot availability. Making this all DB queries adds unnecessary latency and complexity.

**Instead:** Keep in-memory state as the primary working set. Persist to DB at state transitions. Rebuild from DB only on startup recovery. The in-memory state is the "cache" of the persistent state.

### Anti-Pattern 2: Synchronous Webhook Processing

**What:** Executing a full agent run inside a webhook handler.

**Why bad:** GitHub expects webhook responses within 10 seconds. Agent runs take minutes.

**Instead:** Webhook handlers enqueue work and return 202 immediately. The scheduler picks up enqueued work on the next tick.

### Anti-Pattern 3: Coupling Agent Adapter Interface to CLI Pattern

**What:** Forcing browser-use into the `AgentAdapter.buildShellCommand()` interface designed for Claude Code's CLI.

**Why bad:** Browser-use is not a CLI tool. It's a Python library that needs a sidecar HTTP bridge. Forcing it into the shell command pattern creates ugly workarounds.

**Instead:** The `AgentSession` interface (invoke/isAlive/close) is the right abstraction level. Each session implementation (OneShotSession, AppServerSession, BrowserUseSession) handles its own communication pattern internally.

### Anti-Pattern 4: Monolithic Event Types

**What:** Using a single `RunEvent` type for everything and relying on the `data` bag.

**Why bad:** Makes querying specific event types difficult and loses type safety.

**Instead:** Keep the existing `RunEvent` structure (it's simple and works) but ensure the `type` field is well-defined in the union. Use the `data` field with documented shapes per type. Don't create a separate class hierarchy for events -- that's overengineering for an append-only log.

---

## Scalability Considerations

| Concern | At 10 runs/day | At 100 runs/day | At 1000 runs/day |
|---------|----------------|------------------|-------------------|
| SQLite write throughput | Trivial | WAL mode handles easily | Consider VACUUM schedule, may need write batching for events |
| Event table size | ~1K events | ~10K events/month | ~100K events/month; add index on (run_id, created_at), consider periodic archival |
| Webhook processing | Instant | Need deduplication logic | Need rate limiting, webhook queue |
| Container concurrency | 1-3 slots | 3-5 slots | Need multi-worker (out of scope for v2) |
| GitHub API rate limits | No concern | Watch for 5000 req/hr limit | Need installation token rotation, conditional requests |
| Browser-use resources | ~512MB per browser | Multiple browsers strain memory | Need browser pool management |

## Suggested Build Order

Based on the dependency graph and integration points:

```
Phase 1: Storage Layer (src/storage/)
  No dependencies on other v2 features.
  All other phases depend on this.

Phase 2: Company & Agent Identity (src/company/, src/agent/identity.ts)
  Depends on: Phase 1
  Needed by: Phase 3 (attribution), Phase 5 (budget scoping)

Phase 3: Flight Recorder (src/audit/)
  Depends on: Phase 1, Phase 2
  Low-risk: purely additive subscriber pattern
  Needed by: Phase 4 (crash recovery from events)

Phase 4: Durable Execution (modify src/orchestrator/)
  Depends on: Phase 1, 2, 3
  Highest complexity: modifies core state machine

Phase 5: Governance (src/governance/, src/costs/)
  Depends on: Phase 2, 3
  CAN parallelize with Phase 4 (different code paths)

Phase 6: GitHub App (src/github-app/)
  Depends on: Phase 4, 5
  Highest user-facing impact

Browser-Use Adapter: Can be built anytime after Phase 1
  Independent of governance/durability
  Useful for demo scenarios
  Suggest: build alongside Phase 3 or 4 as a parallel track
```

## Sources

- [Drizzle ORM SQLite setup](https://orm.drizzle.team/docs/get-started-sqlite) -- Official docs, HIGH confidence
- [Drizzle SQLite column types](https://orm.drizzle.team/docs/column-types/sqlite) -- Official docs, HIGH confidence
- [Event sourcing with relational databases](https://softwaremill.com/implementing-event-sourcing-using-a-relational-database/) -- Pattern reference, MEDIUM confidence
- [Event sourcing with SQLite CQRS guide](https://www.sqliteforum.com/p/building-event-sourcing-systems-with) -- Pattern reference, MEDIUM confidence
- [Octokit GitHub App auth](https://github.com/octokit/auth-app.js/) -- Official library, HIGH confidence
- [Octokit webhooks.js](https://github.com/octokit/webhooks.js/) -- Official library, HIGH confidence
- [Octokit app.js (bundled SDK)](https://github.com/octokit/app.js/) -- Official library, HIGH confidence
- [browser-use GitHub repository](https://github.com/browser-use/browser-use) -- Official project, HIGH confidence
- [browser-use REST API feature request](https://github.com/browser-use/browser-use/issues/166) -- Confirms no built-in REST API, MEDIUM confidence
- [fastify-webhook plugin](https://github.com/smartiniOnGitHub/fastify-webhook) -- Fastify ecosystem, MEDIUM confidence
- [@fastify/raw-body for webhook signatures](https://github.com/autotelic/fastify-webhooks) -- Fastify ecosystem, MEDIUM confidence
