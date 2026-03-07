# Research: forgectl v2 Core Orchestrator

## 1. GitHub Issues API for Polling-Based Orchestration

### Polling Strategy
- **Best endpoint**: `GET /repos/{owner}/{repo}/issues?state=all&since=TIMESTAMP&sort=updated&per_page=100`
- **Conditional requests**: Store ETag from response, send `If-None-Match` header — 304 responses are FREE (don't count against rate limit)
- **Delta polling**: Use `since` parameter with `updated_at` timestamp of most recent issue from last poll
- **Rate limits**: 5,000 requests/hour (authenticated), 900/minute secondary limit
- **Pagination**: `per_page=100` max, follow `Link` header `rel="next"`

### Issue Model Mapping
- States: `open` → `closed` (with `state_reason`: completed, not_planned, reopened)
- No native blocker/dependency fields — use labels or GitHub Projects API
- Key fields: `id`, `number`, `title`, `body`, `state`, `labels[]`, `assignees[]`, `milestone`, `created_at`, `updated_at`
- PRs auto-close issues via keywords in description: "Fixes #42", "Closes #50"

### Authentication
- **Recommended**: Fine-grained PAT with `issues:read`/`issues:write` scopes
- **Future**: GitHub App for multi-repo installations
- Header: `Authorization: token ghp_XXX`

### Webhooks (Optional, Complementary)
- Events: `issues.opened`, `issues.closed`, `issues.reopened`, `issues.labeled`, etc.
- Need public HTTPS endpoint + signature verification
- **Recommendation**: Start with polling, add webhook support later for real-time

## 1b. Notion API for Polling-Based Orchestration

### Polling Strategy
- **Best endpoint**: `POST /v1/databases/{database_id}/query` with filter and sorts
- **Delta polling**: Filter by `last_edited_time` > last poll timestamp using `filter.timestamp.last_edited_time.after`
- **Pagination**: Response includes `has_more` boolean and `next_cursor` string; pass `start_cursor` in subsequent requests
- **Rate limits**: 3 requests/second per integration token — much stricter than GitHub; requires request throttling
- **Page size**: `page_size` parameter, max 100

### Database/Page Model Mapping
- Notion databases have user-defined **properties** (columns) — no fixed schema
- Common patterns: Status (select), Priority (select), Tags (multi-select), Assignee (people), Title (title)
- Property names are user-defined — adapter needs configurable `property_map`
- Page ID = unique identifier, page URL = human-readable link
- Rich text body via `POST /v1/blocks/{block_id}/children` (separate from properties)

### Authentication
- **Integration token**: `Bearer ntn_XXX` (internal integrations)
- Integration must be explicitly connected to the database by the workspace owner
- No OAuth needed for internal use; OAuth available for public integrations

### Writing Back
- Update properties: `PATCH /v1/pages/{page_id}` with properties payload
- Add comments: `POST /v1/comments` with `parent.page_id` and rich text body
- Create pages: `POST /v1/pages` (for creating sub-tasks if needed)

### Key Differences from GitHub
| Aspect | GitHub Issues | Notion |
|--------|--------------|--------|
| Schema | Fixed fields | User-defined properties |
| Rate limit | 5000/hour | 3/second (~10800/hour) |
| Polling | REST GET with ETag | POST query with filters |
| Pagination | Link header | cursor-based |
| States | open/closed | Any select property values |
| Auth | PAT or GitHub App | Integration token |

---

## 2. Agent Session Protocols

### Current forgectl Pattern
- One-shot CLI invocations: `claude -p - --output-format text` and `codex exec --yolo`
- No persistent sessions, no multi-turn within a single execution

### Claude Code Capabilities
- **No app-server mode** — only CLI (`claude -p`) and MCP server (`claude mcp serve`)
- `--max-turns N` controls multi-turn within single invocation
- No `--resume` flag for continuing sessions
- **Best approach**: One-shot with high max-turns, or multiple invocations with workspace persistence

### Codex Capabilities
- **Full app-server mode**: `codex app-server` speaks JSON-RPC 2.0 over stdio
- Bidirectional: client sends requests, server can request approval
- Thread management: persistent threads across turns
- Schema available via `codex app-server generate-json-schema`

### Hybrid Session Abstraction
```typescript
interface AgentSession {
  id: string;
  isAlive(): boolean;
  invoke(prompt: string, options: AgentOptions): Promise<AgentResult>;
  close(): Promise<void>;
}
```
- `OneShotSession`: Wraps current CLI invocation pattern (Claude Code, simple Codex)
- `AppServerSession`: Wraps JSON-RPC subprocess (Codex app-server)
- Factory pattern: `AgentSessionFactory.create(config)` returns appropriate session type

## 3. Orchestration State Machine

### State Model (from Symphony)
```
Unclaimed → Claimed → Running → (success) → Released + continuation retry
                              → (failure) → RetryQueued → Claimed (re-dispatch)
                              → (stall)   → RetryQueued
                              → (terminal) → Released + workspace cleanup
```

### Key Patterns
- **Single authority**: One orchestrator owns all state mutations (no distributed consensus needed for v2)
- **Claim before dispatch**: Prevent duplicate execution with `claimed` set
- **Reconciliation per tick**: Check issue tracker state, stop runs for terminal/inactive issues
- **Exponential backoff**: `delay = min(initialDelay * 2^(attempt-1), maxDelay)` + jitter
- **Continuation retry**: After successful exit, short 1s retry to check if issue still needs work
- **Stall detection**: Track `lastActivityAt` per running session, kill if exceeds threshold

### Concurrency Control
- Global `maxConcurrentAgents` cap
- Per-state caps via `maxConcurrentAgentsByState` map
- Slot manager: acquire/release pattern with wait queue

### Existing forgectl Infrastructure to Reuse
- `RunQueue` in `src/daemon/queue.ts` — needs upgrade from sequential to concurrent + retry
- `PipelineExecutor` already has `Promise.race` for max parallel and repo locking
- `BoardEngine` has concurrent run budget checking
- Fastify daemon with SSE events already running on port 4856

## 4. WORKFLOW.md Contract (from Symphony)

### Format
- Markdown file with optional YAML front matter (delimited by `---`)
- Front matter = config (tracker, polling, workspace, hooks, agent settings)
- Body = prompt template with `{{issue}}` and `{{attempt}}` variables
- Strict template rendering: fail on unknown variables

### Key Innovation
- Repo-owned: teams version-control agent behavior alongside code
- Dynamic reload: watch for changes, hot-apply without restart
- Hooks: `after_create`, `before_run`, `after_run`, `before_remove` (shell scripts with timeouts)

### Adaptation for forgectl
- forgectl already has `forgectl.yaml` config — WORKFLOW.md is complementary (repo-level vs project-level)
- Can support both: `forgectl.yaml` for project defaults, `WORKFLOW.md` for per-repo agent policy
- Template engine: use existing `src/utils/template.ts` (already has `{{var}}` expansion)

---
*Generated: 2026-03-07*
