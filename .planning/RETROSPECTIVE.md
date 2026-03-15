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

## Milestone: v3.0 — E2E GitHub Integration

**Shipped:** 2026-03-14
**Phases:** 6 | **Plans:** 11 | **Tests:** 1,162

### What Was Built
- GitHub sub-issue DAG dependencies: TTL cache, cycle detection, blocked_by enrichment, dependency-aware dispatch
- Skill/config bind-mounting: read-only mounts of CLAUDE.md, skills/, agents/ with credential exclusion and --add-dir injection
- Agent teams: CLAUDE_NUM_TEAMMATES env var, memory scaling (1GB/teammate), weighted slot management, checkpoint bypass
- Sub-issue progress rollup: markdown checklist comments on parent issues with in-place editing and synthesizer-gated auto-close
- Composition wiring: SubIssueCache singleton shared between adapter and orchestrator, githubContext in polling path

### What Worked
- Milestone audit pattern caught 2 critical composition bugs (dual cache, undefined githubContext) that unit tests missed — led to two focused gap-closure phases (29, 30)
- Zero new npm dependencies — all features built on existing Octokit, Dockerode, Zod patterns
- Rapid milestone: 6 phases, 11 plans, 69 commits in 2 days
- Optional injection pattern (from v2.0) scaled cleanly — SubIssueCache and githubContext are optional throughout, Notion adapter unaffected
- Re-verification after gap closure confirmed fixes without regressions

### What Was Inefficient
- Three audit rounds needed (initial → Phase 29 → Phase 30) — each found new integration bugs at the next composition layer
- SUMMARY.md `requirements_completed` frontmatter was incomplete for many plans (10/16 requirements missing from frontmatter despite being satisfied in VERIFICATION.md)
- SUMMARY.md `one_liner` frontmatter missing from all plans — automated accomplishment extraction returned null
- Integration checker found orchestrated-path gaps (team/skills in mapFrontMatterToConfig) that individual phase verifications rated as "passed" — phase verification scope is too narrow for cross-phase config flow
- ROADMAP.md plan checkboxes again out of sync with actual completion

### Patterns Established
- Singleton injection via factory parameter (`createGitHubAdapter(config, externalCache?)`) for shared state
- Live-mutation of deps object (`setGitHubContext` mutates `this.deps.githubContext` in-place) for late-binding configuration
- Marker-based comment upsert (hidden HTML comments for idempotent update-or-create)
- Synthesizer-gated close (label-based workflow: `forge:synthesize` → dispatch → outcome handler)
- `handleSynthesizerOutcome` extraction for testability (pure refactor of inline fire-and-forget logic)

### Key Lessons
1. Composition wiring bugs cascade: fixing the cache singleton revealed the githubContext gap — expect each gap-closure phase to uncover the next layer
2. Phase-level verification is necessary but insufficient — cross-phase integration checking must trace config flow from WORKFLOW.md through mapFrontMatterToConfig to runtime execution
3. The orchestrated (daemon) path and CLI (`forgectl run`) path diverge at `mapFrontMatterToConfig` and `buildOrchestratedRunPlan` — any new WORKFLOW.md config field must be mapped in both
4. Three audit rounds (initial + 2 gap closures) may be the norm for milestones with deep composition wiring — budget accordingly
5. SUMMARY.md frontmatter needs `one_liner` and complete `requirements_completed` fields to support automated milestone completion

### Cost Observations
- Model mix: balanced profile, Opus for planning/verification, Sonnet for execution and integration checking
- Sessions: ~12 sessions across 2 days (including 3 audit rounds and 2 gap closure phases)
- Notable: gap closure phases (29, 30) averaged ~4min execution each — very efficient targeted fixes

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 9 | 24 | Initial milestone — established audit + gap closure pattern |
| v2.0 | 10 | 22 | Scaled gap closure to 4 phases (16-19), backward-compat injection pattern |
| v3.0 | 6 | 11 | 3 audit rounds, 2 gap closure phases (29-30), singleton injection pattern |

### Cumulative Quality

| Milestone | Tests | LOC (src) | LOC (test) |
|-----------|-------|-----------|------------|
| v1.0 | 667 | 11,413 | 12,848 |
| v2.0 | 1,021 | 14,700 | 19,082 |
| v3.0 | 1,162 | 16,662 | 21,299 |

### Top Lessons (Verified Across Milestones)

1. Milestone audits with cross-phase integration checking catch wiring bugs that unit tests miss (confirmed v1.0 + v2.0 + v3.0)
2. Small, focused gap closure phases are more efficient than broad rework (confirmed v1.0 + v2.0 + v3.0)
3. Backward-compatible optional parameters prevent cascading breakage when adding cross-cutting concerns (v2.0 + v3.0)
4. Multiple audit rounds are the norm — v3.0 needed 3 rounds, each uncovering the next composition layer (v1.0 + v2.0 + v3.0)
5. ROADMAP.md checkboxes are unreliable — verify completion against disk artifacts (v1.0 + v2.0 + v3.0)
6. Orchestrated path and CLI path diverge at config mapping — new WORKFLOW.md fields must be wired in both (v3.0)
