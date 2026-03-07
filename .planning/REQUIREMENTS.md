# Requirements: forgectl v2 — Core Orchestrator

## Milestone Goal
Transform forgectl from a task runner into a continuous autonomous orchestrator that polls issue trackers, dispatches AI agents to isolated workspaces, validates results, and reports back — with zero human intervention after setup.

Working demo: GitHub issue → dispatch agent → validate → report back.

---

## R1: Pluggable Issue Tracker Adapter

### R1.1: Generic Tracker Interface
- Define `TrackerAdapter` interface with operations: `fetchCandidateIssues()`, `fetchIssueStatesByIds()`, `fetchIssuesByStates()`
- Define normalized `TrackerIssue` model: id, identifier, title, description, state, priority, labels, assignees, url, created_at, updated_at, blocked_by
- Tracker adapter returns normalized issues regardless of backend
- Support `$VAR` indirection for API tokens (resolve from environment)
- Adapter validates its own config at startup (missing token, missing project, etc.)

### R1.2: GitHub Issues Adapter
- Poll `GET /repos/{owner}/{repo}/issues` with `state`, `since`, `labels`, `sort` parameters
- Implement conditional requests with ETag caching (304 = free, no rate limit cost)
- Delta polling: track `updated_at` of most recent issue, use `since` for subsequent polls
- Handle pagination via `Link` header (`per_page=100`)
- Map GitHub issue fields to normalized `TrackerIssue` model
- Support label-based filtering for candidate selection (e.g., `forgectl` or `ai-task` label)
- Authenticate via fine-grained PAT (`Authorization: token ghp_XXX`)
- Write back: post comments, add/remove labels, close issues via REST API
- Handle rate limits gracefully: read `X-RateLimit-Remaining`, back off when near zero

### R1.3: Notion Database Adapter
- Poll a Notion database using the Notion API (`POST /v1/databases/{db_id}/query`) with filter and sorts
- Delta polling: filter by `last_edited_time` greater than last poll timestamp
- Handle pagination via `start_cursor` / `has_more` response fields
- Map Notion page properties to normalized `TrackerIssue` model:
  - Title property → `title`
  - Status property → `state` (user-configurable property name)
  - Priority property (select) → `priority`
  - Tags/Labels property (multi-select) → `labels`
  - Assignee property (people) → `assignees`
  - Rich text / description property → `description`
- Support configurable property-to-field mapping (different databases use different property names)
- Authenticate via Notion integration token (`Authorization: Bearer ntn_XXX`)
- Write back: update page properties (status, labels), add comments via `POST /v1/comments`
- Handle rate limits: Notion API allows 3 requests/second per integration; implement request throttling

### R1.4: Tracker Configuration
- Config section in `forgectl.yaml` or WORKFLOW.md front matter: `tracker.kind`, `tracker.token`, `tracker.active_states`, `tracker.terminal_states`
- GitHub-specific: `tracker.repo`, `tracker.labels`
- Notion-specific: `tracker.database_id`, `tracker.property_map` (maps Notion property names to TrackerIssue fields)
- Defaults: `active_states: ["open"]` / `["In Progress", "Todo"]`, `terminal_states: ["closed"]` / `["Done", "Cancelled"]`
- Validate tracker config at startup and per-tick before dispatch

### Acceptance Criteria
- [ ] TrackerAdapter interface defined with all three operations
- [ ] GitHub Issues adapter passes unit tests for: fetch candidates, fetch by IDs, pagination, ETag caching
- [ ] Adapter correctly normalizes GitHub issues to TrackerIssue model
- [ ] Notion adapter passes unit tests for: fetch candidates, pagination, property mapping
- [ ] Notion adapter correctly maps configurable properties to TrackerIssue model
- [ ] Rate limit handling works for both adapters (GitHub: header-based backoff, Notion: request throttling)
- [ ] Can write comments and update state via both adapters
- [ ] Config validation catches missing token/repo/database_id at startup

---

## R2: Orchestration State Machine

### R2.1: Issue Orchestration States
- Implement state machine: Unclaimed → Claimed → Running → Released
- Claimed issues tracked in `claimed` set to prevent duplicate dispatch
- Running issues tracked in `running` map with session metadata
- RetryQueued issues tracked in `retryAttempts` map with timer handles
- Released = claim removed (terminal, non-active, or retry exhausted)

### R2.2: Polling Loop
- Configurable poll interval (default 30s, from config `polling.interval_ms`)
- Per-tick sequence: reconcile → validate config → fetch candidates → sort → dispatch
- Candidate selection: has required fields, state is active, not claimed, not running, slots available
- Dispatch priority: priority ascending (lower = higher), then oldest created_at, then identifier
- Skip dispatch if config validation fails (keep reconciliation running)

### R2.3: Concurrency Control
- Global `maxConcurrentAgents` cap (default 3)
- Per-state concurrency limits via `maxConcurrentAgentsByState` map (optional)
- Slot manager: acquire/release pattern with available count tracking
- When slots exhausted, pending issues wait for next tick

