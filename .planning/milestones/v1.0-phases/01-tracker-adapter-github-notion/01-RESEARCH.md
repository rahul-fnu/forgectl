# Phase 1 Research: Tracker Adapter Interface + GitHub Issues + Notion

## 1. Existing Adapter/Registry Patterns

### Agent Adapter Pattern (the model to follow)
The project has a clean adapter pattern in `src/agent/`:

- **Interface** (`src/agent/types.ts`): `AgentAdapter` with `name: string` + one method
- **Implementations** (`src/agent/claude-code.ts`, `src/agent/codex.ts`): Plain objects implementing the interface (not classes)
- **Registry** (`src/agent/registry.ts`): Static `Record<string, AgentAdapter>` map, `getAgentAdapter(name)` throws on unknown

```typescript
// Pattern: static record + lookup function that throws
const ADAPTERS: Record<string, AgentAdapter> = { "claude-code": claudeCodeAdapter, "codex": codexAdapter };
export function getAgentAdapter(name: string): AgentAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}
```

**Key decision for tracker registry:** The tracker adapter pattern is more complex than agent adapters because tracker adapters need configuration (token, repo, etc.) passed at construction time. Agent adapters are stateless (just build a command string). Tracker adapters will be stateful (hold config, ETag cache, rate limit state). This means the registry should be a **factory pattern** — `createTrackerAdapter(config) => TrackerAdapter` — rather than a static lookup.

### Workflow Registry Pattern
`src/workflow/registry.ts` uses a similar static map + `getWorkflow(name)` pattern with support for custom workflow loading and `extends` inheritance via `deepMerge`.

### Board Schema Pattern (closest to tracker config)
`src/board/schema.ts` shows the most recent pattern for complex zod schemas with discriminated configurations. Uses `z.object()` with nested structures, `.default({})` for optional sections, `.regex()` for ID validation, and `.refine()` for custom validation.

## 2. Config Schema Integration Points

### Current Schema Structure (`src/config/schema.ts`)
The `ConfigSchema` is a flat `z.object()` with top-level sections: `agent`, `container`, `repo`, `orchestration`, `commit`, `output`, `board`. Each section uses `.default({})` so the entire config can be parsed from `{}`.

### Where tracker config fits
Add a new top-level `tracker` section to `ConfigSchema`. The section needs to be a **discriminated union** on `tracker.kind`:

```typescript
// Option A: z.discriminatedUnion (cleanest)
const TrackerConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), token: z.string(), repo: z.string(), ... }),
  z.object({ kind: z.literal("notion"), token: z.string(), database_id: z.string(), ... }),
]);

// Option B: z.object with kind + optional per-adapter fields (simpler, matches existing patterns)
const TrackerConfigSchema = z.object({
  kind: z.enum(["github", "notion"]),
  token: z.string(),  // shared
  active_states: z.array(z.string()).default(["open"]),
  terminal_states: z.array(z.string()).default(["closed"]),
  // GitHub-specific
  repo: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // Notion-specific
  database_id: z.string().optional(),
  property_map: z.record(z.string()).optional(),
}).optional();
```

**Recommendation:** Use Option B (single object with optional per-adapter fields) for simplicity, then use `.refine()` or `.superRefine()` to validate that the correct fields are present for the chosen `kind`. This matches the project's existing flat-config style and avoids complexity. The adapter's own `validateConfig()` method provides a second layer of validation.

### Token Indirection ($VAR)
R1.1 requires `$VAR` indirection for API tokens. The token field should accept strings like `$GITHUB_TOKEN` and resolve from `process.env` at runtime. This resolution should happen in the adapter's initialization, not in the schema (zod validates structure, adapter validates runtime values).

### Config Loading
`src/config/loader.ts` handles YAML loading + zod parsing. The `loadConfig()` function returns a fully validated `ForgectlConfig`. The tracker section will be `.optional()` since not all forgectl uses need a tracker.

## 3. HTTP Client

