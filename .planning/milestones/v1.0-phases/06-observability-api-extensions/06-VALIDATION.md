---
phase: 6
slug: observability-api-extensions
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (latest, via devDependencies) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | R6.2 | unit | `npx vitest run test/unit/metrics.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | R6.1 | unit | `npx vitest run test/unit/observability-logging.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-01-03 | 01 | 1 | R6.1 | unit | `npx vitest run test/unit/observability-logging.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | R6.3 | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 2 | R6.3 | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-02-03 | 02 | 2 | R6.3 | unit | `npx vitest run test/unit/observability-routes.test.ts -x` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 2 | R6.4 | manual-only | N/A | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/metrics.test.ts` — stubs for R6.2 (MetricsCollector tracking, eviction, aggregates, slots)
- [ ] `test/unit/observability-logging.test.ts` — stubs for R6.1 (LogEntry fields, sink safety, RunEvent types)
- [ ] `test/unit/observability-routes.test.ts` — stubs for R6.3 (API response shapes, error envelopes, refresh)

*Existing infrastructure covers framework setup. Only test file stubs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard renders Orchestrator page | R6.4 | UI rendering in single HTML file with CDN React | Start daemon, open `/ui`, verify Orchestrator tab renders status panel, running issues table, retry queue, and "Refresh Now" button |
| SSE real-time updates on dashboard | R6.4 | Requires live SSE connection | Start daemon with orchestrator, dispatch an issue, verify dashboard updates without page refresh |
| Inline issue expand on click | R6.4 | Interactive UI behavior | Click an issue row in the Orchestrator page, verify session details/token usage/attempt history expand inline |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