### R2.4: Retry and Backoff
- Normal worker exit → schedule continuation retry (1s delay, attempt=1)
- Abnormal worker exit → exponential backoff: `min(10000 * 2^(attempt-1), maxRetryBackoffMs)`
- Default `maxRetryBackoffMs`: 300000 (5 minutes)
- Retry handler: re-fetch candidates, check if issue still eligible, dispatch or release
- Cancel existing retry timer before scheduling new one for same issue

### R2.5: Reconciliation
- Run every tick before dispatch
- Stall detection: if no activity for `stallTimeoutMs` (default 300s), kill and retry
- State refresh: fetch current states for all running issue IDs
- Terminal state → stop agent + clean workspace
- Active state → update in-memory issue snapshot
- Non-active/non-terminal → stop agent without workspace cleanup
- If state refresh fails, keep workers running, retry next tick

### R2.6: Startup Recovery
- On startup: fetch terminal-state issues, clean their workspaces
- No persistent state restoration — recover purely from tracker polling
- Fresh dispatch of eligible work after startup cleanup

### Acceptance Criteria
- [ ] State machine transitions tested: claim → run → complete, claim → run → fail → retry
- [ ] Polling loop runs at configured interval, stops cleanly on shutdown
- [ ] Concurrency control prevents exceeding maxConcurrentAgents
- [ ] Exponential backoff produces correct delays for attempts 1-5
- [ ] Reconciliation stops agents for terminal issues within one tick
- [ ] Stall detection kills agents with no activity past threshold
- [ ] Startup cleanup removes workspaces for terminal issues

---

## R3: Workspace Management

### R3.1: Workspace Lifecycle
- Workspace root: configurable path (default `~/.forgectl/workspaces/`)
- Per-issue workspace: `<root>/<sanitized-identifier>/` (identifier sanitized to `[A-Za-z0-9._-]`)
- Create workspace directory if it doesn't exist
- Reuse existing workspace for same issue across runs
- Workspaces persist after successful runs (not auto-deleted)

### R3.2: Workspace Hooks
- `after_create`: runs only when workspace is first created (failure = abort)
- `before_run`: runs before each agent attempt (failure = abort attempt)
- `after_run`: runs after each attempt (failure = log and ignore)
- `before_remove`: runs before workspace deletion (failure = log and ignore)
- All hooks: execute with workspace as cwd, timeout configurable (default 60s)

### R3.3: Workspace Safety
- Path must remain under workspace root (no directory traversal)
- Identifier sanitization: replace non-`[A-Za-z0-9._-]` with `_`
- Validate `cwd == workspace_path` before launching agent

### Acceptance Criteria
- [ ] Workspace created with sanitized identifier
- [ ] Existing workspace reused (not recreated)
- [ ] after_create hook runs only on first creation
- [ ] before_run hook failure aborts the attempt
- [ ] Path traversal attempts rejected
- [ ] Workspace cleanup for terminal issues removes directory

---

## R4: WORKFLOW.md Contract

### R4.1: File Format
- Markdown file with optional YAML front matter (delimited by `---`)
- Front matter parsed as config map (tracker, polling, workspace, hooks, agent settings)
- Body = prompt template for issue-to-prompt rendering
- Missing file = error; empty prompt body = minimal default prompt

### R4.2: Prompt Template
- Template variables: `{{issue.title}}`, `{{issue.description}}`, `{{issue.labels}}`, `{{attempt}}`
- Strict rendering: fail on unknown variables
- Attempt: null on first run, integer on retry/continuation

### R4.3: Dynamic Reload
- Watch WORKFLOW.md for changes (fs.watch or polling)
- On change: re-read, re-parse, re-validate, apply new config
- Invalid reload: keep last known good config, emit warning
- Apply to: poll interval, concurrency limits, prompt template, hooks, agent settings
- Do NOT restart in-flight agent sessions

### R4.4: Config Merge
- WORKFLOW.md settings merge with forgectl.yaml and CLI flags
- Priority: CLI flags > WORKFLOW.md > forgectl.yaml > defaults

### Acceptance Criteria
- [ ] WORKFLOW.md parsed: front matter extracted as config, body as prompt template
- [ ] Prompt renders with issue data and attempt number
- [ ] Unknown template variable causes render failure
- [ ] Dynamic reload applies new poll interval without restart
- [ ] Invalid WORKFLOW.md doesn't crash — keeps last good config
- [ ] Config merge priority respected

---

## R5: Hybrid Agent Session Model

### R5.1: Agent Session Interface
- Define `AgentSession` interface: `invoke(prompt, options) → AgentResult`, `isAlive()`, `close()`
- `OneShotSession`: wraps current CLI invocation pattern (Claude Code, basic Codex)
- `AppServerSession`: wraps JSON-RPC subprocess for persistent sessions (Codex app-server)
- `AgentSessionFactory`: creates appropriate session type based on agent + config

### R5.2: One-Shot Sessions (existing, refactored)
- Same behavior as current: write prompt to file, exec in container, collect output
- Used for Claude Code (always) and Codex (when app-server not configured)
- Activity tracking: update `lastActivityAt` on stdout/stderr output

