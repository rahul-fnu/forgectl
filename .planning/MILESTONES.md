# Milestones

## v2.0 Durable Runtime (Shipped: 2026-03-12)

**Phases completed:** 10 phases, 22 plans
**Git range:** f33372d..412a780
**LOC:** 14,700 src + 19,082 test (TypeScript)
**Timeline:** 11 days (2026-03-01 → 2026-03-12)
**Tests:** 1,021 passing across 91 test files

**Key accomplishments:**
1. SQLite persistent storage with Drizzle ORM, auto-migrations, and typed repository pattern
2. Append-only flight recorder with event sourcing audit trail, state snapshots, and CLI inspect command
3. Durable execution: crash recovery, checkpoint/resume, pause for human input, atomic execution locks
4. Governance system: configurable autonomy levels (full/semi/interactive/supervised), approval state machine, auto-approve rules
5. GitHub App: webhook receiver with HMAC verification, slash commands, check runs, PR descriptions, conversational clarification
6. Browser-use integration: Python sidecar adapter for web research workflows
7. Gap closure phases (16-19): wired flight recorder, governance gates, GitHub utilities, and post-gate into execution lifecycle

**Tech debt:**
- EventRecorder.captureSnapshot() is dead code (snapshots via direct insert in checkpoint.ts)
- handleReactionEvent implemented but not registerable (GitHub platform limitation)
- buildClarificationComment exported but not called in production (future-ready)
- headSha never populated in dispatcher GitHubDeps (graceful no-op for issue-only webhooks)
- TODO in webhooks.ts for future reaction webhook support
- executeReviewMode does not receive DurabilityDeps (review-mode runs skip checkpoints)

**Archive:** [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md) | [milestones/v2.0-REQUIREMENTS.md](milestones/v2.0-REQUIREMENTS.md)

---

## v1.0 Core Orchestrator (Shipped: 2026-03-09)

**Phases completed:** 9 phases, 24 plans
**Git range:** f09ba34..84a1a70
**LOC:** 11,413 src + 12,848 test (TypeScript)
**Timeline:** 8 days (2026-03-01 → 2026-03-09)
**Tests:** 667 passing across 56 test files

**Key accomplishments:**
1. Pluggable tracker adapter interface with GitHub Issues and Notion implementations (polling, ETag caching, delta polling, write-back)
2. Per-issue workspace lifecycle management with hooks and path safety
3. WORKFLOW.md contract with YAML front matter, strict prompt templates, and hot-reload
4. Hybrid agent session model (one-shot CLI + persistent JSON-RPC subprocess)
5. Full orchestration state machine with polling, dispatch, concurrency, retry, reconciliation, and stall detection
6. Observability layer with REST API, metrics collector, enriched logging, and real-time dashboard
7. End-to-end flow: GitHub issue → agent dispatch → validate → comment → auto-close

**Tech debt:**
- Duplicated types in appserver-session.ts (structural compatibility)
- Empty `.catch(() => {})` for best-effort ops (intentional)
- Dashboard visual layout requires human verification
- Nyquist frontmatter not updated after execution (doc gap only)

**Archive:** [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) | [milestones/v1.0-REQUIREMENTS.md](milestones/v1.0-REQUIREMENTS.md)

---

