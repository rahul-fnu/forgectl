# Phase 5: Orchestration State Machine - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Full orchestrator with polling, dispatch, concurrency, retry, reconciliation, and stall detection. This is the brain that ties tracker (Phase 1), workspace (Phase 2), workflow (Phase 3), and agent sessions (Phase 4) together into a continuous autonomous loop. The orchestrator runs inside the existing daemon. Observability/API extensions are Phase 6; end-to-end integration is Phase 7.

</domain>

<decisions>
## Implementation Decisions

### Dispatch & priority
- Label-based priority: parse priority from labels (P0/P1/P2 or priority:high/medium/low). Lower number = higher priority, then oldest created_at as tie-breaker. Reuses Phase 1's existing label priority extraction
- Respect `blocked_by` dependencies: if issue A has blocked_by: [B] and B is not in a terminal state, skip A during candidate selection
- Global concurrency cap only (default maxConcurrentAgents: 3). No per-state limits — keep slot management simple
- Dual claiming: in-memory Set for speed + best-effort label update in tracker (add in_progress_label on dispatch, remove on release). Label failure doesn't block dispatch

### Worker lifecycle
- Docker container per run: reuse existing prepareExecution() flow from single.ts. Each dispatch creates a Docker container with the persistent workspace mounted. Container destroyed after the run
- Validation is optional, from WORKFLOW.md: if validation steps configured, run them (like v1). If none configured, skip. Claude's discretion on exact integration
- Structured comment write-back: post markdown comment with status (pass/fail), validation results, duration, token usage, branch/PR link if git output. Matches Phase 1's structured summary comment decision
- Continuation retry after success: schedule a 1s continuation retry after successful completion. Re-fetch issue — if still in active state, dispatch again (agent picks up where it left off in persistent workspace)

### Retry & failure modes
- Three-tier failure classification:
  1. Normal exit (agent completed, issue still active) → continuation retry (1s delay)
  2. Agent error (non-zero exit, crash) → exponential backoff retry
  3. Stall (no activity past threshold) → kill + exponential backoff retry
- Configurable max retries: default max_retries: 5. After exhausting retries, release the issue, remove in-progress label, post failure comment. Issue stays open for human review
- Stall timeout: 10 minutes (600s) default. If no activity callback fires for 600s, agent is presumed stalled
- Exponential backoff: `min(10000 * 2^(attempt-1), maxRetryBackoffMs)` with default maxRetryBackoffMs: 300000 (5 min)
- Preserve workspace across all retry types: agent picks up existing work. before_run hook can reset if needed. Matches Phase 2's reuse decision

### CLI command & shutdown
- Daemon mode: orchestrator runs inside the existing Fastify daemon (port 4856). Shares SSE, REST API, dashboard infrastructure
- Config-driven auto-start: if `orchestrator.enabled: true` AND tracker config is present, orchestrator starts with the daemon. Otherwise daemon runs without orchestration (backward compat)
- `forgectl orchestrate` convenience command: starts daemon with orchestration enabled. Equivalent to `forgectl daemon up` with orchestrator.enabled flag
- Graceful shutdown with drain: stop polling, wait up to 30s for in-flight agents to finish, then force-kill remaining. Release all claims, remove in-progress labels. Clean exit

### Reconciliation (from R2.5)
- Run every tick before dispatch
- Fetch current states for all running issue IDs via fetchIssueStatesByIds()
- Terminal state → stop agent + clean workspace via WorkspaceManager.remove()
- Non-active/non-terminal → stop agent without workspace cleanup
- Active state → update in-memory issue snapshot
- If state refresh fails, keep workers running, retry next tick

### Startup recovery (from R2.6)
- On startup: fetch terminal-state issues via fetchIssuesByStates(), clean their workspaces
- No persistent state restoration — recover purely from tracker polling
- Fresh dispatch of eligible work after startup cleanup

### Claude's Discretion
- Internal state machine representation (enum vs string union, Map structure)
- Tick sequence implementation (setInterval vs setTimeout chain)
- How prepareExecution() is adapted for orchestrated runs vs v1 single runs
- Slot manager internal design
- Retry timer management (setTimeout handles, cancellation)
- Config schema for orchestrator section (field names, defaults)
- How workspace is bind-mounted into the Docker container (integrate WorkspaceManager path with prepareExecution's bind logic)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/orchestration/single.ts`: prepareExecution() — shared prepare phase (image, workspace, creds, network, container). Worker can reuse this with workspace path swapped to WorkspaceManager's path
- `src/orchestration/single.ts`: executeSingleAgent() — full execute flow (prepare → agent → validate → output). Reference implementation for worker
- `src/orchestration/modes.ts`: executeRun() dispatcher — pattern for mode-based routing
- `src/agent/session.ts`: AgentSession interface with invoke/isAlive/close + onActivity callback — used for stall detection
- `src/tracker/types.ts`: TrackerAdapter with fetchCandidateIssues(), fetchIssueStatesByIds(), postComment(), updateLabels()
- `src/workspace/manager.ts`: WorkspaceManager with create/reuse/remove/cleanup lifecycle
- `src/workflow/workflow-file.ts`: WORKFLOW.md parser for config + prompt template
- `src/daemon/server.ts`: Existing Fastify server — orchestrator integrates here
- `src/logging/events.ts`: emitRunEvent() for SSE event streaming

### Established Patterns
- Closure-based adapter pattern for private state (Phase 1)
- Callback-based activity tracking (Phase 4)
- Zod schemas with .default() for config sections
- Timer utility for duration tracking
- CleanupContext pattern for resource management

### Integration Points
- `src/daemon/server.ts` — start orchestrator when daemon starts (if config enabled)
- `src/config/schema.ts` — add orchestrator section (enabled, maxConcurrentAgents, stallTimeoutMs, maxRetries, etc.)
- `src/cli/index.ts` — add `forgectl orchestrate` command
- `src/orchestration/single.ts` — worker reuses prepareExecution() with modified workspace binding
- TrackerAdapter — orchestrator calls fetchCandidateIssues(), fetchIssueStatesByIds(), postComment(), updateLabels()
- WorkspaceManager — orchestrator calls create(), remove(), cleanupTerminal()
- WORKFLOW.md — orchestrator reads config for poll interval, concurrency, prompt template

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-orchestration-state-machine*
*Context gathered: 2026-03-08*
