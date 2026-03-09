# Milestones

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

