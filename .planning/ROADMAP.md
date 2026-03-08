# Roadmap: forgectl v2 — Core Orchestrator

## Phase 1: Tracker Adapter Interface + GitHub Issues + Notion
**Goal:** Pluggable issue tracker abstraction with working GitHub Issues and Notion implementations.
**Requirements:** R1.1, R1.2, R1.3, R1.4
**Deliverables:**
- `src/tracker/types.ts` — TrackerAdapter interface + TrackerIssue model
- `src/tracker/github.ts` — GitHub Issues adapter (polling, ETag, pagination, write-back)
- `src/tracker/notion.ts` — Notion database adapter (polling, property mapping, write-back)
- `src/tracker/registry.ts` — Adapter registry (lookup by `tracker.kind`)
- Config schema extensions for tracker settings (shared + per-adapter)
- Unit tests: fetch candidates, pagination, ETag/cursor, normalization, rate limit handling, property mapping

**Depends on:** Nothing (standalone)
**Plans:** 4/4 plans executed (COMPLETE)

Plans:
- [x] 01-01-PLAN.md — TrackerAdapter interface, TrackerIssue model, config schema, token resolution, registry skeleton
- [x] 01-02-PLAN.md — GitHub Issues adapter (polling, ETag, pagination, normalization, write-back)
- [x] 01-03-PLAN.md — Notion database adapter (polling, property mapping, throttle, write-back)
- [x] 01-04-PLAN.md — Registry wiring, barrel export, integration tests

---

## Phase 2: Workspace Management
**Goal:** Per-issue workspace lifecycle with hooks and safety invariants.
**Requirements:** R3.1, R3.2, R3.3
**Deliverables:**
- `src/workspace/manager.ts` — Workspace creation, reuse, cleanup, path validation
- `src/workspace/hooks.ts` — Hook execution with timeout and failure semantics
- `src/workspace/safety.ts` — Path sanitization, root containment checks
- Unit tests: create/reuse/cleanup, hook lifecycle, path safety

**Depends on:** Nothing (standalone)
**Plans:** 2/2 plans complete

Plans:
- [x] 02-01-PLAN.md — Safety module, hook executor, and config schema extension
- [x] 02-02-PLAN.md — WorkspaceManager class, barrel export, full suite verification

---

## Phase 3: WORKFLOW.md Contract
**Goal:** In-repo workflow definition with YAML front matter, prompt templates, and dynamic reload.
**Requirements:** R4.1, R4.2, R4.3, R4.4
**Deliverables:**
- `src/workflow/workflow-file.ts` — WORKFLOW.md parser (front matter + prompt body)
- `src/workflow/watcher.ts` — File watcher with reload + validation
- Template rendering integration with issue data
- Config merge: WORKFLOW.md → forgectl.yaml → defaults
- Unit tests: parsing, template rendering, reload, merge priority

**Depends on:** Phase 1 (needs TrackerIssue model for template variables)
**Plans:** 2/2 plans complete

Plans:
- [ ] 03-01-PLAN.md — WORKFLOW.md parser, front matter schema, strict prompt template renderer
- [ ] 03-02-PLAN.md — File watcher with debounce/reload, config merge chain

---

## Phase 4: Agent Session Abstraction
**Goal:** Unified session interface supporting both one-shot CLI and persistent subprocess modes.
**Requirements:** R5.1, R5.2, R5.3, R5.4
**Deliverables:**
- `src/agent/session.ts` — AgentSession interface + factory
- `src/agent/oneshot-session.ts` — One-shot session (refactored from current adapters)
- `src/agent/appserver-session.ts` — JSON-RPC persistent session for Codex
- Activity tracking (lastActivityAt updates)
- Unit tests: session lifecycle, one-shot backward compat, JSON-RPC protocol

**Depends on:** Nothing (refactors existing agent layer)
**Plans:** 3/3 plans complete

Plans:
- [x] 04-01-PLAN.md — AgentSession interface, OneShotSession, factory, unit tests
- [x] 04-02-PLAN.md — AppServerSession with Codex JSON-RPC protocol
- [ ] 04-03-PLAN.md — Wire sessions into orchestration, barrel export, backward compat

---

## Phase 5: Orchestration State Machine
**Goal:** Full orchestrator with polling, dispatch, concurrency, retry, reconciliation, and stall detection.
**Requirements:** R2.1, R2.2, R2.3, R2.4, R2.5, R2.6
**Deliverables:**
- `src/orchestrator/state.ts` — Orchestrator state types and transitions
- `src/orchestrator/scheduler.ts` — Polling loop with tick sequence
- `src/orchestrator/dispatcher.ts` — Candidate selection, priority sort, slot management
- `src/orchestrator/reconciler.ts` — Active run reconciliation + stall detection
- `src/orchestrator/retry.ts` — Retry queue with exponential backoff
- `src/orchestrator/index.ts` — Orchestrator class tying it all together
- CLI command: `forgectl orchestrate` (start the orchestrator loop)
- Unit tests: state transitions, dispatch priority, concurrency, backoff, reconciliation

**Depends on:** Phase 1, 2, 3, 4 (uses tracker, workspace, workflow, sessions)
**Plans:** 4/4 plans complete

Plans:
- [x] 05-01-PLAN.md — State types, config schema, slot manager, retry/backoff logic
- [x] 05-02-PLAN.md — Worker lifecycle, structured comment builder
- [ ] 05-03-PLAN.md — Dispatcher, reconciler, scheduler (tick loop)
- [ ] 05-04-PLAN.md — Orchestrator class, daemon integration, CLI command, startup recovery

---