### No external HTTP library needed
The project targets Node.js 20+ and already uses native `fetch()` throughout:
- `src/index.ts` uses `fetch()` for daemon communication
- `src/cli/board.ts` uses `fetch()` for board API calls
- No `node-fetch`, `undici`, `axios`, or `got` in `package.json`

**Decision:** Use native `fetch()` for both GitHub and Notion API calls. This requires no new dependencies. Node 20's `fetch` supports all needed features:
- Custom headers (Authorization, ETag, Content-Type)
- JSON response parsing
- Response headers access (Link, X-RateLimit-*, ETag)
- POST with JSON body (for Notion)

## 4. Test Patterns

### Test Structure
- Tests live in `test/unit/` and `test/integration/`
- Import from `vitest`: `describe`, `it`, `expect`, `vi`, `beforeEach`
- vitest config has `globals: true` so `describe`/`it`/`expect` are globally available (but tests still import them explicitly)
- Test timeout: 30s default

### Mocking Patterns
1. **Module mocking** via `vi.mock("module-path", () => ({ ... }))` — used extensively
2. **Function mocking** via `vi.fn()` for individual functions
3. **Import actual** via `vi.importActual()` when partially mocking a module
4. **Mocked access** via `vi.mocked(fn).mock.calls` for call inspection
5. Mocks are declared **before** the import of the module under test

### Test Data Patterns
- Helper functions like `makeMinimalPlan()` create test fixtures with overrides
- Tests use inline assertions, no snapshot testing
- Config tests validate both happy path (defaults, overrides) and error cases (invalid values)

### Recommended test approach for tracker adapters
- Mock `global.fetch` using `vi.fn()` to simulate API responses
- Test each adapter method independently: fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates
- Test pagination (multiple fetch calls), ETag caching (304 responses), rate limiting
- Test normalization of API responses to TrackerIssue model
- Test write operations: postComment, updateState, updateLabels
- Test config validation: missing token, missing repo, invalid fields
- Test token indirection: `$VAR` resolution from environment

## 5. GitHub Issues API Specifics

### Polling Endpoint
```
GET /repos/{owner}/{repo}/issues
```
Query parameters:
- `state`: `open`, `closed`, `all` (default: `open`)
- `labels`: comma-separated label names (filter)
- `sort`: `created`, `updated`, `comments` (default: `created`)
- `direction`: `asc`, `desc` (default: `desc`)
- `since`: ISO 8601 timestamp — only issues updated at or after this time
- `per_page`: 1-100 (default: 30, use 100)
- `page`: page number for pagination

### Conditional Requests (ETag)
- Response includes `ETag` header
- Send `If-None-Match: <etag>` in subsequent requests
- `304 Not Modified` = no changes, costs zero rate limit
- Implementation: store last ETag per endpoint, include in polling requests

### Pagination
- Response `Link` header: `<url>; rel="next", <url>; rel="last"`
- Parse `rel="next"` URL to get next page
- Continue until no `rel="next"` link

### Rate Limiting
- `X-RateLimit-Limit`: total allowed per hour (5000 for authenticated)
- `X-RateLimit-Remaining`: remaining requests
- `X-RateLimit-Reset`: UTC epoch seconds when limit resets
- When `Remaining < threshold` (e.g., 100): calculate wait time from Reset header
- `403` with `X-RateLimit-Remaining: 0` = rate limited, must wait

### Write Operations
- **Post comment**: `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` with `{ body: "..." }`
- **Add labels**: `POST /repos/{owner}/{repo}/issues/{issue_number}/labels` with `{ labels: ["..."] }`
- **Remove label**: `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{label_name}`
- **Close issue**: `PATCH /repos/{owner}/{repo}/issues/{issue_number}` with `{ state: "closed" }`
- **Update issue**: `PATCH /repos/{owner}/{repo}/issues/{issue_number}` with fields to update

