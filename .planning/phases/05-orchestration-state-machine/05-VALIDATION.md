---
phase: 5
slug: orchestration-state-machine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 1.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-*.test.ts -x` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-*.test.ts -x`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | R2.1 | unit | `npx vitest run test/unit/orchestrator-state.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | R2.1 | unit | `npx vitest run test/unit/orchestrator-state.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | R2.2 | unit | `npx vitest run test/unit/orchestrator-scheduler.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 1 | R2.2 | unit | `npx vitest run test/unit/orchestrator-scheduler.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 1 | R2.3 | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-03-02 | 03 | 1 | R2.3 | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-04-01 | 04 | 1 | R2.4 | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-04-02 | 04 | 1 | R2.4 | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-04-03 | 04 | 1 | R2.4 | unit | `npx vitest run test/unit/orchestrator-retry.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-05-01 | 05 | 2 | R2.5 | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-05-02 | 05 | 2 | R2.5 | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-05-03 | 05 | 2 | R2.5 | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-06-01 | 06 | 2 | R2.6 | unit | `npx vitest run test/unit/orchestrator-startup.test.ts -x` | ❌ W0 | ⬜ pending |
| 05-06-02 | 06 | 2 | R2.6 | unit | `npx vitest run test/unit/orchestrator-startup.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/orchestrator-state.test.ts` — stubs for R2.1 (state transitions, claim prevention)
- [ ] `test/unit/orchestrator-scheduler.test.ts` — stubs for R2.2 (tick sequence, poll interval)
- [ ] `test/unit/orchestrator-dispatcher.test.ts` — stubs for R2.3 (concurrency cap, slot release)
- [ ] `test/unit/orchestrator-retry.test.ts` — stubs for R2.4 (backoff, continuation, max retries)
- [ ] `test/unit/orchestrator-reconciler.test.ts` — stubs for R2.5 (terminal stop, stall detection, refresh failure)
- [ ] `test/unit/orchestrator-startup.test.ts` — stubs for R2.6 (startup cleanup, fresh dispatch)

*Existing vitest infrastructure covers framework setup.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Graceful shutdown drains in-flight agents | R2.2 | Requires real Docker containers + signal handling | Start orchestrator, dispatch work, send SIGTERM, verify containers stop within 30s |
| CLI `forgectl orchestrate` starts daemon | R2.2 | E2E CLI test | Run `forgectl orchestrate`, verify daemon starts with orchestration |

*All other behaviors have automated unit verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
