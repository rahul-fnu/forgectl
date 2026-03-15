---
phase: 30
slug: fix-subissuecache-singleton-polling-context
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 30 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/wiring-orchestrator-subissuecache.test.ts test/unit/orchestrator-scheduler.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/wiring-orchestrator-subissuecache.test.ts test/unit/orchestrator-scheduler.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 30-01-01 | 01 | 1 | SUBISSUE-03 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/wiring-orchestrator-subissuecache.test.ts` | ✅ extend | ⬜ pending |
| 30-01-02 | 01 | 1 | SUBISSUE-05 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | ✅ extend | ⬜ pending |
| 30-01-03 | 01 | 1 | SUBISSUE-06 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/orchestrator-scheduler.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. New test cases are additive to existing files:
- `test/unit/wiring-orchestrator-subissuecache.test.ts` — add test for shared cache instance between adapter and orchestrator
- `test/unit/orchestrator-scheduler.test.ts` — add test verifying tick() passes githubContext to dispatchIssue

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