### Issue Model Mapping to TrackerIssue
| GitHub Field | TrackerIssue Field |
|---|---|
| `id` | `id` (string) |
| `number` | `identifier` (e.g., "#42") |
| `title` | `title` |
| `body` | `description` |
| `state` | `state` ("open" / "closed") |
| `labels[].name` | `labels` |
| `assignees[].login` | `assignees` |
| `html_url` | `url` |
| `created_at` | `created_at` |
| `updated_at` | `updated_at` |
| (not native) | `priority` (null or from label convention) |
| (not native) | `blocked_by` (empty array) |

### Important: PRs vs Issues
GitHub's `/issues` endpoint returns both issues AND pull requests. PRs have a `pull_request` key. The adapter should filter out PRs (where `pull_request` is defined) unless explicitly configured to include them.

## 6. Notion API Specifics

### Polling Endpoint
```
POST /v1/databases/{database_id}/query
```
Request body:
```json
{
  "filter": {
    "timestamp": "last_edited_time",
    "last_edited_time": { "after": "2024-01-01T00:00:00Z" }
  },
  "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }],
  "page_size": 100,
  "start_cursor": "..."
}
```

### Pagination
- Response: `{ results: [...], has_more: boolean, next_cursor: string | null }`
- Pass `start_cursor` from previous response to get next page
- Continue until `has_more === false`

### Rate Limiting
- **3 requests per second** per integration token (much stricter than GitHub)
- Returns `429 Too Many Requests` with `Retry-After` header (seconds)
- Implementation: request throttle/queue that ensures max 3 req/s
- Simple approach: track last request timestamp, delay if too soon

### Property Types and Mapping
Notion pages have typed properties. The adapter needs a configurable `property_map` that maps Notion property names to TrackerIssue fields:

| Notion Property Type | TrackerIssue Field | Extraction |
|---|---|---|
| `title` | `title` | `property.title[0].plain_text` |
| `rich_text` | `description` | `property.rich_text[0].plain_text` |
| `select` | `state` / `priority` | `property.select.name` |
| `multi_select` | `labels` | `property.multi_select.map(s => s.name)` |
| `people` | `assignees` | `property.people.map(p => p.name)` |
| `url` | `url` | `property.url` (or construct from page ID) |
| `created_time` | `created_at` | `page.created_time` |
| `last_edited_time` | `updated_at` | `page.last_edited_time` |
| `relation` | `blocked_by` | `property.relation.map(r => r.id)` |

### Page URL Construction
If no URL property exists: `https://notion.so/${page.id.replace(/-/g, "")}`

### Write Operations
- **Update properties**: `PATCH /v1/pages/{page_id}` with `{ properties: { "Status": { select: { name: "Done" } } } }`
- **Add comment**: `POST /v1/comments` with `{ parent: { page_id: "..." }, rich_text: [{ text: { content: "..." } }] }`
- **Archive page**: `PATCH /v1/pages/{page_id}` with `{ archived: true }`

### Authentication
- Header: `Authorization: Bearer ntn_XXX`
- Also requires: `Notion-Version: 2022-06-28` (API version header, required on every request)
- The integration must be connected to the database in Notion's UI

### Getting Page Body/Description
Page properties don't include the page body. To get the full content:
- `GET /v1/blocks/{page_id}/children` returns child blocks
- For a simple description, may just use a designated rich_text property instead of the page body
- The property_map approach is more practical than fetching block children

## 7. Error Handling Patterns

### Current Pattern
The project uses plain `throw new Error(message)` everywhere. No custom error classes. Error messages are descriptive and include context:
```typescript
throw new Error(`Unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
throw new Error(`Board "${boardId}" not found`);
```

### Recommendation for Tracker Adapters
Follow the same pattern: plain `Error` with descriptive messages. Consider a consistent prefix for tracker errors:
```typescript
throw new Error(`Tracker[github]: missing required config field "repo"`);
throw new Error(`Tracker[notion]: rate limited, retry after ${retryAfter}s`);
```

No need to introduce custom error classes unless the orchestrator (Phase 5) needs to programmatically distinguish error types. If needed later, can add `TrackerError` class, but for Phase 1, plain errors suffice.

## 8. TrackerAdapter Interface Design

Based on R1.1, the interface needs three fetch operations plus write-back:

```typescript
interface TrackerAdapter {
  readonly kind: string;

