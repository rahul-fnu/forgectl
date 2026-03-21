# SPEC.md — forgectl Linear Tracker Integration

This document specifies the Linear tracker integration for forgectl. It is intended as a reference for AI agents and developers working on or extending this integration.

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

## Known Limitations

1. **No PR integration**: Linear is an issue tracker — PR creation/merging must go through the GitHub adapter or another mechanism.
2. **No rate limit tracking**: Unlike the GitHub adapter, the Linear adapter does not monitor or degrade on rate limit exhaustion.
3. **State mappings not refreshed**: If workflow states are renamed after daemon start, the adapter won't pick up changes until restart.
4. **Label filter uses `some`**: Issues matching any configured label are included (OR semantics, not AND).
5. **Blocking relations not cached**: Fetched on every `fetchCandidateIssues()` call (relatively cheap, but adds API calls per issue).

## Extending

To add a new tracker kind:

1. Implement `TrackerAdapter` interface in `src/tracker/<kind>.ts`
2. Add kind to `TrackerConfigSchema` enum in `src/config/schema.ts`
3. Add kind to `TrackerConfig.kind` union in `src/tracker/types.ts`
4. Register factory in `src/tracker/registry.ts`
5. Add adapter wiring in `src/daemon/server.ts` (for shared cache / webhook support)
6. Add token sentinel in `src/tracker/token.ts` (optional)
7. Add CLI support in `src/cli/repo.ts` and `src/index.ts` (optional)
