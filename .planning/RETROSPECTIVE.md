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

## Milestone: v2.0 — Durable Runtime

**Shipped:** 2026-03-12
**Phases:** 10 | **Plans:** 22 | **Tests:** 1,021

### What Was Built
- SQLite persistent storage with Drizzle ORM replacing file-based state
- Append-only flight recorder with event sourcing audit trail and CLI inspect
- Durable execution: crash recovery, checkpoint/resume, pause for human input, execution locks
- Governance system: configurable autonomy levels, approval state machine, auto-approve rules
- GitHub App: webhook receiver, slash commands, check runs, PR descriptions, conversational clarification
- Browser-use integration: Python sidecar adapter for web research workflows
- Gap closure phases (16-19): wired all subsystems into execution lifecycle

### What Worked
- Gap closure pattern from v1.0 scaled well — 4 wiring phases (16-19) cleanly connected 6 new subsystems
- Milestone audit identified all 4 critical integration gaps before declaring done (flight recorder, governance, GitHub, post-gate)
- Backward-compatible optional parameters (DurabilityDeps, GovernanceOpts, GitHubDeps) prevented breaking existing callers
- Small plans averaged ~5min each — even the largest phase (14: GitHub App, 5 plans) completed in 23min total
- Progressive approach: build subsystem → gap closure → verify integration — prevented big-bang integration failures

### What Was Inefficient
- Two audit rounds needed again (initial audit found gaps → 4 gap closure phases → re-audit to confirm)
- ROADMAP.md plan checkboxes still got out of sync (some Phase 12, 13, 15 plans marked `[ ]` in ROADMAP despite being complete on disk)
- Nyquist validation never completed — all 10 phases have VALIDATION.md but none are nyquist_compliant: true
- 6 tech debt items accumulated (dead code, unreachable handlers, review-mode gap) — all non-blocking but should be tracked
- Some SUMMARY.md files lacked one_liner frontmatter, making automated accomplishment extraction fail

### Patterns Established
- Optional dependency injection parameters for backward compatibility (DurabilityDeps, GovernanceOpts, GitHubDeps)
- Pure function state machines (approval follows pause.ts pattern)
- Dynamic imports for optional subsystems (GitHub modules in daemon)
- HTTP sidecar pattern for cross-language agent adapters (TypeScript → Python)
- Error swallowing in non-critical paths (EventRecorder, check runs, PR descriptions)
- AND logic for auto-approve rule evaluation

### Key Lessons
1. Gap closure phases are now a proven pattern — expect them and budget for them when planning milestones with multiple interacting subsystems
2. Backward-compatible optional parameters are the right default for cross-cutting concerns (avoids breaking 20+ existing callers)
3. Two audit rounds is acceptable cost — the first audit shapes gap closure work, the second confirms it
4. ROADMAP.md checkbox tracking is unreliable for completion status — always verify against disk (SUMMARY.md existence)
5. SUMMARY.md frontmatter should include `one_liner` field for milestone completion extraction

### Cost Observations
- Model mix: balanced profile throughout, primarily Opus for planning/execution
- Sessions: ~22 planning + execution sessions across 11 days (including gap closure)
- Notable: gap closure phases (16-19) were extremely efficient — avg 2-5min per plan, minimal rework

---

## Milestone: v2.1 — Autonomous Factory

**Shipped:** 2026-03-14
**Phases:** 5 | **Plans:** 11 | **Tests:** 1,211

### What Was Built
- Conditional pipeline nodes: filtrex expression evaluation, ready-queue executor, cascade skip, else_node branching, dry-run annotations
- Loop pipeline nodes: loop-until iteration, GLOBAL_MAX_ITERATIONS safety cap, per-iteration checkpointing, crash recovery
- Multi-agent delegation: lead agent decomposition, concurrent child dispatch, two-tier slot pool, failure retry, aggregate synthesis
- Self-correction integration: test-fail/fix/retest loops, no-progress detection, exclusion enforcement, coverage-aware termination
- Schema foundation: migration 0005 (delegations table, 5 new runs columns), extended PipelineNode types

