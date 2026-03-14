---
phase: 29
slug: wire-subissuecache-composition
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 29 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 29-01-01 | 01 | 1 | SUBISSUE-03, SUBISSUE-04 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` | ❌ W0 | ⬜ pending |
| 29-01-02 | 01 | 1 | SUBISSUE-05, SUBISSUE-06 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` | ❌ W0 | ⬜ pending |
| 29-01-03 | 01 | 1 | SUBISSUE-05 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- --run test/unit/wiring-orchestrator-subissuecache.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/wiring-orchestrator-subissuecache.test.ts` — composition tests covering SUBISSUE-03/04/05/06 wiring through `Orchestrator` class

*Existing tests in orchestrator-scheduler.test.ts and wiring-sub-issue-rollup.test.ts cover the logic; Wave 0 covers the composition wiring.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
