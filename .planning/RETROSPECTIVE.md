# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Core Orchestrator

**Shipped:** 2026-03-09
**Phases:** 9 | **Plans:** 24 | **Tests:** 667

### What Was Built
- Pluggable tracker adapter interface with GitHub Issues and Notion implementations
- Full orchestration state machine with polling, dispatch, concurrency, retry, reconciliation
- Hybrid agent session model (one-shot CLI + persistent JSON-RPC subprocess)
- WORKFLOW.md contract with hot-reload and 4-layer config merge
- Per-issue workspace lifecycle with hooks and safety invariants
- REST API + real-time dashboard for orchestrator observability
- End-to-end flow: GitHub issue → agent dispatch → validate → comment → auto-close

### What Worked
- Parallel phase execution for independent subsystems (Phases 1, 2, 4 ran concurrently)
- Small, focused plans (avg 2-4 min execution) kept context tight and errors catchable
- Milestone audit identified real integration gaps (GitHub ID mismatch, config merge wiring) before declaring done
- Gap closure phases (8, 9) were efficient targeted fixes rather than broad rework
- Test-first approach: 667 tests caught regressions early across cross-phase integration

### What Was Inefficient
- ROADMAP.md plan checkboxes got out of sync with actual execution (some plans marked `[ ]` despite being complete)
- Nyquist frontmatter validation was never finalized — all phases have draft/missing status despite tests passing
- Phase SUMMARY.md `requirements_completed` frontmatter missed some requirements (R3.2, R3.3) that were verified by other means
- Two audit rounds needed: first found gaps, second confirmed closure — could have caught earlier with integration testing during phases

### Patterns Established
- Factory registry pattern for stateful adapters (private ETag, cache, rate limit state)
- TrackerIssue.id as API-addressable identifier (issue number, not internal ID)
- 4-layer config merge: defaults → forgectl.yaml → WORKFLOW.md → CLI flags
- Fire-and-forget dispatch with void async for non-blocking worker start
- setTimeout chain (not setInterval) to prevent tick overlap in scheduler
- Closure-based adapter pattern for encapsulating adapter state

### Key Lessons
1. Cross-phase wiring bugs (like GitHub ID/identifier mismatch) are the hardest to catch — milestone audits with E2E flow tracing are essential
2. "Pluggable" is only validated when you have 2+ implementations (Notion validated the TrackerAdapter interface)
3. Gap closure phases should be small and targeted — Phase 9 was 1 plan and fixed a critical bug in minutes
4. Hot-reload integration requires testing the full chain, not just individual components

### Cost Observations
- Model mix: primarily Opus for planning/execution, balanced profile
- Sessions: ~24 planning + execution sessions across 8 days
- Notable: parallel phase execution and small plan granularity kept individual sessions efficient

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 9 | 24 | Initial milestone — established audit + gap closure pattern |

### Cumulative Quality

| Milestone | Tests | LOC (src) | LOC (test) |
|-----------|-------|-----------|------------|
| v1.0 | 667 | 11,413 | 12,848 |

### Top Lessons (Verified Across Milestones)

1. Milestone audits with cross-phase integration checking catch wiring bugs that unit tests miss
2. Small, focused gap closure phases are more efficient than broad rework
