---
phase: 25
slug: sub-issue-dag-dependencies
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (latest, see package.json) |
| **Config file** | none — vitest defaults or package.json `test` script |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/tracker-github.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts test/unit/orchestrator-scheduler.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 25-01-01 | 01 | 0 | SUBISSUE-01 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-cache.test.ts` | ❌ W0 | ⬜ pending |
| 25-01-02 | 01 | 0 | SUBISSUE-04 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-dag.test.ts` | ❌ W0 | ⬜ pending |
| 25-02-01 | 02 | 1 | SUBISSUE-01 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts` | ✅ extend | ⬜ pending |
| 25-02-02 | 02 | 1 | SUBISSUE-02 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-github.test.ts` | ✅ extend | ⬜ pending |
| 25-03-01 | 03 | 2 | SUBISSUE-03 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | ✅ extend | ⬜ pending |
| 25-04-01 | 04 | 2 | SUBISSUE-04 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/tracker-sub-issue-dag.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/tracker-sub-issue-cache.test.ts` — stubs for SUBISSUE-01 cache TTL behavior, invalidation, graceful degradation
- [ ] `test/unit/tracker-sub-issue-dag.test.ts` — stubs for SUBISSUE-04 cycle detection, comment posting, skip-dispatch behavior

*Existing test files `tracker-github.test.ts` and `orchestrator-scheduler.test.ts` can be extended in-place for SUBISSUE-01/02/03 cases.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