### R5.3: Persistent Sessions (new)
- Spawn Codex app-server as subprocess with JSON-RPC over stdio
- Handshake: initialize → initialized → thread/start → turn/start
- Multi-turn: reuse thread across turns within one worker session
- First turn sends full rendered prompt; continuation turns send guidance only
- Handle approval requests (auto-approve by default)
- Handle user-input-required (fail the turn)
- Track token usage from agent events
- Turn timeout: default 3600s (1 hour)
- Read timeout: default 5s (for handshake)

### R5.4: Session Lifecycle
- Sessions created per dispatch, tied to issue workspace
- One-shot sessions: created and destroyed per invocation
- Persistent sessions: kept alive across turns, closed when worker exits
- Activity heartbeat: update timestamp on any agent event

### Acceptance Criteria
- [ ] AgentSession interface defined with invoke/isAlive/close
- [ ] OneShotSession works for Claude Code (backward compatible)
- [ ] AppServerSession handles JSON-RPC handshake with Codex
- [ ] Multi-turn invocation reuses thread within session
- [ ] Activity tracking updates lastActivityAt for stall detection
- [ ] Session cleanup on worker exit (no zombie processes)

---

## R6: Structured Logging and Observability

### R6.1: Contextual Logging
- All issue-related logs include `issueId` and `issueIdentifier` fields
- All session-related logs include `sessionId` field
- Log: dispatch decisions, state transitions, retry scheduling, reconciliation actions
- Log sink failures don't crash the orchestrator

### R6.2: Runtime Metrics
- Token accounting: input/output/total tokens per issue and aggregate
- Runtime tracking: seconds running per issue and aggregate
- Retry statistics: attempt counts, backoff delays
- Slot utilization: active/available slots

### R6.3: REST API Extensions
- `GET /api/v1/state`: current orchestrator state (running, retrying, totals, rate limits)
- `GET /api/v1/issues/:identifier`: issue-specific runtime details
- `POST /api/v1/refresh`: trigger immediate poll + reconciliation
- Error responses: `{"error": {"code": "...", "message": "..."}}`

### R6.4: Dashboard Updates
- Show orchestrator status: running agents, retry queue, slot utilization
- Show per-issue status: current state, session info, token usage
- Real-time updates via existing SSE infrastructure

### Acceptance Criteria
- [ ] Logs include issueId/issueIdentifier/sessionId fields
- [ ] Token usage tracked per issue and aggregated
- [ ] `/api/v1/state` returns running sessions, retry queue, totals
- [ ] `/api/v1/issues/:id` returns issue-specific details or 404
- [ ] Dashboard shows orchestrator state

---

## R7: End-to-End Demo Flow

### R7.1: Setup
- User configures `forgectl.yaml` with tracker config (GitHub repo, token, labels)
- User creates WORKFLOW.md in their repo with prompt template and agent settings
- User runs `forgectl daemon up` to start the orchestrator

### R7.2: Execution Loop
- Daemon polls GitHub Issues at configured interval
- Finds open issue with matching label (e.g., `forgectl`)
- Claims issue, creates/reuses workspace, runs before_run hook
- Dispatches agent (Claude Code or Codex) with rendered prompt
- Agent works in isolated Docker container with workspace mounted
- Validation runs (if configured): tests, lint, typecheck
- On validation failure: feed errors to agent, retry

### R7.3: Completion
- Agent completes work → commits to branch in workspace
- Daemon posts comment on GitHub issue with results summary
- Optionally: creates PR, adds labels, closes issue
- Runs after_run hook
- Schedules continuation retry to check if more work needed

### R7.4: Error Handling
- Agent failure → exponential backoff retry
- Agent stall → kill and retry
- Issue closed while running → stop agent, clean workspace
- Rate limit hit → back off, retry on next tick

### Acceptance Criteria
- [ ] End-to-end: GitHub issue created → agent dispatched → work done → comment posted
- [ ] Validation loop works within orchestrated runs
- [ ] Retry on failure with backoff
- [ ] Stall detection and recovery
- [ ] Issue state change stops running agent
- [ ] Multiple issues processed concurrently (up to maxConcurrentAgents)

---

## Non-Functional Requirements

### NF1: Backward Compatibility
- `forgectl run` and `forgectl pipeline` commands continue to work unchanged
- Existing `forgectl.yaml` configs remain valid
- New orchestrator features are additive (new commands, new config sections)

### NF2: Testability
- All orchestrator logic unit-testable with mocked tracker/agent/Docker
- Integration tests with mock GitHub API server
- Skip Docker tests with `FORGECTL_SKIP_DOCKER=true`

### NF3: Performance
- Polling loop completes within 5s even with 100 tracked issues
- State machine transitions are synchronous (no async state mutation races)
- Workspace operations handle concurrent access safely

### NF4: Reliability
- Daemon survives tracker API failures (skip tick, try next)
- Daemon survives agent crashes (retry with backoff)
- Invalid config reload doesn't crash (keep last good config)
- Clean shutdown: stop all agents, release all slots, persist no state

---
*Generated: 2026-03-07*