### What Worked
- Foundation phase (20) as a dependency-free base unblocked all subsequent phases — all 4 behavioral phases could start immediately after
- filtrex evaluator reuse: condition evaluator from Phase 21 reused directly for loop until expressions in Phase 22 — zero additional code needed
- Gap closure pattern continued from v1.0/v2.0: DELEG-02 wiring gap caught by verifier, fixed in a single 2-line commit (2b94996)
- Standalone module extraction (checkExclusionViolations) solved test coverage gap cleanly — real git repos instead of mocking execSync
- Milestone completed in 2 days (fastest yet) with 11 plans — phases were well-scoped and dependencies clear

### What Was Inefficient
- ROADMAP.md plan checkboxes still out of sync (Phases 22, 23, 24-03 show `[ ]` despite being complete on disk) — persistent issue across all 3 milestones
- Nyquist validation never completed — all 5 phases have VALIDATION.md scaffolds but none are nyquist_compliant:true (same pattern as v1.0 and v2.0)
- SUMMARY.md `requirements-completed` frontmatter only filled in 1 of 11 SUMMARYs (21-02) — automated extraction mostly failed
- Phase 23 VERIFICATION.md documents gaps_found status but gap was fixed post-verification; artifact never updated
- DELEG-02 gap (delegationManager not in this.deps) could have been caught by a type-level check rather than runtime verification

### Patterns Established
- Ready-queue drain loop with inFlight Map + Promise.race for bounded parallelism in DAG execution
- Pipeline state object wrapper to prevent TypeScript literal-type narrowing in async closures
- Crash-safe row-before-dispatch pattern for delegation persistence
- extractCoverage returns -1 sentinel (not null) for safe numeric filtrex comparisons
- Standalone module extraction pattern for testability (inline git/filesystem → standalone module with real repo tests)

### Key Lessons
1. Foundation phases that provide only schema/types are extremely efficient — Phase 20 took 12min and unblocked everything
2. Expression evaluator reuse across features (conditions → loop until) validates the "compose primitives" architecture
3. The ROADMAP checkbox tracking problem is now confirmed across 3 milestones — rely on disk artifacts, never checkboxes
4. Nyquist validation is consistently skipped — consider making it opt-in rather than opt-out
5. VERIFICATION.md artifacts should be re-generated after gap fixes, not left stale

### Cost Observations
- Model mix: balanced profile, primarily Opus for planning/execution, Sonnet for integration checking
- Sessions: ~11 planning + execution sessions across 2 days
- Notable: fastest milestone yet — well-defined phase boundaries and clear dependency graph

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 9 | 24 | Initial milestone — established audit + gap closure pattern |
| v2.0 | 10 | 22 | Scaled gap closure to 4 phases (16-19), backward-compat injection pattern |
| v2.1 | 5 | 11 | Foundation-first architecture, expression evaluator reuse, fastest milestone (2 days) |

### Cumulative Quality

| Milestone | Tests | LOC (src) | LOC (test) |
|-----------|-------|-----------|------------|
| v1.0 | 667 | 11,413 | 12,848 |
| v2.0 | 1,021 | 14,700 | 19,082 |
| v2.1 | 1,211 | 17,026 | 22,248 |

### Top Lessons (Verified Across Milestones)

1. Milestone audits with cross-phase integration checking catch wiring bugs that unit tests miss (confirmed v1.0 + v2.0 + v2.1)
2. Small, focused gap closure phases are more efficient than broad rework (confirmed v1.0 + v2.0 + v2.1)
3. Backward-compatible optional parameters prevent cascading breakage when adding cross-cutting concerns (v2.0)
4. Two audit rounds is the norm, not the exception — budget for it (v1.0 + v2.0)
5. ROADMAP.md checkboxes are unreliable — verify completion against disk artifacts (v1.0 + v2.0 + v2.1)
6. Foundation phases (schema/types only) are extremely efficient and unblock multiple downstream phases simultaneously (v2.1)
7. Composing primitives (condition evaluator reused for loop until) validates architecture better than building monoliths (v2.1)