## Phase 6: Observability + API Extensions
**Goal:** Structured logging, metrics, REST API, and dashboard updates for orchestrator visibility.
**Requirements:** R6.1, R6.2, R6.3, R6.4
**Deliverables:**
- Logger extensions for issue/session context fields
- Token/runtime metrics aggregation
- REST API routes: `/api/v1/state`, `/api/v1/issues/:id`, `/api/v1/refresh`
- Dashboard updates: orchestrator status panel, per-issue details
- Unit tests: metric aggregation, API response shapes

**Depends on:** Phase 5 (needs orchestrator state to expose)
**Plans:** 3/3 plans complete

Plans:
- [ ] 06-01-PLAN.md — MetricsCollector, Logger enrichment, RunEvent SSE extension, dispatcher wiring
- [ ] 06-02-PLAN.md — REST API routes (/api/v1/state, /issues, /refresh, /events), server wiring
- [ ] 06-03-PLAN.md — Dashboard Orchestrator page with status, slots, issues, metrics, SSE

---

## Phase 7: End-to-End Integration + Demo
**Goal:** Working end-to-end flow: GitHub issue → agent dispatch → validate → report back.
**Requirements:** R7.1, R7.2, R7.3, R7.4, NF1
**Deliverables:**
- Integration wiring: orchestrator → tracker → workspace → agent → validation → output → tracker write-back
- `forgectl orchestrate` command fully functional
- Backward compatibility verification (`forgectl run`, `forgectl pipeline` still work)
- Example WORKFLOW.md for a code review workflow
- E2E test with mock GitHub API
- Demo script / documentation

**Depends on:** Phase 5, 6 (all pieces must be integrated)
**Plans:** 3/3 plans complete

Plans:
- [ ] 07-01-PLAN.md — Worker integration: validation loop, output collection, enriched write-back, front matter schema
- [ ] 07-02-PLAN.md — Backward compatibility tests, example WORKFLOW.md
- [ ] 07-03-PLAN.md — E2E orchestration integration test, full regression verification

---

## Phase 8: Wire Workflow Runtime Integration
**Goal:** Wire WorkflowFileWatcher and mergeWorkflowConfig into the daemon so WORKFLOW.md changes are hot-reloaded and front matter config is merged at startup. Verify integration works with both Claude Code and Codex agent adapters (Codex mocked).
**Requirements:** R4.3, R4.4
**Gap Closure:** Closes gaps from v1.0 audit (2 partial requirements, 2 integration gaps)
**Deliverables:**
- Wire `WorkflowFileWatcher` into daemon startup (`server.ts`) — start watching on daemon up, stop on shutdown
- Wire `mergeWorkflowConfig` into config loading path — apply 4-layer merge (defaults → forgectl.yaml → WORKFLOW.md → CLI flags)
- Pass merged config to orchestrator instead of raw partial extracts
- On reload: re-merge config, update orchestrator settings (poll interval, concurrency, prompt template, hooks)
- Integration tests with Claude Code adapter (real adapter, mocked container)
- Integration tests with Codex adapter (fully mocked — no real Codex CLI calls)
- Unit tests for wiring: watcher lifecycle, config merge at startup, reload propagation

**Depends on:** Phase 3 (workflow components), Phase 5 (daemon/orchestrator)
**Plans:** 2 plans

Plans:
- [x] 08-01-PLAN.md — SlotManager.setMax, Orchestrator.applyConfig, mapFrontMatterToConfig, server.ts wiring, unit tests
- [ ] 08-02-PLAN.md — Integration tests for full reload pipeline with agent adapter scenarios

---

## Phase 9: Fix GitHub Adapter ID/Identifier Mismatch
**Goal:** Fix the cross-phase wiring bug where the orchestrator passes `issue.id` (GitHub internal numeric ID) to tracker methods, but the GitHub adapter expects the `identifier` ("#N" format), causing 404s on all mutation API calls.
**Requirements:** R1.2, R7.3
**Gap Closure:** Closes gaps from v1.0 audit (2 partial requirements, 1 critical integration gap, 1 broken E2E flow)
**Deliverables:**
- Fix GitHub adapter to use issue number as `id` (`id: String(ghIssue.number)`) so orchestrator's `issue.id` matches GitHub API expectations
- Update GitHub adapter unit tests to verify correct ID format throughout
- Add cross-phase integration test: orchestrator → GitHub adapter mutation calls (postComment, updateState, updateLabels)
- Verify E2E flow: GitHub issue → dispatch → agent → comment → auto-close

**Depends on:** Phase 1 (GitHub adapter), Phase 5 (Orchestrator)

---

## Phase Summary

| Phase | Name | Plans | Depends On |
|-------|------|-------|------------|
| 1 | Tracker Adapter Interface | 4/4 | Complete |
| 2 | 2/2 | Complete   | 2026-03-07 |
| 3 | 2/2 | Complete   | 2026-03-08 |
| 4 | 3/3 | Complete   | 2026-03-08 |
| 5 | 4/4 | Complete   | 2026-03-08 |
| 6 | 3/3 | Complete   | 2026-03-08 |
| 7 | 3/3 | Complete   | 2026-03-08 |
| 8 | Wire Workflow Runtime Integration | 2 plans | Pending |
| 9 | Fix GitHub Adapter ID/Identifier Mismatch | 0 plans | Pending |

**Parallelizable:** Phases 1, 2, 4 can run in parallel. Phase 3 needs Phase 1. Phase 5 needs all of 1-4. Phases 6-7 are sequential after 5. Phase 8 is a gap closure phase (depends on 3, 5).

---
*Generated: 2026-03-07*
