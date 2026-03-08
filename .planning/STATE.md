---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 06-03-PLAN.md
last_updated: "2026-03-08T19:08:33.425Z"
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 18
  completed_plans: 18
---

# Project State

## Current Phase
Phase 6 — Observability API Extensions (3/3 plans complete)

## Completed Phases
- Phase 1: Tracker Adapters (4/4 plans, verified)
- Phase 2: Workspace Management (2/2 plans, verified)
- Phase 3: Workflow Contract (2/2 plans, verified)
- Phase 4: Agent Session Abstraction (3/3 plans, verified)
- Phase 5: Orchestration State Machine (4/4 plans, verified)

## Completed Plans
- 01-01: TrackerAdapter interface, TrackerIssue model, config schema, token resolution, registry (2 min)
- 01-02: GitHub Issues adapter with ETag caching, pagination, delta polling, PR filtering, rate limits (2 min)
- 01-03: Notion database adapter with delta polling, property mapping, rich text to markdown, throttle, write-back (2 min)
- 01-04: Registry wiring with GitHub and Notion factories, barrel export, integration tests (2 min)
- 02-01: Safety utilities, hook executor, workspace config schema (2 min)
- 02-02: WorkspaceManager with create/reuse/remove/cleanup lifecycle and hook integration (2 min)
- 03-01: WORKFLOW.md parser with front matter validation and strict template renderer (3 min)
- 03-02: Config merge with four-layer priority and debounced file watcher (2 min)
- 04-01: AgentSession interface with OneShotSession wrapping invokeAgent for unified session abstraction (2 min)
- 04-02: AppServerSession with JSON-RPC over stdio for Codex app-server multi-turn sessions (4 min)
- 04-03: Factory routing codex+appServer to AppServerSession, orchestration migrated to AgentSession, barrel export (3 min)
- 05-01: Orchestrator state types, claim/release transitions, slot manager, retry/backoff, config schema (3 min)
- 05-02: Worker lifecycle with buildOrchestratedRunPlan, executeWorker, and structured comment builder (4 min)
- 05-03: Dispatcher, reconciler, and scheduler for orchestrator runtime with 51 tests (3 min)
- 05-04: Orchestrator integration with startup recovery, graceful shutdown, daemon wiring, CLI command (3 min)
- 06-01: MetricsCollector with per-issue tracking, enriched LogEntry/RunEvent, wired dispatcher metrics (4 min)
- 06-02: Four REST API routes for orchestrator observability with structured error envelopes (6 min)
- 06-03: Orchestrator dashboard page with status banner, slot utilization, running issues, retry queue, metrics, SSE (3 min)

## Key Decisions
- GitHub Issues as first tracker adapter (most accessible)
- Hybrid agent sessions: CLI for Claude Code, app-server for Codex
- Symphony patterns adapted for agent-agnostic orchestration
- Single machine first, distributed later
- Polling-first (webhooks as future enhancement)
- File-based state (no DB), recover from tracker on restart
- Factory registry for tracker adapters (stateful, unlike static agent registry)
- superRefine for kind-specific config validation (github requires repo, notion requires database_id)
- Token resolution supports both $ENV_VAR references and literal values
- Closure-based adapter pattern for private state (ETag, cache, rate limits)
- Priority extraction supports both "priority:X" and "P0/P1" label patterns
- Native fetch for Notion API (no extra HTTP client library)
- Timestamp array throttle for Notion rate limiting (3 req/s)
- Default property_map for common Notion database column names
- Module-level factory registration at import time (function hoisting)
- Barrel export as single entry point for tracker subsystem
- Callback-based execFile for cleaner error field access (killed, code, stderr)
- stat-then-mkdir pattern for workspace creation detection (avoids TOCTOU)
- Non-critical hooks (after_run, before_remove) catch errors and log warnings
- Separate strict renderPromptTemplate instead of modifying existing expandTemplate
- Tracker partial schema without superRefine for override contexts (front matter)
- Arrays in templates serialize as JSON, null values as empty string
- Sequential deepMerge for config layering (simple, correct, readable)
- fs/promises watch() with AbortController for clean cancellation
- Callback-based warning pattern so daemon routes to logger + SSE
- InvokeOptions type for per-call overrides separate from AgentSessionOptions
- Activity callback fires once per invoke, not per line of output
- TokenUsage defaults to zeros for one-shot CLI mode
- Docker modem demuxStream with PassThrough targets for bidirectional exec streams
- Token usage replaces from latest notification rather than accumulating deltas
- Timeout resolves with status timeout rather than rejecting promise
- useAppServer as optional field on AgentSessionOptions for factory routing
- AppServerSession only for codex; claude-code always uses OneShotSession
- Validation loop retains direct invokeAgent internally (separate concern)
- Barrel export (src/agent/index.ts) as single entry point for agent subsystem
- Mutable state object with pure transition functions for orchestrator (not class-based)
- SlotManager takes running Map as parameter rather than holding state reference
- classifyFailure maps completed to continuation, all others to error
- Empty tempDirs in CleanupContext to preserve workspace while destroying container
- CommitConfig field mapping (include_task -> includeTask) inline in buildOrchestratedRunPlan
- Before hook failure returns immediate failure result without agent invocation
- Priority extraction re-implemented locally in dispatcher (not coupled to github adapter)
- Fire-and-forget dispatch pattern with void async for non-blocking worker start
- Separate reconciliation and stall detection loops with per-worker error isolation
- setTimeout chain (not setInterval) prevents tick overlap in scheduler
- Orchestrator constructor takes deps, start() creates fresh state (enables clean restart)
- Startup recovery is non-fatal: logs warning and continues if tracker fetch fails
- Drain uses Promise.race against drain_timeout_ms, then force-kills remaining
- Label removal on shutdown uses Promise.allSettled to tolerate individual failures
- startDaemon accepts enableOrchestrator parameter for CLI command to force-enable
- MetricsCollector uses bounded buffer (default 100) with shift eviction for completed entries
- Logger listener errors swallowed silently via try/catch to prevent orchestrator crashes
- Tick lock guard on Orchestrator prevents concurrent tick execution from API refresh
- Completion status mapped from classifyFailure: continuation->completed, error->failed
- getSlotUtilization() on Orchestrator delegates to internal slotManager (avoids exposing private field)
- Retry queue derived from retryAttempts entries not in running map (no separate data structure)
- Observability routes use /api/v1/ prefix to namespace from existing routes
- All orchestrator error responses use { error: { code, message } } envelope (503 NOT_CONFIGURED)
- SSE events trigger state re-fetch with 1-second throttle to prevent flood
- 503 from /api/v1/state shows Orchestrator not configured instead of error
- Inline row expansion pattern for detail views in dashboard tables

## Blockers
(none)

## Last Session
- **Stopped at:** Completed 06-03-PLAN.md
- **Timestamp:** 2026-03-08T19:30:00Z