  // Fetch issues eligible for dispatch (active state, matching labels, etc.)
  fetchCandidateIssues(): Promise<TrackerIssue[]>;

  // Fetch current states for specific issue IDs (for reconciliation)
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;

  // Fetch issues in specific states (for startup cleanup)
  fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]>;

  // Write operations
  postComment(issueId: string, body: string): Promise<void>;
  updateState(issueId: string, state: string): Promise<void>;
  updateLabels(issueId: string, add: string[], remove: string[]): Promise<void>;
}
```

### TrackerIssue Model
```typescript
interface TrackerIssue {
  id: string;              // Backend-specific unique ID
  identifier: string;      // Human-readable (e.g., "#42", "PROJ-123")
  title: string;
  description: string;
  state: string;
  priority: string | null;
  labels: string[];
  assignees: string[];
  url: string;
  created_at: string;     // ISO 8601
  updated_at: string;     // ISO 8601
  blocked_by: string[];   // IDs of blocking issues
}
```

## 9. Key Design Decisions for the Planner

### 1. Adapter instantiation pattern
Tracker adapters are **stateful** (unlike agent adapters which are stateless). They hold:
- Config (token, repo/database_id, property_map)
- ETag cache (GitHub)
- Last poll timestamp (both)
- Rate limit state (both)

Use a **factory function** per adapter: `createGitHubAdapter(config) => TrackerAdapter`. The registry maps `kind` string to factory function.

### 2. Token resolution timing
Resolve `$VAR` tokens at adapter creation time (not at schema validation time). Schema validates the string format; adapter resolves and validates the actual value exists.

### 3. Rate limit strategy
- **GitHub**: Read `X-RateLimit-Remaining` header, warn when low, wait when zero. Passive approach.
- **Notion**: Active throttle. Track request timestamps, enforce max 3/s with a simple delay mechanism. Can use a `sleep()` before each request if last request was < 333ms ago.

### 4. Pagination strategy
Both adapters should handle pagination internally, returning complete result sets. Callers should not need to deal with pagination.

### 5. File organization
```
src/tracker/
  types.ts          - TrackerAdapter interface + TrackerIssue model
  github.ts         - GitHub Issues adapter
  notion.ts         - Notion database adapter
  registry.ts       - Factory registry: kind => createAdapter(config)
  token.ts          - $VAR token resolution utility
  rate-limit.ts     - Shared rate limit utilities (optional, could be inline)
```

### 6. Config schema additions
Add to `ConfigSchema` in `src/config/schema.ts`:
```typescript
tracker: z.object({
  kind: z.enum(["github", "notion"]),
  token: z.string(),
  active_states: z.array(z.string()).default(["open"]),
  terminal_states: z.array(z.string()).default(["closed"]),
  poll_interval_ms: z.number().int().positive().default(30000),
  // GitHub-specific
  repo: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // Notion-specific
  database_id: z.string().optional(),
  property_map: z.record(z.string()).optional(),
}).optional()
```

### 7. Test strategy
- Unit tests mock `global.fetch` to simulate API responses
- Each adapter gets its own test file: `test/unit/tracker-github.test.ts`, `test/unit/tracker-notion.test.ts`
- Registry tests in `test/unit/tracker-registry.test.ts`
- Config validation tests can go in existing `test/unit/config.test.ts` or a new file
- No Docker or network access needed for any tests

### 8. No new dependencies needed
- HTTP: native `fetch()` (Node 20+)
- JSON parsing: built-in
- Rate limiting: simple timestamp-based logic
- ETag caching: in-memory Map
- Link header parsing: simple regex or string split

## RESEARCH COMPLETE
